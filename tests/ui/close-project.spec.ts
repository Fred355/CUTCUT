import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('关闭工程：取消、保存失败、保存、菜单关闭、放弃草稿与重新打开', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-close-'));
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
    await desktop.evaluate(({ dialog }, tmp) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [tmp],
      })) as typeof dialog.showOpenDialog;
      dialog.showMessageBoxSync = () => 1;
      dialog.showMessageBox = (async () => ({
        response: 2,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, tmp);
    const page = await desktop.firstWindow();
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByLabel('工程名称').fill('关闭验证');
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByRole('button', { name: 'T 添加文字' }).click();
    const folder = path.join(
      tmp,
      (await fs.readdir(tmp)).find((n) => n.startsWith('关闭验证-'))!,
    );
    const projectFile = path.join(folder, 'project.cutcut'),
      draft = path.join(folder, '.cutcut-recovery.json');
    await page.getByRole('button', { name: '关闭工程', exact: true }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    // A failed atomic save must leave the complete editing session open.
    await desktop.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 0,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
    await fs.rename(projectFile, projectFile + '.backup');
    await fs.mkdir(projectFile);
    await page.getByRole('button', { name: '关闭工程', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(/EISDIR|directory/i);
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await fs.rmdir(projectFile);
    await fs.rename(projectFile + '.backup', projectFile);
    await page.getByRole('button', { name: '关闭工程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    expect(desktop.windows()).toHaveLength(1);
    expect(
      JSON.parse(await fs.readFile(projectFile, 'utf8')).tracks.flatMap((t: any) => t.clips),
    ).toHaveLength(1);
    await expect
      .poll(() =>
        fs.stat(draft).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as typeof dialog.showOpenDialog;
    }, projectFile);
    await page.getByRole('button', { name: '打开工程', exact: true }).first().click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.getByTitle('撤销', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'T 添加文字' }).click();
    await expect
      .poll(() =>
        fs.stat(draft).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await desktop.evaluate(({ dialog, Menu }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      const item = Menu.getApplicationMenu()!
        .items.flatMap((i) => i.submenu?.items || [])
        .find((i) => i.label === '关闭工程')!;
      if (item.accelerator !== 'CmdOrCtrl+W') throw new Error('Missing project close accelerator');
      item.click();
    });
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    await expect
      .poll(() =>
        fs.stat(draft).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    await page.getByRole('button', { name: '打开工程', exact: true }).first().click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await expect(page.getByTitle('撤销', { exact: true })).toBeDisabled();
    await page.getByTitle('播放', { exact: true }).click();
    await page.getByRole('button', { name: '关闭工程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    expect(await page.locator('video,audio').count()).toBe(0);
    expect(desktop.windows()).toHaveLength(1);
    // Cancel a real export before it can replace an existing deliverable.
    await page.getByRole('button', { name: '打开工程', exact: true }).first().click();
    await page.locator('.timeline-clip').first().click();
    await page.getByLabel('持续帧数').fill('1800');
    await page.getByLabel('持续帧数').press('Enter');
    const target = path.join(tmp, '已有成片.mp4');
    await fs.writeFile(target, 'existing-output');
    await desktop.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: target,
      })) as typeof dialog.showSaveDialog;
      dialog.showMessageBox = (async (_window, options) => ({
        response: options.message.includes('任务') ? 0 : 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, target);
    await page.getByRole('button', { name: '↗ 导出成片' }).click();
    await page.getByRole('button', { name: '关闭工程', exact: true }).click();
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    expect(await fs.readFile(target, 'utf8')).toBe('existing-output');
    expect((await fs.readdir(tmp)).filter((n) => n.startsWith('.cutcut-render-'))).toHaveLength(0);
    expect(desktop.windows()).toHaveLength(1);
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
