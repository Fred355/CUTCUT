import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('运行时状态 IPC 替身：权重已安装但程序缺失，设置提示修复且禁止生成', async ({}, testInfo) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-readiness-ui-'));
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
    await desktop.evaluate(({ dialog, ipcMain }, tmp) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [tmp],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBoxSync = () => 1;
      ipcMain.removeHandler('runtime:prerequisites');
      ipcMain.handle('runtime:prerequisites', () => ({
        ready: false,
        platform: 'darwin-arm64',
        tools: [{ name: 'CMake', available: false, detail: '请安装 CMake.app' }],
      }));
      ipcMain.removeHandler('native:status');
      ipcMain.handle('native:status', () => ({
        blocked: false,
        modelsPath: tmp,
        engines: ['whisper', 'sd', 'audio'].map((id) => ({
          id,
          backend: 'metal',
          version: 'test',
          available: false,
          runtimePath: `/test/resources/runtimes/darwin-arm64/${id}/metal/bin/cli`,
          runtimeIssue: '未找到运行程序清单',
          setupHint: `请在软件设置点击“编译并安装运行程序”。已下载的模型可保留。`,
          model: {
            id: 'test',
            installed: true,
            bytes: 1024,
            status: 'ready',
            received: 0,
            inUse: false,
          },
        })),
      }));
    }, tmp);
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '⚙ 软件设置', exact: true }).first().click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '音乐生成', exact: true })
      .click();
    await expect(page.getByLabel('运行程序状态')).toContainText('缺失或不可用');
    await expect(page.getByText(/模型权重：已校验并安装/)).toBeVisible();
    await expect(page.getByLabel('运行程序状态')).toContainText('编译并安装运行程序');
    await page.getByRole('button', { name: '编译并安装运行程序', exact: true }).click();
    await expect(page.getByRole('button', { name: '下载 CMake', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('请先安装');
    expect(await page.evaluate(() => window.cutcut!.runtimeBuildStatus())).toBeNull();
    await page.getByRole('button', { name: /工作台/ }).click();
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByLabel('工程名称').fill('生成状态验证');
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByRole('button', { name: '生成素材', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '生成素材' });
    await panel.getByRole('button', { name: '音乐', exact: true }).click();
    await panel.getByLabel('生成描述').fill('ambient piano');
    await expect(panel.getByText(/模型权重：已安装/)).toBeVisible();
    await expect(panel.getByLabel('运行程序状态')).toContainText('缺失或不可用');
    await expect(panel.getByRole('button', { name: '开始生成' })).toBeDisabled();
    expect(await page.evaluate(() => window.cutcut!.generationStatus())).toBeNull();
    await page.screenshot({ path: testInfo.outputPath('missing-runtime.png') });
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
