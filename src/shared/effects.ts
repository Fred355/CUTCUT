import type { Clip, Project } from './model';
export type AnimatedProperty = 'x' | 'y' | 'scale' | 'opacity';
export function valueAt(c: Clip, key: AnimatedProperty, frame: number): number {
  const keys = (c.keyframes || [])
    .filter((k) => k.property === key)
    .sort((a, b) => a.frame - b.frame);
  if (!keys.length) return c[key];
  if (frame <= keys[0].frame) return keys[0].value;
  for (let i = 1; i < keys.length; i++)
    if (frame < keys[i].frame) {
      const a = keys[i - 1],
        b = keys[i];
      return a.interpolation === 'hold'
        ? a.value
        : a.value + ((b.value - a.value) * (frame - a.frame)) / (b.frame - a.frame);
    }
  return keys[keys.length - 1].value;
}
export function fadeAt(c: Clip, frame: number) {
  return Math.max(
    0,
    Math.min(1, c.fadeIn ? frame / c.fadeIn : 1, c.fadeOut ? (c.duration - frame) / c.fadeOut : 1),
  );
}
export function evaluatedClip(c: Clip, frame: number): Clip {
  const local = frame - c.start;
  return {
    ...c,
    x: valueAt(c, 'x', local),
    y: valueAt(c, 'y', local),
    scale: valueAt(c, 'scale', local),
    opacity: valueAt(c, 'opacity', local) * fadeAt(c, local),
  };
}
export function expression(c: Clip, key: AnimatedProperty, variable: string): string {
  const keys = (c.keyframes || [])
    .filter((k) => k.property === key)
    .sort((a, b) => a.frame - b.frame);
  if (!keys.length) return String(c[key]);
  let result = String(keys.at(-1)!.value);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i],
      b = keys[i + 1];
    const v =
      a.interpolation === 'hold'
        ? `${a.value}`
        : `(${a.value}+(${b.value - a.value})*(${variable}-${a.frame})/${b.frame - a.frame})`;
    result = `if(lt(${variable},${b.frame}),${v},${result})`;
  }
  return `if(lt(${variable},${keys[0].frame}),${keys[0].value},${result})`;
}
export function atempo(speed: number) {
  const parts: number[] = [];
  while (speed > 2) {
    parts.push(2);
    speed /= 2;
  }
  while (speed < 0.5) {
    parts.push(0.5);
    speed /= 0.5;
  }
  parts.push(speed);
  return parts.map((n) => `atempo=${n}`).join(',');
}
export function changeSpeed(p: Project, id: string, speed: number): Project {
  return {
    ...p,
    version: 2,
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (c.id !== id) return c;
        const duration = Math.max(1, Math.floor((c.duration * (c.speed || 1)) / speed));
        return {
          ...c,
          speed,
          duration,
          fadeIn: Math.min(c.fadeIn || 0, duration),
          fadeOut: Math.min(c.fadeOut || 0, duration),
          keyframes: (c.keyframes || []).filter((k) => k.frame < duration),
        };
      }),
    })),
  };
}

/** Dissolve into the next clip using its source head handles; timeline end stays fixed. */
export function dissolve(p: Project, id: string, frames: number): Project {
  const track = p.tracks.find((t) => t.clips.some((c) => c.id === id));
  const first = track?.clips.find((c) => c.id === id);
  if (!first || !track || !['video', 'image'].includes(track.kind))
    throw new Error('请选择视频或图片片段');
  const second = track.clips.find((c) => c.start === first.start + first.duration);
  if (!second) throw new Error('同轨需要紧接着的下一个片段');
  if (
    !Number.isInteger(frames) ||
    frames < 1 ||
    frames > first.duration ||
    frames > second.duration
  )
    throw new Error('转场长度超过相邻片段时长');
  if (
    first.keyframes?.length ||
    second.keyframes?.length ||
    first.fadeIn ||
    first.fadeOut ||
    second.fadeIn ||
    second.fadeOut
  )
    throw new Error('请先清除相邻片段的关键帧和淡入淡出');
  const handles = Math.round(frames * (second.speed || 1));
  if (track.kind === 'video' && second.in < handles)
    throw new Error(`下一片段需至少 ${handles} 帧源入点余量，请先裁剪其开头`);
  const moved = {
    ...second,
    start: second.start - frames,
    duration: second.duration + frames,
    in: track.kind === 'image' ? second.in : second.in - handles,
    fadeIn: frames,
  };
  return {
    ...p,
    version: 2,
    tracks: [
      {
        id: crypto.randomUUID(),
        name: '交叉溶解',
        kind: track.kind,
        muted: track.muted,
        clips: [moved],
      },
      ...p.tracks.map((t) => ({
        ...t,
        clips: t.clips
          .filter((c) => c.id !== second.id)
          .map((c) => (c.id === id ? { ...c, audioFadeOut: frames } : c)),
      })),
    ],
  };
}
