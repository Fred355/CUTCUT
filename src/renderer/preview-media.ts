import { fadeAt } from '../shared/effects';
import { activeAt, sourceFrame, type Project, type Asset, type Clip } from '../shared/model';
import type { Bridge } from '../shared/bridge';

type Entry = {
  element: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  url: string;
  active: boolean;
  needsSeek: boolean;
  pausedFrame?: number;
  pausedSource?: number;
  pendingPlay: boolean;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
};
/** One media element and one audio source per clip, retained across pause/seek/resume. */
export class PreviewMedia {
  private entries = new Map<string, Entry>();
  private context?: AudioContext;
  private limiter?: DynamicsCompressorNode;
  private reported = new Set<string>();
  private disposed = false;
  constructor(
    private bridge: Bridge,
    private host: HTMLElement,
    private onError: (message: string) => void,
  ) {}
  async activateAudio() {
    if (!this.context || this.context.state === 'closed') {
      this.context = new AudioContext();
      this.limiter = this.context.createDynamicsCompressor();
      this.limiter.threshold.value = -0.5;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;
      this.limiter.connect(this.context.destination);
    }
    // Called directly by the play button/keyboard gesture, rather than inside requestAnimationFrame.
    if (this.context.state !== 'running') await this.context.resume();
  }
  private report(key: string, message: string) {
    if (this.disposed || this.reported.has(key)) return;
    this.reported.add(key);
    this.onError(message);
  }
  private remove(id: string, e: Entry) {
    if (e.element instanceof HTMLMediaElement) {
      e.element.pause();
      e.element.removeAttribute('src');
      e.element.load();
    }
    e.source?.disconnect();
    e.gain?.disconnect();
    e.element.remove();
    this.entries.delete(id);
  }
  private get(c: Clip, a: Asset) {
    const url = this.bridge.mediaURL(a.id) + '&v=' + encodeURIComponent(a.path);
    let entry = this.entries.get(c.id);
    if (entry && entry.url !== url) {
      this.remove(c.id, entry);
      entry = undefined;
    }
    if (!entry) {
      const el =
        a.kind === 'image'
          ? new Image()
          : document.createElement(a.kind === 'audio' ? 'audio' : 'video');
      el.crossOrigin = 'anonymous';
      entry = { element: el, url, active: false, needsSeek: true, pendingPlay: false };
      el.addEventListener('error', () =>
        this.report(
          url,
          `预览无法读取“${a.name}”${el instanceof HTMLMediaElement ? `（媒体错误 ${el.error?.code ?? '未知'}）` : ''}，请重新导入该素材。`,
        ),
      );
      if (el instanceof HTMLMediaElement) {
        el.preload = 'auto';
        if (el instanceof HTMLVideoElement) el.playsInline = true;
      }
      el.src = url;
      this.host.appendChild(el);
      this.entries.set(c.id, entry);
    }
    return entry;
  }
  sync(p: Project, frame: number, playing: boolean) {
    const active = new Set<string>(),
      keep = new Set<string>();
    let ready = true;
    for (const track of p.tracks)
      for (const clip of track.clips) {
        const a = p.assets.find((a) => a.id === clip.assetId);
        if (!a) continue;
        const now = activeAt(clip, frame);
        if (!now && (clip.start > frame + 30 || clip.start + clip.duration < frame - 120)) continue;
        keep.add(clip.id);
        const entry = this.get(clip, a),
          el = entry.element;
        if (!now) continue;
        active.add(clip.id);
        if (el instanceof HTMLImageElement) {
          ready = ready && el.complete && el.naturalWidth > 0;
          entry.active = true;
          continue;
        }
        el.playbackRate = clip.speed || 1;
        el.preservesPitch = true;
        if (!playing) el.pause();
        const target = sourceFrame(clip, frame) / p.fps;
        const needsSeek =
          entry.needsSeek ||
          !entry.active ||
          (!playing && (entry.pausedFrame !== frame || entry.pausedSource !== target)) ||
          (playing && Math.abs(el.currentTime - target) > 0.3);
        if (needsSeek && el.readyState >= 1 && !el.seeking) {
          if (Math.abs(el.currentTime - target) > 0.5 / p.fps) el.currentTime = target;
          entry.needsSeek = false;
          entry.pausedFrame = playing ? undefined : frame;
          entry.pausedSource = target;
        }
        if (this.context && a.hasAudio) {
          if (!entry.source) {
            entry.source = this.context.createMediaElementSource(el);
            entry.gain = this.context.createGain();
            entry.source.connect(entry.gain);
            entry.gain.connect(this.limiter!);
          }
          entry.gain!.gain.value =
            clip.muted || track.muted
              ? 0
              : clip.volume *
                fadeAt({ ...clip, fadeOut: clip.audioFadeOut || clip.fadeOut }, frame - clip.start);
        }
        const available = el.readyState >= 2 && !el.seeking && !entry.needsSeek;
        ready = ready && available;
        if (playing && available && el.paused && !entry.pendingPlay) {
          entry.pendingPlay = true;
          void el
            .play()
            .catch((error) => {
              if (error instanceof DOMException && error.name === 'AbortError') return;
              this.report(
                entry.url + ':play',
                `无法播放“${a.name}”：${error instanceof Error ? error.message : String(error)}`,
              );
            })
            .finally(() => {
              entry.pendingPlay = false;
            });
        }
        entry.active = true;
      }
    for (const [id, e] of this.entries) {
      if (!active.has(id)) {
        if (e.element instanceof HTMLMediaElement) e.element.pause();
        e.active = false;
      }
      if (!keep.has(id)) this.remove(id, e);
    }
    return ready;
  }
  image(id: string) {
    return this.entries.get(id)?.element as HTMLVideoElement | HTMLImageElement | undefined;
  }
  dispose() {
    this.disposed = true;
    for (const [id, e] of this.entries) this.remove(id, e);
    void this.context?.close().catch(() => {});
  }
}
