import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** Chromium media seeking requires 206 + Content-Range, not a 200 response carrying partial bytes. */
export async function mediaResponse(file: string, request: Request): Promise<Response> {
  const info = await stat(file);
  const mime: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  const headers = new Headers({
    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Cache-Control': 'no-cache',
  });
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response(null, { status: 405, headers });
  let start = 0,
    end = info.size - 1,
    status = 200;
  const range = request.headers.get('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const invalid = () => {
      headers.set('Content-Range', `bytes */${info.size}`);
      return new Response(null, { status: 416, headers });
    };
    if (!match || (!match[1] && !match[2]) || info.size === 0) return invalid();
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    } else {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid();
      start = Math.max(0, info.size - suffix);
    }
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= info.size ||
      end < start
    )
      return invalid();
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  headers.set('Content-Length', String(Math.max(0, end - start + 1)));
  if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers });
  const stream = createReadStream(file, { start, end });
  // Reader cancellation closes the underlying file; cancellation by Chromium also aborts it.
  const abort = () => stream.destroy();
  request.signal.addEventListener('abort', abort, { once: true });
  stream.once('close', () => request.signal.removeEventListener('abort', abort));
  if (request.signal.aborted) stream.destroy();
  return new Response(
    Readable.toWeb(stream, {
      strategy: { highWaterMark: 256 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream,
    { status, headers },
  );
}
