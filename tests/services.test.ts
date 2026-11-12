import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppState } from '../src/main/app-state';
import { callModel } from '../src/main/providers';
import { listModels, probeService } from '../src/main/service-probes';
import { defaultSettings } from '../src/shared/studio';
import {
  cloudService,
  defaultServiceSettings,
  normalizeEndpoint,
  migrateSettings,
  resolveChoice,
  routeFor,
  assertRouteAuthorization,
  type Service,
  type ServiceSettings,
} from '../src/shared/services';
const signal = () => new AbortController().signal;
function config(s: Service): ServiceSettings {
  return {
    ...structuredClone(defaultServiceSettings),
    services: [s],
    bindings: {
      ...structuredClone(defaultServiceSettings.bindings),
      planner: { serviceId: s.id, model: 'test' },
      worker: { serviceId: s.id, model: 'test' },
      vision: { serviceId: s.id, model: 'vision' },
    },
  };
}
async function server(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  return {
    s,
    service: {
      id: 'local',
      name: 'Test local',
      kind: 'local',
      provider: 'compatible',
      protocol: 'openai',
      baseURL: `http://127.0.0.1:${port}/v1`,
      auth: 'none',
      timeoutSeconds: 5,
    } as Service,
    close: async () => {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
const text = { instruction: 'test', text: 'hello' };
const reply = { choices: [{ message: { content: 'OK' } }] };
test('地址限制：精确回环、IPv6、localhost 规范化、云端 HTTPS', () => {
  assert.equal(normalizeEndpoint('http://localhost:1234/v1/', 'local'), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeEndpoint('http://[::1]:8080/v1', 'local'), 'http://[::1]:8080/v1');
  for (const address of [
    'http://127.1/v1',
    'http://2130706433/v1',
    'http://192.168.1.2/v1',
    'http://localhost.evil.com/v1',
    'http://key@localhost/v1',
    'http://localhost/v1?',
    'http://localhost/v1#x',
    'file:///tmp/a',
    'http://localhost/v1/chat/completions',
  ])
    assert.throws(() => normalizeEndpoint(address, 'local'), address);
  for (const address of [
    'http://example.com/v1',
    'https://127.0.0.1/v1',
    'https://192.168.1.2/v1',
    'https://key@example.com/v1',
  ])
    assert.throws(() => normalizeEndpoint(address, 'cloud'));
});
test('实际 HTTP：无认证、独立 Bearer、模型列表、视觉图片、串行推理', async () => {
  const received: { auth?: string; url?: string; body: any }[] = [];
  let active = 0,
    peak = 0;
  const fixture = await server(async (req, res) => {
    active++;
    peak = Math.max(peak, active);
    let raw = '';
    for await (const b of req) raw += b;
    received.push({
      auth: req.headers.authorization,
      url: req.url,
      body: raw ? JSON.parse(raw) : null,
    });
    await new Promise((r) => setTimeout(r, 25));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'test' }] } : reply));
    active--;
  });
  try {
    const c = config(fixture.service);
    assert.deepEqual(await listModels(fixture.service, 'should-not-send', signal()), ['test']);
    await Promise.all([
      callModel(resolveChoice(c, 'planner'), 'cloud-key-must-not-leak', text, signal()),
      probeService(c, 'local', 'vision', 'vision', '', signal()),
    ]);
    assert.equal(peak, 1);
    assert.ok(received.every((r) => !r.auth));
    assert.match(JSON.stringify(received[2].body), /data:image\/jpeg;base64/);
    assert.equal(
      (
        await callModel(
          { ...resolveChoice(c, 'planner'), auth: 'bearer' },
          'local-token',
          text,
          signal(),
        )
      ).usageReported,
      false,
    );
    assert.equal(received.at(-1)?.auth, 'Bearer local-token');
    assert.equal(routeFor(c, 'roughcut', true).requiresCloudConsent, false);
    const cloud = cloudService('openai');
    c.services.push(cloud);
    c.bindings.planner = { serviceId: cloud.id, model: 'text' };
    const route = routeFor(c, 'roughcut', true);
    assert.equal(route.requiresCloudConsent, true);
    assert.deepEqual(
      route.destinations.filter((d) => d.kind === 'cloud').map((d) => d.serviceId),
      ['openai'],
    );
  } finally {
    await fixture.close();
  }
});
test('HTTP 错误不重试或回退，重定向、超时、取消及未实现模型列表', async () => {
  let requests = 0,
    mode = 'error';
  const fixture = await server((req, res) => {
    requests++;
    if (mode === 'hang') return;
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    } else {
      res.writeHead(503);
      res.end();
    }
  });
  try {
    const c = resolveChoice(config(fixture.service), 'planner');
    await assert.rejects(callModel(c, '', text, signal()), /503/);
    assert.equal(requests, 1);
    await assert.rejects(listModels(fixture.service, '', signal()), /手动/);
    mode = 'redirect';
    const n = requests;
    await assert.rejects(callModel(c, '', text, signal()), /连接/);
    assert.equal(requests, n + 1);
    mode = 'hang';
    await assert.rejects(callModel({ ...c, timeoutSeconds: 0.05 }, '', text, signal()), /超时/);
    const a = new AbortController();
    const running = callModel(c, '', text, a.signal);
    await new Promise((r) => setTimeout(r, 20));
    const b = new AbortController();
    const queued = callModel(c, '', text, b.signal);
    const before = requests;
    b.abort();
    await assert.rejects(queued);
    a.abort();
    await assert.rejects(running);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(requests, before);
  } finally {
    await fixture.close();
  }
});
const crypto = {
  available: () => true,
  encrypt: (v: string) => Buffer.from('cipher:' + v),
  decrypt: (b: Buffer) => b.toString().slice(7),
};
test('v1 备份与迁移：主题、项目、统计、不同地域服务和所有旧凭据', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-migrate-'));
  try {
    const settings = {
      ...structuredClone(defaultSettings),
      theme: 'purple',
      planner: { provider: 'bailian', model: 'cn', region: 'cn', vision: false },
      worker: { provider: 'bailian', model: 'intl', region: 'intl', vision: false },
      vision: { provider: 'bailian', model: 'cn-vision', region: 'cn', vision: true },
      speech: 'local',
    };
    const old = {
      version: 1,
      settings,
      keys: {
        bailian: crypto.encrypt('key').toString('base64'),
        openai: crypto.encrypt('unused').toString('base64'),
      },
      projects: [{ id: 'project', name: '保留', file: '/missing', assets: [] }],
      exports: { '2026-11-12': 3 },
    };
    const raw = JSON.stringify(old);
    await fs.writeFile(path.join(root, 'studio.json'), raw);
    const app = new AppState(root, crypto);
    await app.init();
    const view = app.view();
    assert.equal(view.settings.theme, 'purple');
    assert.equal(view.settings.bindings.speech.serviceId, null);
    assert.equal(view.settings.services.length, 3);
    assert.equal(view.settings.bindings.planner.serviceId, view.settings.bindings.vision.serviceId);
    assert.notEqual(
      view.settings.bindings.worker.serviceId,
      view.settings.bindings.planner.serviceId,
    );
    for (const s of view.settings.services)
      assert.equal(app.key(s.id), s.provider === 'openai' ? 'unused' : 'key');
    assert.equal(
      await fs.readFile(
        path.join(
          root,
          (await fs.readdir(root)).find((n) => n.startsWith('studio-v1-backup'))!,
        ),
        'utf8',
      ),
      raw,
    );
    const written = JSON.parse(await fs.readFile(path.join(root, 'studio.json'), 'utf8'));
    assert.deepEqual(written.projects, old.projects);
    assert.deepEqual(written.exports, old.exports);
    assert.equal(written.version, 2);
    const reopened = new AppState(root, crypto);
    await reopened.init();
    assert.deepEqual(reopened.view(), view);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('服务独立凭据、端点修改清除、禁止删除绑定及并发统计保存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-config-'));
  try {
    const app = new AppState(root, crypto);
    await app.init();
    const a = cloudService('compatible', 'a'),
      b = cloudService('compatible', 'b');
    a.baseURL = 'https://first.example/v1';
    b.baseURL = 'https://second.example/v1';
    await app.update({ ...config(a), services: [a, b] });
    await app.setKey('a', 'first-key');
    await app.setKey('b', 'second-key');
    const old = app.view().settings;
    await assert.rejects(
      app.update({
        ...old,
        services: [b],
        bindings: structuredClone(defaultServiceSettings.bindings),
      }),
      /解除绑定/,
    );
    await Promise.all([
      app.update({ ...old, services: [{ ...a, baseURL: 'https://changed.example/v1' }, b] }),
      app.exported(),
      app.exported(),
    ]);
    assert.equal(app.key('a'), '');
    assert.equal(app.key('b'), 'second-key');
    assert.equal((await app.dashboard()).exportsToday, 2);
    await assert.rejects(app.update(old), /已变化/);
    const reloaded = new AppState(root, crypto);
    await reloaded.init();
    assert.equal((await reloaded.dashboard()).exportsToday, 2);
    assert.equal(reloaded.key('b'), 'second-key');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('损坏文件及写入失败保留原始设置，内存凭据不落盘', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-failure-'));
  try {
    const file = path.join(root, 'studio.json');
    await fs.writeFile(file, 'broken');
    await assert.rejects(new AppState(root, crypto).init());
    assert.equal(await fs.readFile(file, 'utf8'), 'broken');
    await fs.unlink(file);
    const app = new AppState(root, { ...crypto, available: () => false });
    await app.init();
    await app.update(config(cloudService('openai')));
    await app.setKey('openai', 'ephemeral');
    assert.equal(app.key('openai'), 'ephemeral');
    assert.ok(!(await fs.readFile(file, 'utf8')).includes('ephemeral'));
    const old = app.view();
    await fs.rename(file, file + '.saved');
    await fs.mkdir(file);
    await assert.rejects(app.update({ ...old.settings, theme: 'light' }));
    assert.deepEqual(app.view(), old);
    assert.equal(
      JSON.parse(await fs.readFile(file + '.saved', 'utf8')).settings.theme,
      old.settings.theme,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('不同本地端口使用独立凭据，共用串行队列', async () => {
  const headers: string[] = [];
  const handler =
    (expected: string): http.RequestListener =>
    (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${expected}`);
      headers.push(expected);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    };
  const a = await server(handler('first')),
    b = await server(handler('second'));
  try {
    await Promise.all([
      callModel(
        { ...resolveChoice(config(a.service), 'planner'), auth: 'bearer' },
        'first',
        text,
        signal(),
      ),
      callModel(
        { ...resolveChoice(config(b.service), 'planner'), auth: 'bearer' },
        'second',
        text,
        signal(),
      ),
    ]);
    assert.deepEqual(headers, ['first', 'second']);
  } finally {
    await a.close();
    await b.close();
  }
});
test('迁移写入中断：原文件和原始备份不变，后续可重新迁移', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-migrate-fail-')),
    file = path.join(root, 'studio.json');
  const raw = JSON.stringify({
    version: 1,
    settings: defaultSettings,
    keys: {},
    projects: [],
    exports: {},
  });
  const rename = fs.rename;
  try {
    await fs.writeFile(file, raw);
    fs.rename = async (from, to) => {
      if (to === file)
        throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    await assert.rejects(new AppState(root, crypto).init(), /设置/);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    const backup = (await fs.readdir(root)).find((n) => n.startsWith('studio-v1-backup'))!;
    assert.equal(await fs.readFile(path.join(root, backup), 'utf8'), raw);
    fs.rename = rename;
    await new AppState(root, crypto).init();
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
  } finally {
    fs.rename = rename;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('授权绑定配置修订：纯本地可无云端勾选，混合任务必须重新授权', () => {
  const cloud = cloudService('openai'),
    c = config(cloud);
  c.revision = 4;
  const route = routeFor(c, 'roughcut', true);
  assert.throws(
    () => assertRouteAuthorization(route, { routeRevision: 3, cloudConsent: true }),
    /配置已变化/,
  );
  assert.throws(
    () => assertRouteAuthorization(route, { routeRevision: 4, cloudConsent: false }),
    /允许上传/,
  );
  assert.doesNotThrow(() =>
    assertRouteAuthorization(route, { routeRevision: 4, cloudConsent: true }),
  );
  assert.doesNotThrow(() =>
    assertRouteAuthorization(
      { ...route, requiresCloudConsent: false },
      { routeRevision: 4, cloudConsent: false },
    ),
  );
});

test('迁移自定义端点及 Cloudflare 账户，不向新增地址分配孤立密钥', () => {
  const settings = {
    ...structuredClone(defaultSettings),
    planner: {
      provider: 'compatible',
      model: 'plan',
      vision: false,
      baseURL: 'https://first.example/v1',
    },
    worker: { provider: 'cloudflare', model: 'work', vision: false, accountId: 'a'.repeat(32) },
    vision: {
      provider: 'compatible',
      model: 'see',
      vision: true,
      baseURL: 'https://second.example/v1',
    },
  };
  const migrated = migrateSettings(settings, {
    compatible: 'cipher-custom',
    cloudflare: 'cipher-cf',
  });
  assert.equal(migrated.settings.services.length, 3);
  assert.deepEqual(
    migrated.settings.services.map((s) => s.baseURL),
    [
      'https://first.example/v1',
      `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`,
      'https://second.example/v1',
    ],
  );
  assert.equal(migrated.keys[migrated.settings.bindings.vision.serviceId!], 'cipher-custom');
  const orphan = migrateSettings(defaultSettings, { compatible: 'orphan-cipher' });
  assert.equal(orphan.keys.compatible, 'orphan-cipher');
  assert.ok(!orphan.settings.services.some((s) => s.provider === 'compatible'));
});
