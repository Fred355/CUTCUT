import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
test('AI 入口、固定模型任务流程及独立初剪工程（服务接口替身）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-ai-ui-'));
  const source = path.join(tmp, '图.png');
  execFileSync(ffmpeg!, [
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
    source,
  ]);
  const desktop = await electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? [
            '--ozone-platform=x11',
            '--disable-gpu',
            ...(process.env.CUTCUT_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
          ]
        : []),
      `--user-data-dir=${tmp}/profile`,
      '.',
    ],
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: tmp, XDG_CACHE_HOME: tmp },
  });
  try {
    await desktop.evaluate(
      ({ dialog }, data) => {
        let n = 0;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [n++ === 1 ? data.source : data.tmp],
        })) as typeof dialog.showOpenDialog;
        dialog.showMessageBoxSync = () => 1;
        let calls = 0;
        let assetId = '';
        globalThis.fetch = async (_url, options) => {
          calls++;
          const body = JSON.parse(options!.body as string);
          if (calls === 1) {
            const match = JSON.stringify(body).match(/assetId=([a-zA-Z0-9-]+)/);
            assetId = match![1];
          }
          return Response.json({
            choices: [
              {
                message: {
                  content:
                    calls === 3
                      ? JSON.stringify({
                          title: 'AI 独立初剪',
                          summary: '接口替身验证',
                          clips: [{ assetId, in: 0, start: 0, duration: 90, reason: 'test' }],
                        })
                      : '红色画面',
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        };
      },
      { tmp, source },
    );
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByLabel('工程名称').fill('原工程');
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByTitle('导入素材', { exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.evaluate(async () => {
      const api = window.cutcut!;
      const v = await api.settings();
      await api.updateSettings({
        ...v.settings,
        services: [
          {
            id: 'openai',
            name: 'OpenAI',
            kind: 'cloud',
            provider: 'openai',
            protocol: 'openai',
            baseURL: 'https://api.openai.com/v1',
            auth: 'provider',
            timeoutSeconds: 120,
          },
          {
            id: 'groq',
            name: 'Groq',
            kind: 'cloud',
            provider: 'groq',
            protocol: 'openai',
            baseURL: 'https://api.groq.com/openai/v1',
            auth: 'provider',
            timeoutSeconds: 120,
          },
        ],
        bindings: {
          ...v.settings.bindings,
          planner: { serviceId: 'openai', model: 'planner-test' },
          worker: { serviceId: 'groq', model: 'worker-test' },
          vision: { serviceId: 'openai', model: 'vision-test' },
        },
      });
      await api.setKey('openai', 'test-key');
      await api.setKey('groq', 'test-key');
    });
    await page.getByRole('button', { name: 'AI 剪辑', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'AI 剪辑' });
    await panel.getByRole('button', { name: '生成初剪方案' }).click();
    await panel.getByLabel(/允许本次任务/).check();
    await panel.getByRole('button', { name: '确认启动任务' }).click();
    await expect(panel.getByRole('button', { name: '应用为独立新工程' })).toBeVisible({
      timeout: 20000,
    });
    await panel.getByRole('button', { name: '应用为独立新工程' }).click();
    await expect(page.locator('.project-title')).toContainText('AI 独立初剪');
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    const dirs = await fs.readdir(tmp);
    {
      expect(dirs.filter((n) => n.startsWith('原工程-'))).toHaveLength(1);
      expect(dirs.filter((n) => n.startsWith('AI 独立初剪-'))).toHaveLength(1);
    }
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('转写文稿、SRT、字幕和按句切分（语音服务接口替身）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-asr-ui-')),
    source = path.join(tmp, '口播.mp4');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=320x180:r=30:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  const desktop = await electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? [
            '--ozone-platform=x11',
            '--disable-gpu',
            ...(process.env.CUTCUT_TEST_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
          ]
        : []),
      `--user-data-dir=${tmp}/profile`,
      '.',
    ],
    cwd: process.cwd(),
    env: { ...process.env, XDG_CONFIG_HOME: tmp, XDG_CACHE_HOME: tmp },
  });
  try {
    await desktop.evaluate(
      ({ dialog }, data) => {
        let n = 0;
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [n++ === 0 ? data.tmp : data.source],
        })) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: data.tmp + '/字幕.srt',
        })) as typeof dialog.showSaveDialog;
        dialog.showMessageBoxSync = () => 1;
        globalThis.fetch = async () =>
          Response.json({
            segments: [
              { start: 0, end: 0.7, text: '第一句。' },
              { start: 1, end: 2, text: 'Second sentence.' },
            ],
          });
      },
      { tmp, source },
    );
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByTitle('导入素材', { exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByTitle('添加到时间线', { exact: true }).click();
    await page.evaluate(async () => {
      const api = window.cutcut!;
      const v = await api.settings();
      await api.updateSettings({
        ...v.settings,
        services: [
          {
            id: 'groq',
            name: 'Groq',
            kind: 'cloud',
            provider: 'groq',
            protocol: 'openai',
            baseURL: 'https://api.groq.com/openai/v1',
            auth: 'provider',
            timeoutSeconds: 120,
          },
        ],
        bindings: {
          ...v.settings.bindings,
          speech: { serviceId: 'groq', model: 'whisper-large-v3' },
        },
      });
      await api.setKey('groq', 'test-key');
    });
    await page.getByRole('button', { name: 'AI 剪辑', exact: true }).click();
    let panel = page.getByRole('dialog', { name: 'AI 剪辑' });
    await panel.getByRole('button', { name: '语音转文字', exact: true }).click();
    await panel.getByLabel(/允许本次任务/).check();
    await panel.getByRole('button', { name: '确认启动任务' }).click();
    await expect(panel.getByLabel('语句 1', { exact: true })).toHaveValue('第一句。');
    await panel.getByLabel('语句 1', { exact: true }).fill('修改后的第一句。');
    await panel.getByRole('button', { name: '保存文稿', exact: true }).click();
    await panel.getByRole('button', { name: '导出选中片段 SRT' }).click();
    await expect
      .poll(async () => fs.readFile(path.join(tmp, '字幕.srt'), 'utf8').catch(() => ''))
      .toContain('修改后的第一句。');
    await panel.getByRole('button', { name: '为选中片段生成字幕' }).click();
    await expect(page.locator('.timeline-clip.text')).toHaveCount(2);
    await page.getByRole('button', { name: 'AI 剪辑', exact: true }).click();
    panel = page.getByRole('dialog', { name: 'AI 剪辑' });
    await panel.getByRole('button', { name: '语音转文字', exact: true }).click();
    await panel.getByLabel(/允许本次任务/).check();
    await panel.getByRole('button', { name: '确认启动任务' }).click();
    await expect(panel.getByLabel('语句 1', { exact: true })).toHaveValue('第一句。');
    await panel.getByRole('button', { name: '选中片段按句切分' }).click();
    await expect(page.locator('.timeline-clip.video')).toHaveCount(2);
    await expect(page.locator('.timeline-clip.text')).toHaveCount(2);
    await page.getByTitle('撤销', { exact: true }).click();
    await expect(page.locator('.timeline-clip.video')).toHaveCount(1);
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
