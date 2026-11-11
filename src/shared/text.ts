import type { Clip } from './model';
// Browser Canvas2D and native Skia share these metrics and positioning rules.
export function textLines(c: Clip, measure: (text: string) => { actualBoundingBoxAscent: number }) {
  return (c.text || '')
    .split('\n')
    .map((text, index) => ({
      text,
      x: c.x,
      y: c.y + measure(text).actualBoundingBoxAscent + index * c.fontSize * 1.4,
    }));
}
