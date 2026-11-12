import type { RoutePreview } from '../shared/services';
import { useEffect, useState } from 'react';
import type { Project } from '../shared/model';
import {
  addSubtitles,
  splitAtSentences,
  sentenceCuts,
  transcriptSRT,
  type AIJob,
  type Transcript,
} from '../shared/studio';
import type { Opened } from '../shared/bridge';
export function AIPanel({
  project,
  selected,
  onCommit,
  onOpen,
  onClose,
  onSeek,
}: {
  project: Project;
  selected: string;
  onCommit: (p: Project) => void;
  onOpen: (p: Opened | null) => void;
  onClose: () => void;
  onSeek: (frame: number) => void;
}) {
  const api = window.cutcut!;
  const [ids, setIds] = useState<string[]>(project.assets.slice(0, 8).map((a) => a.id));
  const [prompt, setPrompt] = useState('根据素材剪出一段连贯的视频，保留原声。');
  const [seconds, setSeconds] = useState(30),
    [portrait, setPortrait] = useState(project.height > project.width),
    [consent, setConsent] = useState(false);
  const [job, setJob] = useState<AIJob | null>(null),
    [notice, setNotice] = useState(''),
    [transcript, setTranscript] = useState<Transcript | null>(null);
  const [targetId, setTargetId] = useState(selected);
  const [route, setRoute] = useState<RoutePreview | null>(null);
  const [pendingKind, setPendingKind] = useState<'roughcut' | 'transcribe'>('roughcut');
  useEffect(() => {
    setRoute(null);
    setConsent(false);
  }, [ids, prompt, seconds, portrait]);
  const active = job?.status === 'running';
  useEffect(() => {
    const timer = setInterval(() => {
      void api
        .aiStatus()
        .then((j) => {
          if (j?.projectId === project.id) {
            setJob(j);
            if (j.status === 'done' && j.result?.transcript)
              setTranscript((t) => t || j.result!.transcript!);
          }
        })
        .catch((e) => setNotice(String(e)));
    }, 700);
    return () => clearInterval(timer);
  }, [project.id]);
  const execute = async (fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const start = (kind: 'roughcut' | 'transcribe') =>
    execute(async () => {
      const next = await api.aiRoute({ project, kind, assetIds: ids });
      if (!route || route.revision !== next.revision || route.kind !== kind) {
        setRoute(next);
        setPendingKind(kind);
        setConsent(false);
        setNotice('请检查任务去向，再点击确认启动');
        return;
      }
      if (next.requiresCloudConsent && !consent) throw new Error('请确认云端阶段的数据上传');
      setTranscript(null);
      setNotice('');
      setJob(
        await api.aiStart({
          project,
          kind,
          assetIds: ids,
          prompt,
          targetSeconds: seconds,
          portrait,
          cloudConsent: consent,
          routeRevision: route.revision,
        }),
      );
    });
  const selectedClip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === targetId);
  const readyTranscript = async () => {
    if (!transcript || !selectedClip || selectedClip.assetId !== transcript.assetId)
      throw new Error('请在时间线选中对应素材的片段');
    await api.aiCheck(job!.id, project);
    return transcript;
  };
  return (
    <div className="modal-backdrop">
      <section className="settings-card ai-panel" role="dialog" aria-label="AI 剪辑">
        <div className="section-title">
          <h2>AI 剪辑与转写</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        <p>
          初剪分析最多 8
          份素材，每段视频抽取首／中／尾代表帧。当前不做完整视频或语音内容分析；语音请单独转写。
        </p>
        <div className="ai-assets">
          {project.assets.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={ids.includes(a.id)}
                disabled={active}
                onChange={(e) =>
                  setIds(e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id))
                }
              />
              {a.name} · {a.kind}
            </label>
          ))}
        </div>
        <textarea
          aria-label="剪辑要求"
          value={prompt}
          disabled={active}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
        <div className="model-row">
          <label>
            目标秒数{' '}
            <input
              aria-label="初剪目标秒数"
              type="number"
              min={1}
              max={3600}
              value={seconds}
              onChange={(e) => setSeconds(+e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={portrait}
              onChange={(e) => setPortrait(e.target.checked)}
            />
            竖屏
          </label>
        </div>
        {route && (
          <section className="notice">
            <h3>本次任务去向</h3>
            {route.destinations.map((d) => (
              <p key={d.role}>
                {d.name} · {d.kind === 'local' ? '本机' : '云端'} · {d.endpoint}
                <br />
                {d.model}：{d.content}
              </p>
            ))}
            {route.requiresCloudConsent ? (
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                允许本次任务将列出的内容发送到上述云端服务，可能产生费用。
              </label>
            ) : (
              <p>本次任务仅调用本机服务，无云端阶段。</p>
            )}
            <button
              disabled={active || (route.requiresCloudConsent && !consent)}
              onClick={() => void start(pendingKind)}
            >
              确认启动任务
            </button>
          </section>
        )}
        <div className="model-row">
          <button
            className="primary"
            disabled={active || !ids.length || ids.length > 8}
            onClick={() => void start('roughcut')}
          >
            生成初剪方案
          </button>
          <button disabled={active || ids.length !== 1} onClick={() => void start('transcribe')}>
            语音转文字
          </button>
          {active && <button onClick={() => void execute(() => api.aiCancel())}>取消任务</button>}
        </div>
        {job && (
          <section className="notice">
            <strong>
              {job.stage} · {job.status}
            </strong>
            <progress value={job.progress} max={1} />
            <p>
              模型步骤 {job.calls} · 已报告输入{' '}
              {job.usage?.some((u) => u.input !== null) ? job.inputTokens : '未提供'} / 输出{' '}
              {job.usage?.some((u) => u.output !== null) ? job.outputTokens : '未提供'}{' '}
              tokens（服务未报告时不计入；语音按时长计费）
            </p>
            {job.usage?.map((u, i) => (
              <p key={i}>
                步骤 {i + 1} · {u.kind === 'local' ? '本地' : '云端'} · 输入 {u.input ?? '未提供'} /
                输出 {u.output ?? '未提供'} tokens
              </p>
            ))}
            <p>
              本地推理也消耗计算资源。本地请求不自动重试；云端每步最多重试 2 次。未接入货币预算。
            </p>
            <p>取消会断开请求并停止后续步骤，不保证外部服务已停止计算或释放模型内存。</p>
            {job.message && <p role="alert">{job.message}</p>}
          </section>
        )}
        {job?.status === 'done' && job.result?.proposal && (
          <section>
            <h3>{job.result.proposal.title}</h3>
            <p>{job.result.proposal.summary}</p>
            <ul>
              {job.result.coverage?.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <ol>
              {job.result.proposal.clips.map((c, i) => (
                <li key={i}>
                  {project.assets.find((a) => a.id === c.assetId)?.name} · 源 {c.in} 帧 · 时间线{' '}
                  {c.start}–{c.start + c.duration} 帧 · {c.reason}
                </li>
              ))}
            </ol>
            <button
              className="primary"
              onClick={() =>
                void execute(async () => {
                  const opened = await api.aiApply(job.id, project);
                  if (opened) {
                    onOpen(opened);
                    onClose();
                  }
                })
              }
            >
              应用为独立新工程
            </button>
          </section>
        )}
        {transcript && (
          <section>
            <h3>转写文稿</h3>
            <label>
              操作片段{' '}
              <select
                aria-label="文稿对应片段"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">选择时间线片段</option>
                {project.tracks
                  .flatMap((t) => t.clips)
                  .filter((c) => c.assetId === transcript.assetId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {(c.start / 30).toFixed(1)}s 起 · {(c.duration / 30).toFixed(1)}s 长
                    </option>
                  ))}
              </select>
            </label>
            {!transcript.segments.length && <p>未识别到语音。</p>}
            {transcript.segments.map((s, i) => (
              <div className="model-row" key={s.id}>
                <button
                  onClick={() => {
                    if (selectedClip?.assetId === transcript.assetId)
                      onSeek(
                        Math.max(
                          selectedClip.start,
                          selectedClip.start +
                            Math.round(
                              (s.startMs * 0.03 - selectedClip.in) / (selectedClip.speed || 1),
                            ),
                        ),
                      );
                  }}
                >
                  {(s.startMs / 1000).toFixed(1)}s
                </button>
                <input
                  aria-label={`语句 ${i + 1}`}
                  value={s.text}
                  onChange={(e) =>
                    setTranscript({
                      ...transcript,
                      segments: transcript.segments.map((v, n) =>
                        n === i ? { ...v, text: e.target.value } : v,
                      ),
                    })
                  }
                />
              </div>
            ))}
            <div className="model-row">
              <button onClick={() => void execute(() => api.aiTranscript(job!.id, transcript))}>
                保存文稿
              </button>
              <button
                onClick={() =>
                  void execute(async () => {
                    onCommit(addSubtitles(project, await readyTranscript(), [targetId]));
                    onClose();
                  })
                }
              >
                为选中片段生成字幕
              </button>
              <button
                onClick={() =>
                  void execute(async () => {
                    const t = await readyTranscript();
                    onCommit(splitAtSentences(project, targetId, sentenceCuts(t, selectedClip!)));
                    onClose();
                  })
                }
              >
                选中片段按句切分
              </button>
              <button
                onClick={() =>
                  void execute(async () => {
                    const t = await readyTranscript();
                    await api.exportSRT(transcriptSRT(project, t, [targetId]));
                  })
                }
              >
                导出选中片段 SRT
              </button>
            </div>
            <p>
              按识别语句起点拆分，保留原声、停顿和顺序；时间戳为识别估计值。当前转写可能将长句分成多个语段。
            </p>
          </section>
        )}
        {notice && <p role="alert">{notice}</p>}
      </section>
    </div>
  );
}
