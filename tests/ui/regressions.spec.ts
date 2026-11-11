import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

test('暂停恢复、拆分后的画面和音频持续可用', async ({}, info) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-regression-'));
  const file = path.join(tmp, '带声音的视频.mp4');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:size=320x180:rate=30:duration=8',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=8',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
  const photo = path.join(tmp, '拖入的照片.png');
  execFileSync(ffmpeg!, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=lime:size=200x100',
    '-frames:v',
    '1',
    '-threads',
    '1',
    photo,
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
    env: { ...process.env, XDG_CONFIG_HOME: tmp, XDG_CACHE_HOME: tmp },
  });
  try {
    const page = await desktop.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.evaluate(() => {
      const original = AudioNode.prototype.connect;
      (window as any).__analysers = [];
      AudioNode.prototype.connect = function (this: AudioNode, ...args: any[]) {
        if (args[0] instanceof AudioDestinationNode) {
          const analyser = this.context.createAnalyser();
          analyser.fftSize = 2048;
          (window as any).__analysers.push(analyser);
          (original as any).call(this, analyser);
          return (original as any).call(analyser, args[0]);
        }
        return (original as any).apply(this, args);
      } as typeof original;
    });
    await desktop.evaluate(
      ({ dialog }, data) => {
        const paths = [[data.tmp], [data.file]];
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: paths.shift()!,
        })) as typeof dialog.showOpenDialog;
        dialog.showMessageBoxSync = () => 1;
      },
      { tmp, file },
    );
    await page.getByRole('button', { name: '＋ 创建剪辑工程' }).click();
    await page.getByRole('button', { name: '创建工程 →' }).click();
    await page.getByTitle('导入素材').click();
    await expect(page.locator('.asset-card')).toHaveCount(1);
    await expect(page.getByRole('status')).toContainText('已导入 1');
    await page.getByTitle('添加到时间线').click();
    const hasPicture = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas')!;
        return c.getContext('2d')!.getImageData(500, 400, 1, 1).data[0] > 180;
      });
    const hasAudio = () =>
      page.evaluate(() =>
        ((window as any).__analysers as AnalyserNode[]).some((a) => {
          const data = new Float32Array(a.fftSize);
          a.getFloatTimeDomainData(data);
          return Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) > 0.015;
        }),
      );
    await expect.poll(hasPicture, { message: '暂停状态下显示视频首帧' }).toBe(true);
    await page.getByTitle('播放', { exact: true }).click();
    await expect.poll(hasAudio, { message: '首次播放有实际音频样本' }).toBe(true);
    await page.getByTitle('暂停', { exact: true }).click();
    await expect.poll(hasPicture, { message: '暂停保留视频画面' }).toBe(true);
    await page.screenshot({ path: info.outputPath('paused.png') });
    await page.getByTitle('播放', { exact: true }).click();
    await expect.poll(hasAudio, { message: '恢复播放有实际音频样本' }).toBe(true);
    await expect.poll(hasPicture).toBe(true);
    await page.getByTitle('暂停', { exact: true }).click();
    await page.getByRole('button', { name: 'T 添加文字' }).click();
    await expect(page.getByLabel('持续帧数')).toHaveValue('240');
    await page.getByLabel('文字内容').fill('拆分后保留字幕');
    await page.locator('.timeline-clip.video').click();
    await page.getByLabel('播放位置').fill('120');
    await page.getByRole('button', { name: /拆分/ }).click();
    await page.getByLabel('播放位置').fill('115');
    await page.getByTitle('播放', { exact: true }).click();
    await expect
      .poll(async () => Number(await page.getByLabel('播放位置').inputValue()))
      .toBeGreaterThan(125);
    await expect.poll(hasAudio, { message: '跨越拆分点仍有实际声音' }).toBe(true);
    await page.getByTitle('暂停', { exact: true }).click();
    await page.getByLabel('播放位置').fill('135');
    await expect.poll(hasPicture, { message: '第二段视频可单独定位' }).toBe(true);
    await page.getByTitle('播放', { exact: true }).click();
    await expect.poll(hasAudio, { message: '第二段继承源音轨' }).toBe(true);
    await page.getByTitle('暂停', { exact: true }).click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const ctx = document.querySelector('canvas')!.getContext('2d')!;
            const data = ctx.getImageData(80, 920, 600, 120).data;
            let count = 0;
            for (let i = 0; i < data.length; i += 4)
              if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) count++;
            return count;
          }),
        { message: '第二段仍有中文字形' },
      )
      .toBeGreaterThan(100);
    await page.locator('.timeline-clip.text').click();
    const textBox = await page.locator('.selection-outline').boundingBox();
    await page.mouse.move(textBox!.x + textBox!.width / 2, textBox!.y + textBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      textBox!.x + textBox!.width / 2 + 50,
      textBox!.y + textBox!.height / 2 - 40,
    );
    await page.mouse.up();
    const movedX = Number(await page.getByLabel('X 位置').inputValue());
    expect(movedX).toBeGreaterThan(80);
    await page.getByTitle('撤销').click();
    await expect(page.getByLabel('X 位置')).toHaveValue('80');
    await page.getByTitle('重做').click();
    await expect(page.getByLabel('X 位置')).toHaveValue(String(movedX));
    // A real disk-backed File travels through Chromium -> DataTransfer -> contextBridge -> webUtils.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'drop-source';
      document.body.appendChild(input);
    });
    await page.locator('#drop-source').setInputFiles(photo);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#drop-source')!;
      const data = new DataTransfer();
      data.items.add(input.files![0]);
      document
        .querySelector('.library')!
        .dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }),
        );
      input.remove();
    });
    await expect(page.locator('.asset-card')).toHaveCount(2);
    await expect(page.getByRole('status')).toContainText('已导入 1');
    await page
      .locator('.asset-card')
      .filter({ hasText: '拖入的照片.png' })
      .getByTitle('添加画中画')
      .click();
    await expect(page.getByLabel('等比缩放')).toHaveValue('0.3');
    const size = await page.getByLabel('缩放图层 se').boundingBox();
    await page.mouse.move(size!.x + size!.width / 2, size!.y + size!.height / 2);
    await page.mouse.down();
    await page.mouse.move(size!.x + size!.width / 2 + 40, size!.y + size!.height / 2 + 20);
    await page.mouse.up();
    expect(Number(await page.getByLabel('等比缩放').inputValue())).toBeGreaterThan(0.3);
    await page.screenshot({ path: info.outputPath('transform-and-drop.png') });
    await page.getByRole('button', { name: /保存/ }).first().click();
    await expect(page.getByRole('status')).toContainText('工程已保存');
    const dir = (await fs.readdir(tmp)).find((name) => name.startsWith('我的第一支影片-'))!;
    const saved = JSON.parse(await fs.readFile(path.join(tmp, dir, 'project.cutcut'), 'utf8'));
    expect(saved.assets).toHaveLength(2);
    expect(saved.tracks.find((t: any) => t.kind === 'image').clips[0].scale).toBeGreaterThan(0.3);
    expect(saved.tracks.find((t: any) => t.kind === 'text').clips[0].duration).toBe(240);
    const projectFile = path.join(tmp, dir, 'project.cutcut');
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as typeof dialog.showOpenDialog;
    }, projectFile);
    await page.getByRole('button', { name: '打开工程' }).click();
    await expect(page.getByRole('status')).toContainText('工程已打开');
    await page.locator('.timeline-clip.image').click();
    expect(Number(await page.getByLabel('等比缩放').inputValue())).toBeGreaterThan(0.3);
    await page.locator('.timeline-clip.text').click();
    await expect(page.getByLabel('X 位置')).toHaveValue(String(movedX));
    expect(errors).toEqual([]);
  } finally {
    await desktop.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
