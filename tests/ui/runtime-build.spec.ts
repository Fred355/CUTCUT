import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('可选实编译：Electron 内检查工具、编译 Whisper CPU 并即时识别', async () => {
  test.skip(
    process.env.CUTCUT_TEST_REAL_BUILD !== '1',
    '需网络与 CMake/C++ 工具；按需执行实际源码编译',
  );
  test.setTimeout(360000);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-real-runtime-'));
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
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '⚙ 软件设置', exact: true }).first().click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '语音识别', exact: true })
      .click();
    await page.getByLabel('whisper 计算后端').selectOption('cpu');
    const installer = page.getByLabel('安装运行支持');
    await installer.getByRole('button', { name: '编译并安装运行程序', exact: true }).click();
    let final,
      lastStage = '';
    for (let i = 0; i < 300; i++) {
      final = await page.evaluate(() => window.cutcut!.runtimeBuildStatus());
      if (final && final.stage !== lastStage) {
        lastStage = final.stage;
        console.log('Runtime build:', lastStage);
      }
      if (final && ['done', 'error', 'cancelled'].includes(final.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(final?.status, JSON.stringify(final)).toBe('done');
    const status = await page.evaluate(() => window.cutcut!.nativeStatus());
    const whisper = status.engines.find((e) => e.id === 'whisper')!;
    expect(whisper.available).toBe(true);
    expect(whisper.runtimePath).toContain('runtime-tools');
    expect((await fs.stat(whisper.runtimePath)).size).toBeGreaterThan(10000);
    await expect(page.getByLabel('运行程序状态')).toContainText('已找到');
  } finally {
    const page = await desktop.firstWindow();
    await page.evaluate(() => window.cutcut!.cancelRuntimeBuild()).catch(() => {});
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
