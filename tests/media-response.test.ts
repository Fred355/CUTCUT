import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaResponse } from '../src/main/media-response';
test('媒体协议返回真实字节范围，支持定位、后缀、HEAD 和越界处理', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutcut-range-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sample.wav'),
    data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await fs.writeFile(file, data);
  const fetch = (range?: string, method = 'GET') =>
    mediaResponse(
      file,
      new Request('https://local.invalid/asset', {
        method,
        headers: range ? { Range: range } : undefined,
      }),
    );
  for (const [range, start, end] of [
    ['bytes=44-63', 44, 63],
    ['bytes=200-', 200, 255],
    ['bytes=-8', 248, 255],
    ['bytes=250-999', 250, 255],
  ] as const) {
    const r = await fetch(range);
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/256`);
    assert.equal(r.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(start, end + 1));
  }
  const whole = await fetch();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), data);
  const head = await fetch(undefined, 'HEAD');
  assert.equal(head.headers.get('content-length'), '256');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const range of [
    'bytes=256-',
    'bytes=10-5',
    'bytes=-0',
    'bytes=-',
    'bytes=0-1,8-9',
    'bytes=99999999999999999999-',
  ]) {
    const r = await fetch(range);
    assert.equal(r.status, 416);
    assert.equal(r.headers.get('content-range'), 'bytes */256');
  }
  assert.equal((await fetch(undefined, 'POST')).status, 405);
});
