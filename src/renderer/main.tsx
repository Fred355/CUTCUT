import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  changeClip,
  splitClip,
  moveClip,
  createClip,
  createTextClip,
  centerClip,
  endFrame,
  errorMessage,
  projectSchema,
  uid,
  type Project,
  type Clip,
  type Track,
  type Asset,
} from '../shared/model';
import type { Bridge, ExportEvent, Opened } from '../shared/bridge';
import { Preview, type PreviewHandle } from './Preview';
import './style.css';
const api = window.cutcut;
const timecode = (f: number) =>
  `${Math.floor(f / 1800)
    .toString()
    .padStart(
      2,
      '0',
    )}:${Math.floor(f / 30) % 60 < 10 ? '0' : ''}${Math.floor(f / 30) % 60}:${(f % 30).toString().padStart(2, '0')}`;
function App() {
  const [project, setProject] = useState<Project | null>(null),
    [selected, setSelected] = useState(''),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState('所有素材仅在本机处理'),
    [busy, setBusy] = useState(''),
    [missing, setMissing] = useState<string[]>([]),
    [job, setJob] = useState<ExportEvent | null>(null),
    [zoom, setZoom] = useState(2),
    [newDialog, setNewDialog] = useState(false),
    [name, setName] = useState('我的第一支影片'),
    [portrait, setPortrait] = useState(false);
  const preview = useRef<PreviewHandle>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const undo = useRef<Project[]>([]),
    redo = useRef<Project[]>([]),
    revision = useRef(0),
    projectRef = useRef(project);
  projectRef.current = project;
  const commit = useCallback((next: Project) => {
    projectSchema.parse(next);
    if (projectRef.current) {
      undo.current.push(projectRef.current);
      if (undo.current.length > 100) undo.current.shift();
    }
    redo.current = [];
    revision.current++;
    setProject(next);
    setDirty(true);
  }, []);
  const apply = (fn: (p: Project) => Project) => {
    if (!project) return;
    try {
      commit(fn(project));
      setMessage('修改已应用 · 自动恢复草稿将稍后保存');
    } catch (e) {
      setMessage(errorMessage(e));
    }
  };
  const work = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setPlaying(false);
    try {
      await fn();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy('');
    }
  };
  const load = (opened: Opened | null) => {
    if (!opened) return;
    revision.current++;
    setProject(opened.project);
    setMissing(opened.missing);
    setDirty(opened.recovered);
    setFrame(0);
    setSelected('');
    undo.current = [];
    redo.current = [];
    setJob(null);
    setMessage(
      opened.recovered
        ? '已恢复草稿，请保存工程'
        : opened.missing.length
          ? '部分素材缺失，请重新定位'
          : '工程已打开',
    );
  };
  const save = async () => {
    if (!api || !projectRef.current) return;
    const v = revision.current;
    await api.save(projectRef.current);
    if (v === revision.current) setDirty(false);
    setMessage('工程已保存');
  };
  const history = (back: boolean) => {
    const src = back ? undo.current : redo.current,
      dst = back ? redo.current : undo.current;
    const prev = src.pop();
    if (prev && project) {
      dst.push(project);
      setProject({ ...prev, assets: project.assets });
      setDirty(true);
      revision.current++;
    }
  };
  const selectedTrack = project?.tracks.find((t) => t.clips.some((c) => c.id === selected)),
    clip = selectedTrack?.clips.find((c) => c.id === selected),
    asset = project?.assets.find((a) => a.id === clip?.assetId);
  const exporting = job?.status === 'rendering' || job?.status === 'validating';
  const importFiles = (files?: File[]) =>
    api &&
    work('正在复制素材并准备预览…', async () => {
      const result = files ? await api.importDroppedFiles(files) : await api.importAssets();
      if (projectRef.current && result.assets.length)
        commit({ ...projectRef.current, assets: [...projectRef.current.assets, ...result.assets] });
      setMessage(
        result.errors.length
          ? result.errors.join('\n')
          : `已导入 ${result.assets.length} 个素材，拖入轨道开始剪辑`,
      );
    });
  const togglePlayback = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!project || !endFrame(project)) return;
    void preview.current
      ?.activateAudio()
      .then(() => {
        if (frame >= endFrame(project) - 1) setFrame(0);
        setPlaying(true);
      })
      .catch((error) => setMessage(`无法启动音频：${errorMessage(error)}`));
  };
  const addAsset = (a: Asset, trackId?: string, start?: number) => {
    if (!project) return;
    apply((p) => {
      let tracks = structuredClone(p.tracks),
        track = tracks.find((t) => t.id === trackId) || tracks.find((t) => t.kind === a.kind);
      if (!track) {
        track = {
          id: uid(),
          name: `${kindName(a.kind)} ${tracks.filter((t) => t.kind === a.kind).length + 1}`,
          kind: a.kind,
          muted: false,
          clips: [],
        };
        tracks.unshift(track);
      }
      if (track.kind !== a.kind) throw new Error('请拖入相同类型的轨道');
      const at = start ?? Math.max(0, ...track.clips.map((c) => c.start + c.duration));
      let c = createClip(p, a, at);
      if (a.kind !== 'audio') c = centerClip(p, a, c);
      track.clips.push(c);
      setSelected(c.id);
      return { ...p, tracks };
    });
  };
  const addTrack = (kind: Track['kind']) =>
    apply((p) => ({
      ...p,
      tracks: [
        {
          id: uid(),
          name: `${kindName(kind)} ${p.tracks.filter((t) => t.kind === kind).length + 1}`,
          kind,
          muted: false,
          clips: [],
        },
        ...p.tracks,
      ],
    }));
  const addText = () =>
    apply((p) => {
      const c = createTextClip(p, selected, frame),
        tracks = structuredClone(p.tracks);
      let t = tracks.find(
        (t) =>
          t.kind === 'text' &&
          t.clips.every(
            (other) =>
              other.start + other.duration <= c.start || c.start + c.duration <= other.start,
          ),
      );
      if (!t) {
        t = {
          id: uid(),
          name: `文字 ${tracks.filter((t) => t.kind === 'text').length + 1}`,
          kind: 'text',
          muted: false,
          clips: [],
        };
        tracks.unshift(t);
      }
      t.clips.push(c);
      setSelected(c.id);
      return { ...p, tracks };
    });
  const addPictureInPicture = (a: Asset) =>
    apply((p) => {
      const c = { ...createClip(p, a, frame), scale: 0.3 };
      const fit = Math.min(p.width / a.width, p.height / a.height) * c.scale;
      c.x = Math.round(p.width - a.width * fit - 60);
      c.y = Math.round(p.height - a.height * fit - 60);
      setSelected(c.id);
      return {
        ...p,
        tracks: [
          {
            id: uid(),
            name: `画中画 ${p.tracks.length + 1}`,
            kind: a.kind,
            muted: false,
            clips: [c],
          },
          ...p.tracks,
        ],
      };
    });
  const remove = () =>
    apply((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== selected) })),
    }));
  const patch = (value: Partial<Clip>) => apply((p) => changeClip(p, selected, value));
  useEffect(() => {
    api?.setDirty(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!api || !dirty || !project || busy) return;
    const timer = setTimeout(() => {
      void api
        .autosave(project)
        .catch((e) => setMessage(`自动恢复草稿保存失败：${errorMessage(e)}`));
    }, 1200);
    return () => clearTimeout(timer);
  }, [project, dirty, busy]);
  useEffect(
    () =>
      api?.onExport((e) => {
        setJob(e);
        if (e.status === 'done') setMessage(`导出完成：${e.message}`);
        if (e.status === 'error' || e.status === 'cancelled') setMessage(e.message || '导出已取消');
      }),
    [],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (busy) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      )
        return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        void work('正在保存…', save);
      } else if (mod && e.key === 'z') {
        e.preventDefault();
        history(!e.shiftKey);
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (project && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        setPlaying(false);
        setFrame((f) =>
          Math.max(0, Math.min(endFrame(project!), f + (e.key === 'ArrowLeft' ? -1 : 1))),
        );
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selected) {
        e.preventDefault();
        remove();
      } else if (e.key.toLowerCase() === 'b' && selected)
        apply((p) => splitClip(p, selected, frame));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const progressLabel =
    job?.status === 'validating'
      ? '正在验证成片'
      : job?.status === 'rendering'
        ? '正在导出'
        : job?.status === 'done'
          ? '导出完成'
          : '';
  return (
    <div
      className="app"
      data-busy={!!busy}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
    >
      <header>
        <div className="brand">
          <span className="brandmark">✂</span>CUTCUT<span className="badge">DESKTOP EDITOR</span>
        </div>
        <div className="project-title">
          {project?.name || '本地剪辑工作室'}
          {dirty && <i title="未保存"> •</i>}
        </div>
        <div className="header-actions">
          <button onClick={() => setNewDialog(true)} disabled={!!busy || exporting || !api}>
            新建
          </button>
          <button
            onClick={() => api && work('正在打开…', async () => load(await api.open()))}
            disabled={!!busy || exporting || !api}
          >
            打开工程
          </button>
          <button onClick={() => work('正在保存…', save)} disabled={!project || !!busy}>
            保存 <kbd>⌘S</kbd>
          </button>
          <button
            className="primary"
            disabled={!project || !endFrame(project) || !!busy || exporting}
            onClick={() =>
              api &&
              work('选择导出位置…', async () => {
                await api.export(project!);
              })
            }
          >
            ↗ 导出成片
          </button>
        </div>
      </header>
      {!project ? (
        <main className="welcome">
          <div className="welcome-graphic">
            <div></div>
            <div></div>
            <div></div>
            <span>✂</span>
          </div>
          <p className="eyebrow">YOUR FOOTAGE. YOUR STORY.</p>
          <h1>让素材，成为你的作品。</h1>
          <p>
            导入、剪辑、叠加、配乐。
            <br />
            从第一帧到最终成片，都在你的电脑上完成。
          </p>
          <button className="primary large" onClick={() => setNewDialog(true)} disabled={!api}>
            ＋ 创建剪辑工程
          </button>
          <p className="welcome-hint">MP4 / MOV · JPG / PNG · MP3 / WAV / M4A</p>
          {!api && (
            <div className="notice">
              当前为浏览器界面预览。请使用桌面应用启动，以访问本地文件和真实导出。
            </div>
          )}
        </main>
      ) : (
        <>
          <div className="workspace">
            <aside
              className={`library ${draggingFiles ? 'file-drop-active' : ''}`}
              aria-label="素材库"
              onDragEnter={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  setDraggingFiles(true);
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('Files')) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDraggingFiles(false);
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                e.stopPropagation();
                setDraggingFiles(false);
                if (!busy) void importFiles(Array.from(e.dataTransfer.files));
              }}
            >
              {draggingFiles && <div className="file-drop-hint">松开以导入视频、照片或音频</div>}
              <div className="panel-heading">
                <h2>
                  素材库 <span>{project.assets.length}</span>
                </h2>
                <button title="导入素材" onClick={() => void importFiles()} disabled={!!busy}>
                  ＋ 导入
                </button>
              </div>
              <div className="library-sub">支持从 Finder 拖入 · 原始文件保持不变</div>
              <div className="asset-list">
                {project.assets.map((a) => (
                  <div
                    className="asset-card"
                    key={a.id}
                    draggable={!busy}
                    onDragStart={(e) =>
                      e.dataTransfer.setData('application/cutcut', JSON.stringify({ asset: a.id }))
                    }
                  >
                    <div className="asset-thumb">
                      {a.kind === 'audio' ? (
                        <span>♫</span>
                      ) : (
                        <img
                          src={
                            api!.mediaURL(a.id, 'thumbnail') + '&v=' + encodeURIComponent(a.path)
                          }
                          alt=""
                        />
                      )}
                      <small>{a.kind === 'image' ? '照片' : timecode(a.durationFrames)}</small>
                    </div>
                    <div className="asset-info">
                      <strong title={a.name}>{a.name}</strong>
                      <span>
                        {kindName(a.kind)}
                        {a.width ? ` · ${a.width}×${a.height}` : ''}
                      </span>
                    </div>
                    {missing.includes(a.id) ? (
                      <button
                        onClick={() =>
                          work('正在重新定位…', async () => {
                            const next = await api!.relink(a.id);
                            if (next) {
                              commit({
                                ...project,
                                assets: project.assets.map((x) => (x.id === a.id ? next : x)),
                              });
                              setMissing((m) => m.filter((id) => id !== a.id));
                            }
                          })
                        }
                      >
                        重新定位
                      </button>
                    ) : (
                      <>
                        <button title="添加到时间线" onClick={() => addAsset(a)}>
                          ＋
                        </button>
                        {a.kind !== 'audio' && (
                          <button title="添加画中画" onClick={() => addPictureInPicture(a)}>
                            ▣
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
                {!project.assets.length && (
                  <div className="empty-assets">
                    <span>▧</span>
                    <p>故事从这里开始</p>
                    <small>
                      导入视频、照片或声音
                      <br />
                      再拖入下方时间线
                    </small>
                    <button onClick={() => void importFiles()} disabled={!!busy}>
                      选择本地文件
                    </button>
                  </div>
                )}
              </div>
            </aside>
            <section className="viewer">
              <div className="panel-heading">
                <h2>预览</h2>
                <span className="muted">
                  {project.width} × {project.height} <b>·</b> 30 FPS
                </span>
              </div>
              <div className="canvas-area">
                <Preview
                  ref={preview}
                  key={project.id}
                  selected={selected}
                  onSelect={setSelected}
                  onTransform={(id, patch) => apply((p) => changeClip(p, id, patch))}
                  onError={(message) => {
                    setMessage(message);
                    setPlaying(false);
                  }}
                  project={project}
                  frame={frame}
                  playing={playing}
                  onFrame={setFrame}
                  onStop={() => setPlaying(false)}
                  bridge={api!}
                />
                {!endFrame(project) && <div className="canvas-empty">将素材添加至时间线</div>}
              </div>
              <div className="playback">
                <span className="timecode">
                  {timecode(frame)} <em>/ {timecode(endFrame(project))}</em>
                </span>
                <div>
                  <button
                    title="上一帧"
                    onClick={() => {
                      setPlaying(false);
                      setFrame((f) => Math.max(0, f - 1));
                    }}
                  >
                    │◀
                  </button>
                  <button
                    className="play"
                    title={playing ? '暂停' : '播放'}
                    disabled={!endFrame(project)}
                    onClick={togglePlayback}
                  >
                    {playing ? 'Ⅱ' : '▶'}
                  </button>
                  <button
                    title="下一帧"
                    onClick={() => {
                      setPlaying(false);
                      setFrame((f) => Math.min(endFrame(project), f + 1));
                    }}
                  >
                    ▶│
                  </button>
                </div>
                <span className="muted">空格播放 · ← → 逐帧</span>
              </div>
              <input
                className="seek"
                aria-label="播放位置"
                type="range"
                min="0"
                max={Math.max(1, endFrame(project))}
                value={frame}
                onChange={(e) => {
                  setPlaying(false);
                  setFrame(+e.target.value);
                }}
              />
            </section>
            <aside className="inspector">
              <div className="panel-heading">
                <h2>片段属性</h2>
                {clip && <span className="pill">{kindName(selectedTrack!.kind)}</span>}
              </div>
              {clip ? (
                <div className="fields" key={clip.id}>
                  <p className="clip-title">{asset?.name || '文字片段'}</p>
                  <h3>
                    时间 <small>单位：帧 / 30fps</small>
                  </h3>
                  <NumberField
                    label="时间线起点"
                    value={clip.start}
                    min={0}
                    onChange={(n) => patch({ start: n })}
                  />
                  {asset && asset.kind !== 'image' && (
                    <NumberField
                      label="源素材入点"
                      value={clip.in}
                      min={0}
                      onChange={(n) => patch({ in: n })}
                    />
                  )}
                  <NumberField
                    label="持续帧数"
                    value={clip.duration}
                    min={1}
                    onChange={(n) => patch({ duration: n })}
                  />
                  {selectedTrack!.kind !== 'audio' && (
                    <>
                      <h3>画面</h3>
                      <NumberField
                        label="X 位置"
                        value={clip.x}
                        min={-8192}
                        onChange={(n) => patch({ x: n })}
                      />
                      <NumberField
                        label="Y 位置"
                        value={clip.y}
                        min={-8192}
                        onChange={(n) => patch({ y: n })}
                      />
                      {asset && (
                        <>
                          <NumberField
                            label="等比缩放"
                            value={clip.scale}
                            min={0.01}
                            step={0.05}
                            onChange={(n) => patch({ scale: n })}
                          />
                          <button onClick={() => patch(centerClip(project, asset, clip))}>
                            画面居中
                          </button>
                        </>
                      )}
                      <NumberField
                        label="不透明度"
                        value={clip.opacity}
                        min={0}
                        max={1}
                        step={0.05}
                        onChange={(n) => patch({ opacity: n })}
                      />
                    </>
                  )}
                  {selectedTrack!.kind === 'text' && (
                    <>
                      <h3>文字</h3>
                      <button
                        onClick={() =>
                          patch({
                            start: 0,
                            duration: Math.max(
                              1,
                              ...project.tracks
                                .filter((t) => t.kind === 'video')
                                .flatMap((t) => t.clips.map((c) => c.start + c.duration)),
                            ),
                          })
                        }
                      >
                        覆盖视频全程
                      </button>
                      <textarea
                        aria-label="文字内容"
                        value={clip.text}
                        onChange={(e) => {
                          if (e.target.value !== clip.text) patch({ text: e.target.value });
                        }}
                      />
                      <NumberField
                        label="字号"
                        value={clip.fontSize}
                        min={8}
                        max={400}
                        onChange={(n) => patch({ fontSize: n })}
                      />
                      <label>
                        文字颜色
                        <input
                          type="color"
                          value={clip.color}
                          onChange={(e) => patch({ color: e.target.value })}
                        />
                      </label>
                    </>
                  )}
                  {asset?.hasAudio && (
                    <>
                      <h3>声音</h3>
                      <NumberField
                        label="音量"
                        value={clip.volume}
                        min={0}
                        max={2}
                        step={0.1}
                        onChange={(n) => patch({ volume: n })}
                      />
                      <label>
                        片段静音
                        <input
                          type="checkbox"
                          checked={clip.muted}
                          onChange={(e) => patch({ muted: e.target.checked })}
                        />
                      </label>
                    </>
                  )}
                  <button className="danger" onClick={remove}>
                    删除片段
                  </button>
                </div>
              ) : (
                <div className="empty-inspector">
                  <span>⌖</span>
                  <p>选择时间线中的片段</p>
                  <small>调整画面、时长和声音</small>
                </div>
              )}
            </aside>
          </div>
          <section className="timeline">
            <div className="timeline-toolbar">
              <div>
                <button disabled={!undo.current.length} onClick={() => history(true)} title="撤销">
                  ↶
                </button>
                <button disabled={!redo.current.length} onClick={() => history(false)} title="重做">
                  ↷
                </button>
                <span className="divider" />
                <button
                  disabled={!clip}
                  onClick={() => apply((p) => splitClip(p, selected, frame))}
                >
                  ✂ 拆分 <kbd>B</kbd>
                </button>
                <button disabled={!clip} onClick={remove}>
                  删除
                </button>
                <button onClick={addText}>T 添加文字</button>
                <select
                  aria-label="添加轨道"
                  value=""
                  onChange={(e) => addTrack(e.target.value as Track['kind'])}
                >
                  <option value="" disabled>
                    ＋ 添加轨道
                  </option>
                  <option value="video">视频轨道</option>
                  <option value="image">图片轨道</option>
                  <option value="text">文字轨道</option>
                  <option value="audio">音频轨道</option>
                </select>
              </div>
              <label className="zoom">
                −{' '}
                <input
                  aria-label="时间线缩放"
                  type="range"
                  min=".5"
                  max="5"
                  step=".25"
                  value={zoom}
                  onChange={(e) => setZoom(+e.target.value)}
                />{' '}
                ＋
              </label>
            </div>
            <div className="timeline-body">
              <div className="track-labels">
                <div className="track-label-top">
                  轨道 <span>上层覆盖下层</span>
                </div>
                {project.tracks.map((t, i) => (
                  <div
                    key={t.id}
                    className="track-label"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('application/cutcut-track', t.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData('application/cutcut-track');
                      if (id)
                        apply((p) => {
                          const tracks = p.tracks.filter((x) => x.id !== id);
                          tracks.splice(
                            i,
                            0,
                            p.tracks.find((x) => x.id === id)!,
                          );
                          return { ...p, tracks };
                        });
                    }}
                  >
                    <span className={`track-icon ${t.kind}`}>
                      {t.kind === 'text' ? 'T' : t.kind === 'audio' ? '♫' : '▧'}
                    </span>
                    <strong>{t.name}</strong>
                    <button
                      title={t.muted ? '取消轨道静音' : '轨道静音'}
                      onClick={() =>
                        apply((p) => ({
                          ...p,
                          tracks: p.tracks.map((x) =>
                            x.id === t.id ? { ...x, muted: !x.muted } : x,
                          ),
                        }))
                      }
                    >
                      {t.muted ? '⊘' : '♪'}
                    </button>
                    <button
                      title="上移图层"
                      disabled={i === 0}
                      onClick={() =>
                        apply((p) => {
                          const tracks = [...p.tracks];
                          [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]];
                          return { ...p, tracks };
                        })
                      }
                    >
                      ↑
                    </button>
                  </div>
                ))}
              </div>
              <div className="track-scroll">
                <div
                  className="track-content"
                  style={{ width: Math.max(900, (endFrame(project) + 150) * zoom) }}
                >
                  <div
                    className="ruler"
                    onPointerDown={(e) => {
                      setPlaying(false);
                      setFrame(
                        Math.max(
                          0,
                          Math.round(
                            (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom,
                          ),
                        ),
                      );
                    }}
                  >
                    {Array.from(
                      {
                        length: Math.ceil(
                          Math.max(900, (endFrame(project) + 150) * zoom) / (150 * zoom),
                        ),
                      },
                      (_, i) => (
                        <span key={i} style={{ left: i * 150 * zoom }}>
                          {timecode(i * 150)}
                        </span>
                      ),
                    )}
                  </div>
                  {project.tracks.map((t) => (
                    <div
                      key={t.id}
                      className="track-lane"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const raw = e.dataTransfer.getData('application/cutcut');
                        if (!raw) return;
                        try {
                          const d = JSON.parse(raw);
                          const at = Math.max(
                            0,
                            Math.round(
                              (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom,
                            ) - (d.offset || 0),
                          );
                          if (d.asset) {
                            const a = project.assets.find((a) => a.id === d.asset);
                            if (a) addAsset(a, t.id, at);
                          } else if (d.clip) apply((p) => moveClip(p, d.clip, t.id, at));
                        } catch (err) {
                          setMessage(errorMessage(err));
                        }
                      }}
                    >
                      {t.clips.map((c) => (
                        <div
                          key={c.id}
                          className={`timeline-clip ${t.kind} ${selected === c.id ? 'selected' : ''}`}
                          style={{ left: c.start * zoom, width: Math.max(8, c.duration * zoom) }}
                          draggable
                          onDragStart={(e) => {
                            setPlaying(false);
                            e.dataTransfer.setData(
                              'application/cutcut',
                              JSON.stringify({
                                clip: c.id,
                                offset: Math.round(
                                  (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom,
                                ),
                              }),
                            );
                          }}
                          onClick={() => setSelected(c.id)}
                        >
                          <Trim
                            side="left"
                            clip={c}
                            zoom={zoom}
                            onTrim={(patches) => apply((p) => changeClip(p, c.id, patches))}
                            isStatic={t.kind === 'text' || t.kind === 'image'}
                          />
                          <span>
                            {c.text || project.assets.find((a) => a.id === c.assetId)?.name}
                          </span>
                          <small>{timecode(c.duration)}</small>
                          <Trim
                            side="right"
                            clip={c}
                            zoom={zoom}
                            onTrim={(patches) => apply((p) => changeClip(p, c.id, patches))}
                            isStatic={t.kind === 'text' || t.kind === 'image'}
                          />
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="playhead" style={{ left: frame * zoom }}>
                    <i />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
      <footer>
        <span className={message.includes('失败') ? 'error' : ''} role="status">
          {busy || message}
        </span>
        <span>
          {project
            ? `${project.tracks.length} 条轨道 · ${project.assets.length} 个素材`
            : 'LOCAL FIRST'}{' '}
          <b>●</b> {dirty ? '未保存' : '已就绪'}
        </span>
      </footer>
      {exporting && (
        <div className="export-card">
          <strong>
            {progressLabel} <span>{Math.round((job?.progress || 0) * 100)}%</span>
          </strong>
          <progress value={job?.progress || 0} max="1" />
          <p>使用原始素材渲染 · 保持应用打开</p>
          <button onClick={() => void api?.cancelExport()}>取消导出</button>
        </div>
      )}
      {newDialog && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              setNewDialog(false);
              if (api)
                void work('正在创建工程…', async () => load(await api.create(name, portrait)));
            }}
          >
            <p className="eyebrow">NEW PROJECT</p>
            <h2>创建你的剪辑工程</h2>
            <label>
              工程名称
              <input
                autoFocus
                required
                maxLength={150}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              画布
              <select
                value={portrait ? 'portrait' : 'landscape'}
                onChange={(e) => setPortrait(e.target.value === 'portrait')}
              >
                <option value="landscape">横屏 16:9 · 1920 × 1080</option>
                <option value="portrait">竖屏 9:16 · 1080 × 1920</option>
              </select>
            </label>
            <p>
              30fps · 素材将复制到项目文件夹内
              <br />
              下一步选择保存位置
            </p>
            <div>
              <button type="button" onClick={() => setNewDialog(false)}>
                取消
              </button>
              <button className="primary" type="submit">
                创建工程 →
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
function kindName(kind: Track['kind']) {
  return { video: '视频', image: '图片', text: '文字', audio: '音频' }[kind];
}
function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (draft !== '' && Number.isFinite(n) && n !== value) onChange(n);
          setDraft(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}
function Trim({
  side,
  clip,
  zoom,
  onTrim,
  isStatic,
}: {
  side: 'left' | 'right';
  clip: Clip;
  zoom: number;
  onTrim: (p: Partial<Clip>) => void;
  isStatic: boolean;
}) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="slider"
      aria-label={side === 'left' ? '裁剪片段开头' : '裁剪片段结尾'}
      aria-valuenow={side === 'left' ? clip.start : clip.start + clip.duration}
      className={`trim ${side}`}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        start.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        e.stopPropagation();
        if (start.current === null) return;
        const delta = Math.round((e.clientX - start.current) / zoom);
        start.current = null;
        if (delta)
          onTrim(
            side === 'right'
              ? { duration: clip.duration + delta }
              : {
                  start: clip.start + delta,
                  in: isStatic ? clip.in : clip.in + delta,
                  duration: clip.duration - delta,
                },
          );
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
    />
  );
}
createRoot(document.getElementById('root')!).render(<App />);
