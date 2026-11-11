import { clipRect, type Clip, type Project } from './model';
export type Rect = { x: number; y: number; width: number; height: number };
export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export function visualRect(
  p: Project,
  c: Clip,
  measure: (text: string, fontSize: number) => number,
): Rect | null {
  const a = p.assets.find((a) => a.id === c.assetId);
  if (a && a.kind !== 'audio') return clipRect(p, a, c);
  if (c.text !== undefined) {
    const lines = c.text.split('\n');
    return {
      x: c.x,
      y: c.y,
      width: Math.max(24, ...lines.map((line) => measure(line, c.fontSize))),
      height: Math.max(c.fontSize, lines.length * c.fontSize * 1.4),
    };
  }
  return null;
}
export function resizeVisual(
  c: Clip,
  rect: Rect,
  corner: Corner,
  point: { x: number; y: number },
): Partial<Clip> {
  const west = corner.endsWith('w'),
    north = corner.startsWith('n');
  const ax = west ? rect.x + rect.width : rect.x,
    ay = north ? rect.y + rect.height : rect.y;
  const vx = (west ? -1 : 1) * rect.width,
    vy = (north ? -1 : 1) * rect.height;
  const factor = Math.max(0.01, ((point.x - ax) * vx + (point.y - ay) * vy) / (vx * vx + vy * vy));
  const text = c.text !== undefined;
  const value = text
    ? Math.max(8, Math.min(400, Math.round(c.fontSize * factor)))
    : Math.max(0.01, Math.min(10, c.scale * factor));
  const actual = value / (text ? c.fontSize : c.scale);
  return {
    ...(text ? { fontSize: value } : { scale: value }),
    x: Math.max(-8192, Math.min(8192, Math.round(west ? ax - rect.width * actual : ax))),
    y: Math.max(-8192, Math.min(8192, Math.round(north ? ay - rect.height * actual : ay))),
  };
}
