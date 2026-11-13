import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { RuntimeBuilder, runBuildProcess, type BuildInvocation } from '../src/main/runtime-builder';
import { NativeTools } from '../src/main/native-tools';
import { NativeModels } from '../src/main/native-models';
import { installedRuntime } from '../src/main/runtime-location';
import { defaultServiceSettings } from '../src/shared/services';
import sources from '../resources/native/sources.json';
const requirements = async () => ({
  ready: true,
  platform: `${process.platform}-${process.arch}`,
  cmake: 'controlled-fixture',
  tools: [],
});
async function fixtureBuild(input: BuildInvocation) {
  const get = (flag: string) => input.args[input.args.indexOf(flag) + 1],
    engine = get('--engine') as keyof typeof sources,
    backend = get('--backend');
  const dir = path.join(
    get('--output-root'),
    `${process.platform}-${process.arch}`,
    engine,
    backend,
  );
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
  await fs.mkdir(path.join(dir, 'licenses'));
  const content = '#!/bin/sh\nexit 0\n';
  await fs.writeFile(path.join(dir, 'bin', sources[engine].binary), content, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'licenses', 'LICENSE'), 'fixture');
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      commit: sources[engine].commit,
      platform: `${process.platform}-${process.arch}`,
      backend,
      files: [
        {
          path: 'bin/' + sources[engine].binary,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
        { path: 'licenses/LICENSE', sha256: createHash('sha256').update('fixture').digest('hex') },
      ],
    }),
  );
  input.onLine('CUTCUT_BUILD_STAGE ' + JSON.stringify({ message: '已完成受控编译' }));
}
test('应用内编译：三引擎安装到用户目录、即时识别；失败和取消保留旧版本', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-runtime-install-'));
  try {
    let mode = 'success';
    const builder = new RuntimeBuilder(
      path.join(root, 'tools'),
      path.resolve('resources'),
      async (input) => {
        if (mode === 'fail') throw new Error('fixture compile failure');
        if (mode === 'cancel') {
          await new Promise<void>((_, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
              once: true,
            });
          });
          return;
        }
        await fixtureBuild(input);
      },
      requirements,
    );
    const native = new NativeTools(
        '',
        path.join(root, 'empty-bundle'),
        new NativeModels(path.join(root, 'models')),
        builder.installedRoot,
      ),
      settings = structuredClone(defaultServiceSettings);
    for (const engine of ['whisper', 'sd', 'audio'] as const) {
      settings.native[engine].backend = 'cpu';
      builder.start(engine, 'cpu');
      await builder.wait();
      assert.equal(builder.job!.status, 'done', builder.job!.message);
      const runtime = await native.runtime(engine, 'cpu');
      assert.ok(runtime.startsWith(builder.installedRoot));
    }
    assert.ok((await native.status(settings)).every((s) => s.available));
    const before = await installedRuntime(builder.installedRoot, 'audio', 'cpu');
    mode = 'fail';
    builder.start('audio', 'cpu');
    await builder.wait();
    assert.equal(builder.job!.status, 'error');
    assert.equal(await installedRuntime(builder.installedRoot, 'audio', 'cpu'), before);
    mode = 'cancel';
    builder.start('audio', 'cpu');
    while (builder.job!.stage !== '检查编译工具' && String(builder.job!.status) === 'queued')
      await new Promise((r) => setTimeout(r, 5));
    await builder.cancel();
    assert.equal(builder.job!.status, 'cancelled');
    assert.equal(await installedRuntime(builder.installedRoot, 'audio', 'cpu'), before);
    assert.ok(!(await fs.readdir(builder.root)).some((n) => n.startsWith('install-')));
    const fresh = new NativeTools(
      '',
      path.join(root, 'empty-bundle'),
      new NativeModels(path.join(root, 'models')),
      builder.installedRoot,
    );
    await fresh.runtime('audio', 'cpu');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('编译工具缺失或安装提交写入失败，不启用未完成程序', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-runtime-failure-')),
    rename = fs.rename;
  try {
    const missing = new RuntimeBuilder(
      root,
      'resources',
      async () => assert.fail('should not build'),
      async () => ({
        ...(await requirements()),
        ready: false,
        tools: [{ name: 'CMake', available: false, detail: 'missing' }],
      }),
    );
    missing.start('whisper', 'cpu');
    await missing.wait();
    assert.match(missing.job!.message!, /CMake/);
    const builder = new RuntimeBuilder(root, 'resources', fixtureBuild, requirements);
    builder.start('whisper', 'cpu');
    await builder.wait();
    assert.equal(builder.job!.status, 'done');
    const old = await installedRuntime(builder.installedRoot, 'whisper', 'cpu');
    fs.rename = (async (from, to) => {
      if (String(to).endsWith('active.json')) throw new Error('ENOSPC injected');
      return rename(from, to);
    }) as typeof fs.rename;
    builder.start('whisper', 'cpu');
    await builder.wait();
    assert.equal(builder.job!.status, 'error');
    assert.equal(await installedRuntime(builder.installedRoot, 'whisper', 'cpu'), old);
    assert.ok(!(await fs.readdir(root)).some((n) => n.startsWith('install-')));
  } finally {
    fs.rename = rename;
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('编译进程取消等待退出，不遗留持续运行的子进程', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-compiler-process-'));
  try {
    const script = path.join(root, 'compiler.mjs'),
      pidFile = path.join(root, 'pid');
    await fs.writeFile(
      script,
      `import fs from 'node:fs';import {spawn} from 'node:child_process';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000);`,
    );
    const abort = new AbortController();
    const running = runBuildProcess({
      script,
      args: [],
      cwd: root,
      env: process.env,
      signal: abort.signal,
      onLine: () => {},
    });
    for (let i = 0; i < 100 && !(await fs.stat(pidFile).catch(() => null)); i++)
      await new Promise((r) => setTimeout(r, 10));
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    abort.abort();
    await assert.rejects(running, /取消/);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
