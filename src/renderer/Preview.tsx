import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { textLines } from '../shared/text';
import { activeAt, clipRect, endFrame, type Clip, type Project } from '../shared/model';
import { visualRect, resizeVisual, type Corner, type Rect } from '../shared/transform';
import type { Bridge } from '../shared/bridge';
import { PreviewMedia } from './preview-media';
export type PreviewHandle = { activateAudio: () => Promise<void> };
type Props = {
  project: Project;
  frame: number;
  playing: boolean;
  onFrame: (frame: number) => void;
  onStop: () => void;
  bridge: Bridge;
  selected: string;
  onSelect: (id: string) => void;
  onTransform: (id: string, patch: Partial<Clip>) => void;
  onError: (message: string) => void;
};
export const Preview = forwardRef<PreviewHandle, Props>(function Preview(props, ref) {
  const { project, frame, playing, bridge, selected } = props;
  const canvas = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null),
    svg = useRef<SVGSVGElement>(null),
    engine = useRef<PreviewMedia | null>(null),
    state = useRef(props);
  state.current = props;
  const [draft, setDraft] = useState<{ id: string; patch: Partial<Clip> } | null>(null),
    draftRef = useRef(draft);
  draftRef.current = draft;
  const gesture = useRef<{
    id: number;
    start: { x: number; y: number };
    clip: Clip;
    rect: Rect;
    corner?: Corner;
    patch: Partial<Clip>;
  } | null>(null);
  const clock = useRef({ time: 0, frame: 0 });
  useImperativeHandle(
    ref,
    () => ({
      activateAudio: async () => {
        await engine.current?.activateAudio();
      },
    }),
    [],
  );
  useEffect(() => {
    clock.current = { time: performance.now(), frame };
  }, [playing]);
  useEffect(() => {
    const media = new PreviewMedia(bridge, host.current!, (message) =>
      state.current.onError(message),
    );
    engine.current = media;
    let raf = 0,
      lastError = '';
    const draw = () => {
      // Schedule first so a failed decode/audio operation cannot permanently kill the preview loop.
      raf = requestAnimationFrame(draw);
      try {
        const s = state.current,
          p = s.project;
        const total = endFrame(p);
        let f = s.frame;
        if (s.playing) {
          f =
            clock.current.frame +
            Math.floor(((performance.now() - clock.current.time) / 1000) * p.fps);
          if (f >= total) {
            f = Math.max(0, total - 1);
            s.onStop();
          }
          if (f !== s.frame) s.onFrame(f);
        }
        const ready = media.sync(p, f, s.playing);
        if (!ready) {
          if (s.playing) clock.current = { time: performance.now(), frame: f };
          return;
        }
        const ctx = canvas.current!.getContext('2d')!;
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, p.width, p.height);
        for (const t of [...p.tracks].reverse())
          for (const original of t.clips) {
            if (!activeAt(original, f)) continue;
            const c =
              draftRef.current?.id === original.id
                ? { ...original, ...draftRef.current.patch }
                : original;
            ctx.globalAlpha = c.opacity;
            if (t.kind === 'text') {
              ctx.font = `${c.fontSize}px CutcutSans`;
              ctx.fillStyle = c.color;
              ctx.textBaseline = 'alphabetic';
              for (const line of textLines(c, (text) => ctx.measureText(text)))
                ctx.fillText(line.text, line.x, line.y);
              continue;
            }
            const a = p.assets.find((a) => a.id === c.assetId),
              image = media.image(c.id);
            if (a && a.kind !== 'audio' && image) {
              const r = clipRect(p, a, c);
              ctx.drawImage(image, r.x, r.y, r.width, r.height);
            }
          }
        ctx.globalAlpha = 1;
      } catch (error) {
        const message = `预览失败：${error instanceof Error ? error.message : String(error)}`;
        if (message !== lastError) {
          lastError = message;
          state.current.onError(message);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      media.dispose();
      engine.current = null;
    };
  }, [bridge, project.id]);
  const measure = (text: string, size: number) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return text.length * size;
    ctx.font = `${size}px CutcutSans`;
    return ctx.measureText(text).width;
  };
  const visuals = project.tracks
    .filter((t) => t.kind !== 'audio')
    .flatMap((t) => t.clips.filter((c) => activeAt(c, frame)))
    .map((c) => (draft?.id === c.id ? { ...c, ...draft.patch } : c));
  const chosen = visuals.find((c) => c.id === selected),
    box = chosen ? visualRect(project, chosen, measure) : null;
  const point = (e: { clientX: number; clientY: number }) => {
    const matrix = svg.current!.getScreenCTM();
    return matrix
      ? new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse())
      : { x: 0, y: 0 };
  };
  const finish = (cancel = false) => {
    const g = gesture.current;
    gesture.current = null;
    setDraft(null);
    if (g && !cancel && Object.keys(g.patch).length) state.current.onTransform(g.clip.id, g.patch);
  };
  return (
    <div className="preview-stage">
      <canvas
        ref={canvas}
        width={project.width}
        height={project.height}
        aria-label="工程合成预览"
      />
      <div className="preview-media" ref={host} aria-hidden="true" />
      <svg
        ref={svg}
        className="preview-transform"
        viewBox={`0 0 ${project.width} ${project.height}`}
        aria-label="预览图层操作区"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const at = point(e),
            corner = (e.target as SVGElement).dataset.corner as Corner | undefined;
          const hit = corner
            ? chosen
            : visuals.find((c) => {
                const r = visualRect(project, c, measure);
                return (
                  r && at.x >= r.x && at.y >= r.y && at.x <= r.x + r.width && at.y <= r.y + r.height
                );
              });
          props.onStop();
          props.onSelect(hit?.id || '');
          if (!hit) return;
          const rect = visualRect(project, hit, measure);
          if (!rect) return;
          gesture.current = {
            id: e.pointerId,
            start: at,
            clip: { ...hit },
            rect,
            corner,
            patch: {},
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => {
          const g = gesture.current;
          if (!g || g.id !== e.pointerId) return;
          const at = point(e);
          g.patch = g.corner
            ? resizeVisual(g.clip, g.rect, g.corner, at)
            : {
                x: Math.max(-8192, Math.min(8192, Math.round(g.clip.x + at.x - g.start.x))),
                y: Math.max(-8192, Math.min(8192, Math.round(g.clip.y + at.y - g.start.y))),
              };
          setDraft({ id: g.clip.id, patch: g.patch });
        }}
        onPointerUp={(e) => {
          if (gesture.current?.id === e.pointerId) finish();
        }}
        onPointerCancel={() => finish(true)}
        onLostPointerCapture={() => {
          if (gesture.current) finish(true);
        }}
      >
        {box && (
          <g>
            <rect
              className="selection-outline"
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              vectorEffect="non-scaling-stroke"
            />
            {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => (
              <rect
                key={corner}
                data-corner={corner}
                className={`resize-handle ${corner}`}
                aria-label={`缩放图层 ${corner}`}
                x={(corner.endsWith('w') ? box.x : box.x + box.width) - 14}
                y={(corner.startsWith('n') ? box.y : box.y + box.height) - 14}
                width={28}
                height={28}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )}
      </svg>
    </div>
  );
});
