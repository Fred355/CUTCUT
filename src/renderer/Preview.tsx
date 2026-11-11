import { textLines } from '../shared/text';
import { useEffect, useRef } from 'react';
import { activeAt, clipRect, endFrame, sourceFrame, type Project } from '../shared/model';
import type { Bridge } from '../shared/bridge';
type Entry = { element: HTMLVideoElement | HTMLAudioElement | HTMLImageElement; gain?: GainNode };
export function Preview({
  project,
  frame,
  playing,
  onFrame,
  onStop,
  bridge,
}: {
  project: Project;
  frame: number;
  playing: boolean;
  onFrame: (f: number) => void;
  onStop: () => void;
  bridge: Bridge;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    pool = useRef(new Map<string, Entry>()),
    context = useRef<AudioContext | null>(null),
    limiter = useRef<DynamicsCompressorNode | null>(null),
    state = useRef({ project, frame, playing, onFrame, onStop });
  state.current = { project, frame, playing, onFrame, onStop };
  const clock = useRef({ time: 0, frame: 0 });
  useEffect(() => {
    clock.current = { time: performance.now(), frame };
  }, [playing]);
  useEffect(() => {
    const ids = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const [id, e] of pool.current)
      if (!ids.has(id)) {
        if (e.element instanceof HTMLMediaElement) {
          e.element.pause();
          e.element.removeAttribute('src');
          e.element.load();
        }
        e.gain?.disconnect();
        pool.current.delete(id);
      }
  }, [project]);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const s = state.current,
        p = s.project;
      let f = s.frame;
      if (s.playing) {
        f =
          clock.current.frame +
          Math.floor(((performance.now() - clock.current.time) / 1000) * p.fps);
        if (f >= endFrame(p)) {
          f = Math.max(0, endFrame(p) - 1);
          s.onStop();
        }
        if (f !== s.frame) s.onFrame(f);
      }
      const ctx = canvas.current?.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, p.width, p.height);
        const active = new Set<string>();
        for (const t of [...p.tracks].reverse())
          for (const c of t.clips) {
            if (!activeAt(c, f)) continue;
            active.add(c.id);
            ctx.globalAlpha = c.opacity;
            if (t.kind === 'text') {
              ctx.font = `${c.fontSize}px CutcutSans`;
              ctx.fillStyle = c.color;
              ctx.textBaseline = 'alphabetic';
              for (const line of textLines(c, (text) => ctx.measureText(text)))
                ctx.fillText(line.text, line.x, line.y);
              continue;
            }
            const a = p.assets.find((a) => a.id === c.assetId);
            if (!a) continue;
            let entry = pool.current.get(c.id);
            const src = bridge.mediaURL(a.id) + '&v=' + encodeURIComponent(a.path);
            if (entry && entry.element.getAttribute('src') !== src) {
              if (entry.element instanceof HTMLMediaElement) entry.element.pause();
              entry.gain?.disconnect();
              pool.current.delete(c.id);
              entry = undefined;
            }
            if (!entry) {
              const element =
                a.kind === 'image'
                  ? new Image()
                  : document.createElement(a.kind === 'audio' ? 'audio' : 'video');
              element.crossOrigin = 'anonymous';
              element.src = src;
              if (element instanceof HTMLMediaElement) {
                element.preload = 'auto';
                if (element instanceof HTMLVideoElement) element.playsInline = true;
              }
              entry = { element };
              pool.current.set(c.id, entry);
            }
            const el = entry.element;
            if (el instanceof HTMLMediaElement) {
              if (s.playing && !context.current) {
                context.current = new AudioContext();
                limiter.current = context.current.createDynamicsCompressor();
                limiter.current.threshold.value = -0.5;
                limiter.current.knee.value = 0;
                limiter.current.ratio.value = 20;
                limiter.current.attack.value = 0.003;
                limiter.current.release.value = 0.1;
                limiter.current.connect(context.current.destination);
              }
              if (context.current && !entry.gain) {
                const source = context.current.createMediaElementSource(el);
                entry.gain = context.current.createGain();
                source.connect(entry.gain);
                entry.gain.connect(limiter.current!);
              }
              if (entry.gain) entry.gain.gain.value = c.muted || t.muted ? 0 : c.volume;
              const time = sourceFrame(c, f) / p.fps;
              if (el.readyState >= 1 && Math.abs(el.currentTime - time) > (s.playing ? 0.12 : 0.01))
                el.currentTime = time;
              if (s.playing) {
                if (context.current?.state === 'suspended') void context.current.resume();
                if (el.paused) void el.play().catch(() => {});
              } else el.pause();
            }
            if (a.kind !== 'audio') {
              const r = clipRect(p, a, c);
              try {
                ctx.drawImage(
                  el as HTMLVideoElement | HTMLImageElement,
                  r.x,
                  r.y,
                  r.width,
                  r.height,
                );
              } catch {}
            }
          }
        ctx.globalAlpha = 1;
        for (const [id, e] of pool.current)
          if (!active.has(id) && e.element instanceof HTMLMediaElement) e.element.pause();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      for (const entry of pool.current.values())
        if (entry.element instanceof HTMLMediaElement) entry.element.pause();
      void context.current?.close();
      pool.current.clear();
      context.current = null;
    };
  }, [bridge, project.id]);
  return (
    <canvas ref={canvas} width={project.width} height={project.height} aria-label="工程合成预览" />
  );
}
