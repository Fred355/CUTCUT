import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callModel, compatibleURL } from '../src/main/providers';
import { AITasks } from '../src/main/ai-tasks';
import { AppState } from '../src/main/app-state';
import { defaultSettings, providers, type Settings } from '../src/shared/studio';
import { newProject } from '../src/shared/model';
import { run, binaries } from '../src/main/media';

test('所有模型协议、认证头和自定义 HTTPS 地址', async () => {
  for (const provider of providers) {
    let body: any,
      headers: any,
      url = '';
    const fetcher: typeof fetch = async (u, options) => {
      url = String(u);
      body = JSON.parse(options!.body as string);
      headers = options!.headers;
      assert.equal(options!.redirect, 'error');
      return Response.json(
        provider === 'anthropic'
          ? {
              content: [{ type: 'text', text: 'OK' }],
              usage: { input_tokens: 2, output_tokens: 1 },
            }
          : provider === 'gemini'
            ? {
                candidates: [{ content: { parts: [{ text: 'OK' }] } }],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
              }
            : {
                choices: [{ message: { content: 'OK' } }],
                usage: { prompt_tokens: 2, completion_tokens: 1 },
              },
      );
    };
    const r = await callModel(
      {
        provider,
        model: 'test',
        vision: false,
        baseURL: 'https://example.com/v1',
        accountId: 'a'.repeat(32),
      },
      'test-key',
      { instruction: 'test', text: 'hello' },
      new AbortController().signal,
      fetcher,
    );
    assert.equal(r.text, 'OK');
    assert.equal(r.inputTokens, 2);
    assert.ok(!url.includes('test-key'));
    assert.ok(body);
    assert.ok(headers.Authorization || headers['x-api-key'] || headers['x-goog-api-key']);
  }
  assert.throws(() => compatibleURL('http://example.com/v1'));
  assert.throws(() => compatibleURL('https://secret@example.com/v1'));
});

async function finished(tasks: AITasks) {
  for (let i = 0; i < 300 && tasks.job?.status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(tasks.job?.status, 'running');
  return tasks.job!;
}
test('真实抽帧 + 模型接口替身：阶段顺序、用量及非法素材方案拦截', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-ai-'));
  try {
    await run(binaries().ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=100x100',
      '-frames:v',
      '1',
      '-threads',
      '1',
      path.join(root, 'image.png'),
    ]);
    const p = newProject('fixture');
    p.assets = [
      {
        id: 'image',
        name: '图',
        kind: 'image',
        path: 'image.png',
        durationFrames: 90,
        width: 100,
        height: 100,
        hasAudio: false,
        hdr: false,
      },
    ];
    let count = 0;
    let invalid = false;
    const fake: typeof fetch = async (_u, options) => {
      count++;
      const body = JSON.parse(options!.body as string);
      if (count % 3 === 1) assert.ok(JSON.stringify(body).includes('data:image/jpeg;base64,'));
      return Response.json({
        choices: [
          {
            message: {
              content:
                count % 3 === 0
                  ? JSON.stringify({
                      title: '初剪',
                      summary: '方案',
                      clips: [
                        {
                          assetId: invalid ? 'unknown' : 'image',
                          start: 0,
                          in: 0,
                          duration: 90,
                          reason: 'test',
                        },
                      ],
                    })
                  : '素材描述',
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    };
    const settings: Settings = {
      ...structuredClone(defaultSettings),
      planner: { provider: 'openai', model: 'planner', vision: false },
      worker: { provider: 'groq', model: 'worker', vision: false },
      vision: { provider: 'openai', model: 'vision', vision: true },
    };
    const tasks = new AITasks(fake);
    tasks.start(
      { project: p, kind: 'roughcut', assetIds: ['image'], prompt: 'test', cloudConsent: true },
      root,
      settings,
      () => 'test-key',
    );
    const job = await finished(tasks);
    assert.equal(job.status, 'done', job.message);
    assert.equal(job.calls, 3);
    assert.equal(job.inputTokens, 30);
    assert.equal(job.result?.proposal?.clips[0].assetId, 'image');
    // Mixed routing captures approved endpoints, models and credentials before asynchronous work.
    const mixed: Settings = {
      ...structuredClone(settings),
      vision: {
        provider: 'compatible',
        serviceId: 'local-vision',
        serviceName: 'Local vision',
        mode: 'local',
        auth: 'none',
        protocol: 'openai',
        baseURL: 'http://127.0.0.1:1234/v1',
        model: 'vision',
        vision: true,
      },
      worker: {
        provider: 'compatible',
        serviceId: 'cloud-worker',
        mode: 'cloud',
        auth: 'bearer',
        protocol: 'openai',
        baseURL: 'https://worker.example/v1',
        model: 'worker',
        vision: false,
      },
      planner: {
        provider: 'compatible',
        serviceId: 'cloud-director',
        mode: 'cloud',
        auth: 'bearer',
        protocol: 'openai',
        baseURL: 'https://director.example/v1',
        model: 'planner',
        vision: false,
      },
    };
    let liveKey = 'authorized-key';
    const destinations: string[] = [];
    const frozen = new AITasks(async (url, options) => {
      destinations.push(String(url));
      const body = JSON.parse(options!.body as string),
        headers = options!.headers as Record<string, string>;
      if (body.model === 'vision') assert.equal(headers.Authorization, undefined);
      else assert.equal(headers.Authorization, 'Bearer authorized-key');
      return fake(url, options);
    });
    frozen.start(
      { project: p, kind: 'roughcut', assetIds: ['image'], cloudConsent: true, routeRevision: 9 },
      root,
      mixed,
      () => liveKey,
    );
    mixed.worker.baseURL = 'https://changed.example/v1';
    mixed.planner.model = 'changed';
    liveKey = 'changed-key';
    const frozenJob = await finished(frozen);
    assert.equal(frozenJob.status, 'done', frozenJob.message);
    assert.equal(frozenJob.configurationRevision, 9);
    assert.deepEqual(destinations, [
      'http://127.0.0.1:1234/v1/chat/completions',
      'https://worker.example/v1/chat/completions',
      'https://director.example/v1/chat/completions',
    ]);
    assert.deepEqual(
      frozenJob.usage?.map((u) => u.kind),
      ['local', 'cloud', 'cloud'],
    );
    invalid = true;
    tasks.start(
      { project: p, kind: 'roughcut', assetIds: ['image'], cloudConsent: true },
      root,
      settings,
      () => 'test-key',
    );
    assert.equal((await finished(tasks)).status, 'error');
    assert.throws(() =>
      tasks.start(
        { project: p, kind: 'roughcut', assetIds: ['image'], cloudConsent: false },
        root,
        settings,
        () => 'test-key',
      ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('真实音频提取 + ASR 接口替身，取消后停止任务', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-asr-'));
  try {
    await run(binaries().ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      path.join(root, 'audio.wav'),
    ]);
    const p = newProject('speech');
    p.assets = [
      {
        id: 'audio',
        name: '声音',
        kind: 'audio',
        path: 'audio.wav',
        durationFrames: 60,
        width: 0,
        height: 0,
        hasAudio: true,
        hdr: false,
      },
    ];
    const settings: Settings = { ...structuredClone(defaultSettings), speech: 'groq' };
    const fake: typeof fetch = async (url, options) => {
      assert.match(String(url), /groq.*transcriptions/);
      assert.ok(options?.body instanceof FormData);
      assert.equal(options.body.get('model'), 'whisper-large-v3');
      return Response.json({
        segments: [
          { start: 0, end: 0.8, text: '你好。' },
          { start: 1, end: 2, text: 'Hello.' },
        ],
      });
    };
    const tasks = new AITasks(fake);
    tasks.start(
      { project: p, kind: 'transcribe', assetIds: ['audio'], cloudConsent: true },
      root,
      settings,
      () => 'test-key',
    );
    const result = await finished(tasks);
    assert.equal(result.status, 'done', result.message);
    assert.equal(result.result?.transcript?.segments[1].startMs, 1000);
    let calls = 0;
    const cancelled = new AITasks(async () => {
      calls++;
      return Response.json({});
    });
    cancelled.start(
      { project: p, kind: 'transcribe', assetIds: ['audio'], cloudConsent: true },
      root,
      settings,
      () => 'test-key',
    );
    cancelled.cancel();
    assert.equal((await finished(cancelled)).status, 'cancelled');
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
