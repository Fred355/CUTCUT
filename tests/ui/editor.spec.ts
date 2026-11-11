import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
test('桌面导入、多轨编辑、保存重开与真实 MP4 导出', async ({}, testInfo) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-desktop-')),
    source = path.join(tmp, '桌面素材.mp4'),
    photo = path.join(tmp, '图片.png'),
    music = path.join(tmp, '音乐.wav');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=yellow:s=200x200',
    '-frames:v',
    '1',
    '-threads',
    '1',
    photo,
  ]);
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=3',
    music,
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
        const paths = [
          { canceled: false, filePaths: [data.tmp] },
          { canceled: false, filePaths: [data.source, data.photo, data.music] },
        ];
        dialog.showOpenDialog = (async () => paths.shift()!) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: data.tmp + '/成片.mp4',
        })) as typeof dialog.showSaveDialog;
        dialog.showMessageBoxSync = () => 1;
      },
      { tmp, source, photo, music },
    );
    const page = await desktop.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.text().includes('MediaElementAudioSource outputs zeroes')) errors.push(m.text());
    });
    await expect(page.getByRole('heading', { name: '你好，创作者' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('welcome.png') });
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByLabel('工程名称').fill('桌面验证');
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await expect(page.locator('.project-title')).toContainText('桌面验证');
    await page.getByTitle('导入素材').click();
    await expect(page.locator('.asset-card')).toHaveCount(3, { timeout: 30000 });
    await expect(page.getByRole('status')).toContainText('已导入 3');
    await page
      .locator('.asset-card')
      .filter({ hasText: '桌面素材.mp4' })
      .getByTitle('添加到时间线')
      .click();
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    const lane = page.locator('.track-lane').nth(1);
    await page
      .locator('.timeline-clip')
      .dragTo(lane, { sourcePosition: { x: 10, y: 10 }, targetPosition: { x: 70, y: 20 } });
    await expect(page.getByLabel('时间线起点', { exact: true })).toHaveValue(/^(29|30)$/);
    await page
      .locator('.timeline-clip')
      .dragTo(lane, { sourcePosition: { x: 10, y: 10 }, targetPosition: { x: 10, y: 20 } });
    await expect(page.getByLabel('时间线起点', { exact: true })).toHaveValue('0');
    const handle = await page.getByRole('slider', { name: '裁剪片段结尾' }).boundingBox();
    await page.mouse.move(handle!.x + 3, handle!.y + 15);
    await page.mouse.down();
    await page.mouse.move(handle!.x - 17, handle!.y + 15);
    await page.mouse.up();
    await expect(page.getByLabel('持续帧数')).toHaveValue('50');
    await page.getByTitle('撤销').click();
    await expect(page.getByLabel('持续帧数')).toHaveValue('60');
    await page.getByLabel('播放位置').fill('30');
    await page.getByRole('button', { name: /拆分/ }).click();
    await expect(page.locator('.timeline-clip')).toHaveCount(2);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect(page.locator('.timeline-clip')).toHaveCount(1);
    await page.getByTitle('重做').click();
    await expect(page.locator('.timeline-clip')).toHaveCount(2);
    await page.locator('.timeline-clip').nth(1).click();
    await page.getByLabel('时间线起点', { exact: true }).fill('90');
    await page.getByLabel('时间线起点', { exact: true }).press('Enter');
    await expect(page.getByLabel('时间线起点', { exact: true })).toHaveValue('90');
    await page
      .locator('.asset-card')
      .filter({ hasText: '图片.png' })
      .getByTitle('添加到时间线')
      .click();
    await page.getByLabel('等比缩放').fill('0.25');
    await page.getByLabel('等比缩放').press('Enter');
    await page.getByLabel('X 位置').fill('80');
    await page.getByLabel('X 位置').press('Enter');
    await page.getByLabel('Y 位置').fill('80');
    await page.getByLabel('Y 位置').press('Enter');
    await page
      .locator('.asset-card')
      .filter({ hasText: '音乐.wav' })
      .getByTitle('添加到时间线')
      .click();
    await page.getByLabel('音量', { exact: true }).fill('0.4');
    await page.getByLabel('音量', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'T 添加文字' }).click();
    await page.getByLabel('文字内容').fill('CUTCUT 中文剪辑');
    await page.getByLabel('字号').click();
    await page.getByLabel('播放位置').fill('35');
    await expect(page.locator('.timeline-clip')).toHaveCount(5);
    await page.getByTitle('播放', { exact: true }).click();
    await expect
      .poll(async () => Number(await page.getByLabel('播放位置').inputValue()), {
        message: '等待媒体缓冲后播放头推进',
      })
      .toBeGreaterThan(35);
    const audioURL = await page.locator('.preview-media audio').getAttribute('src');
    const partial = await desktop.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url!, { headers: { Range: 'bytes=44-63' } });
      return {
        status: response.status,
        range: response.headers.get('content-range'),
        length: response.headers.get('content-length'),
        bytes: (await response.arrayBuffer()).byteLength,
      };
    }, audioURL);
    expect(partial.status).toBe(206);
    expect(partial.range).toMatch(/^bytes 44-63\//);
    expect(partial.length).toBe('20');
    expect(partial.bytes).toBe(20);
    await page.getByTitle('暂停', { exact: true }).click();
    const frame = await page.getByLabel('播放位置').inputValue();
    expect(Number(frame)).toBeGreaterThan(35);
    await page.getByRole('button', { name: /保存/ }).first().click();
    await expect(page.getByRole('status')).toContainText('工程已保存');
    const folder = (await fs.readdir(tmp)).find((n) => n.startsWith('桌面验证-'))!;
    const projectFile = path.join(tmp, folder, 'project.cutcut');
    const saved = JSON.parse(await fs.readFile(projectFile, 'utf8'));
    expect(saved.tracks.flatMap((t: any) => t.clips)).toHaveLength(5);
    expect(saved.tracks.find((t: any) => t.kind === 'video').clips[1].start).toBe(90);
    await page.screenshot({ path: testInfo.outputPath('editor.png') });
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as typeof dialog.showOpenDialog;
    }, projectFile);
    await page.getByRole('button', { name: '打开工程' }).click();
    await expect(page.getByRole('status')).toContainText('工程已打开');
    await expect(page.locator('.timeline-clip')).toHaveCount(5);
    await page.getByRole('button', { name: '版本历史', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '版本历史' })).toBeVisible();
    await expect(page.getByRole('button', { name: '恢复此版本' }).first()).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await page.locator('.timeline-clip.video').first().click();
    const originalDuration = Number(await page.getByLabel('持续帧数').inputValue());
    await page.getByLabel('播放速度', { exact: true }).selectOption('2');
    await expect(page.getByLabel('持续帧数')).toHaveValue(String(Math.floor(originalDuration / 2)));
    await page.getByTitle('撤销').click();
    await expect(page.getByLabel('持续帧数')).toHaveValue(String(originalDuration));
    await page.getByLabel('淡入帧数').fill('3');
    await page.getByLabel('淡入帧数').press('Enter');
    await expect(page.getByLabel('淡入帧数')).toHaveValue('3');
    await page.getByTitle('撤销').click();
    await expect(page.getByLabel('淡入帧数')).toHaveValue('0');
    await page.getByRole('button', { name: '↗ 导出成片' }).click();
    await expect(page.getByRole('status')).toContainText('导出完成', { timeout: 60000 });
    expect((await fs.stat(path.join(tmp, '成片.mp4'))).size).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
