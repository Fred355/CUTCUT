import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import http from 'node:http';
test('本机服务设置、独立能力测试、授权修订校验及纯本地初剪（HTTP 替身）', async () => {
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
  let calls = 0,
    assetId = '',
    requests = 0;
  let modelListSupported = true,
    hold = false,
    held = false,
    disconnected = false;
  const server = http.createServer(async (req, res) => {
    requests++;
    expect(req.headers.authorization).toBeUndefined();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      if (!modelListSupported) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.end(JSON.stringify({ data: [{ id: 'test' }] }));
      return;
    }
    expect(req.url).toBe('/v1/chat/completions');
    if (hold) {
      held = true;
      res.on('close', () => {
        disconnected = true;
      });
      return;
    }
    const body = JSON.parse(raw);
    const match = JSON.stringify(body).match(/assetId=([a-zA-Z0-9-]+)/);
    if (match) assetId = match[1];
    if (assetId) calls++;
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                calls === 3
                  ? JSON.stringify({
                      title: 'AI 独立初剪',
                      summary: 'HTTP 替身',
                      clips: [{ assetId, in: 0, start: 0, duration: 90, reason: 'test' }],
                    })
                  : 'OK',
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
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
      },
      { tmp, source },
    );
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '⚙ 软件设置', exact: true }).first().click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: 'AI 剪辑', exact: true })
      .click();
    for (const [role, title] of [
      ['planner', '剪辑规划'],
      ['vision', '画面理解'],
      ['worker', '低成本执行'],
    ]) {
      if (role === 'worker') await page.getByText('高级分工与内存管理', { exact: true }).click();
      const form = page.getByRole('region', { name: title, exact: true });
      await form.getByLabel(`${role} 平台`).selectOption('local:LM Studio');
      await form.getByText('高级设置', { exact: true }).click();
      await form.getByLabel(`${role} Base URL`).fill(baseURL);
      modelListSupported = role !== 'worker';
      await form.getByRole('button', { name: '读取模型', exact: true }).click();
      if (modelListSupported) await form.getByLabel(`${role} 可用模型`).selectOption('test');
      else {
        await expect(form.getByRole('status')).toContainText('HTTP 404');
        await form.getByLabel(`${role} 模型`, { exact: true }).fill('test');
      }
      await form.getByRole('button', { name: '保存并测试', exact: true }).click();
      await expect(form.getByRole('status')).toContainText(
        role === 'vision' ? '视觉接口已响应' : '文本接口已响应',
      );
    }
    await expect(page.getByRole('heading', { name: 'AI 服务列表' })).toHaveCount(0);
    await page.screenshot({ path: 'test-results/feature-settings.png', fullPage: true });
    await page.getByRole('button', { name: /工作台/ }).click();
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByLabel('工程名称').fill('原工程');
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByTitle('导入素材', { exact: true }).click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await page.getByRole('button', { name: 'AI 剪辑', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'AI 剪辑' });
    await panel.getByRole('button', { name: '生成初剪方案' }).click();
    await expect(panel.getByLabel(/允许本次任务/)).toHaveCount(0);
    await expect(panel.getByText('本次任务仅调用本机服务，无云端阶段。')).toBeVisible();
    const before = requests;
    // A settings revision change must invalidate the destination authorization before sending anything.
    await page.evaluate(async () => {
      const api = window.cutcut!,
        v = await api.settings();
      await api.updateSettings({ ...v.settings, theme: 'purple' });
    });
    await panel.getByRole('button', { name: '确认启动任务' }).click();
    await expect(panel.getByText('请检查任务去向，再点击确认启动')).toBeVisible();
    expect(requests).toBe(before);
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
    // Hold an actual loopback HTTP request; closing must abort it before returning home.
    hold = true;
    await page.getByRole('button', { name: 'AI 剪辑', exact: true }).click();
    await panel.getByRole('button', { name: '生成初剪方案' }).click();
    await panel.getByRole('button', { name: '确认启动任务' }).click();
    await expect.poll(() => held).toBe(true);
    await desktop.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      Menu.getApplicationMenu()!
        .items.flatMap((i) => i.submenu?.items || [])
        .find((i) => i.label === '关闭工程')!
        .click();
    });
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    await expect.poll(() => disconnected).toBe(true);
    const folder = path.join(
      tmp,
      dirs.find((n) => n.startsWith('AI 独立初剪-'))!,
    );
    expect(
      (await fs.readdir(path.join(folder, 'cache'))).filter((n) => n.startsWith('ai-')),
    ).toHaveLength(0);
    expect(desktop.windows()).toHaveLength(1);
  } finally {
    await desktop.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
