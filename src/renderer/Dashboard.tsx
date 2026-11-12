import { ServiceSettings } from './ServiceSettings';
import { defaultServiceSettings, type ServiceSettings as Config } from '../shared/services';
import React, { useEffect, useState } from 'react';
import {
  providers,
  themeNames,
  themes,
  type DashboardData,
  type SettingsView,
} from '../shared/studio';
export function Dashboard({
  onCreate,
  onOpen,
  onRecent,
  onResume,
  hasProject,
}: {
  onCreate: () => void;
  onOpen: () => void;
  onRecent: (id: string) => void;
  onResume: () => void;
  hasProject: boolean;
}) {
  const [page, setPage] = useState('工作台');
  const [data, setData] = useState<DashboardData>({
    projects: [],
    exportsToday: 0,
    assetsCount: 0,
    storagePath: '',
  });
  const [view, setView] = useState<SettingsView>({
    settings: defaultServiceSettings,
    keys: Object.fromEntries(providers.map((p) => [p, false])) as SettingsView['keys'],
    secureStorage: false,
  });
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    void Promise.all([window.cutcut?.dashboard(), window.cutcut?.settings()])
      .then(([d, s]) => {
        if (d) setData(d);
        if (s) setView(s);
      })
      .catch((e) => setNotice(String(e)));
  }, []);
  const update = async (settings: Config) => {
    try {
      const next = await window.cutcut?.updateSettings(settings);
      if (next) {
        setView(next);
        document.documentElement.dataset.theme = next.settings.theme;
      }
    } catch (e) {
      setNotice(String(e));
    }
  };
  return (
    <div className="studio-shell">
      <aside className="studio-sidebar">
        <p className="eyebrow">创作空间</p>
        {['工作台', '视频项目', 'AI 剪辑', '素材库', '软件设置'].map((name, i) => (
          <button
            key={name}
            className={page === name ? 'active' : ''}
            onClick={() => setPage(name)}
          >
            <span>{['⌂', '▣', '✧', '▧', '⚙'][i]}</span>
            {name}
          </button>
        ))}
        <div className="sidebar-separator" />
        {['模板分析', '批量制作'].map((name) => (
          <button key={name} disabled>
            {name}
            <small>即将推出</small>
          </button>
        ))}
        <div className="sidebar-bottom">
          <strong>本地创作 · 自由剪辑</strong>
          <p>工程和原始素材保存在你的电脑上</p>
          {hasProject && <button onClick={onResume}>返回当前剪辑 →</button>}
          <button onClick={() => setPage('软件设置')}>⚙ 软件设置</button>
        </div>
      </aside>
      <main className="studio-main">
        {page === '软件设置' ? (
          <>
            <div className="studio-heading">
              <div>
                <p className="eyebrow">MAKE IT YOURS</p>
                <h1>软件设置</h1>
                <p>让工作空间适合你的创作习惯</p>
              </div>
            </div>
            <section className="settings-card">
              <h2>外观</h2>
              <p>四种配色，立即应用到整个工作空间。</p>
              <div className="theme-grid">
                {themes.map((t) => (
                  <button
                    key={t}
                    className={`theme-choice ${view.settings.theme === t ? 'chosen' : ''}`}
                    onClick={() => void update({ ...view.settings, theme: t })}
                  >
                    <span
                      style={{
                        background: {
                          blue: '#356aff',
                          lime: '#c4f36c',
                          purple: '#a078ed',
                          light: '#edf0f8',
                        }[t],
                      }}
                    />
                    {themeNames[t]}
                    {view.settings.theme === t ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </section>
            <ServiceSettings view={view} onView={setView} />
            <section className="settings-card">
              <h2>生成工具规划</h2>
              <p>
                制图本地后端：leejet/stable-diffusion.cpp。音乐本地后端：audio.cpp（0xShug0/audio.cpp）。本轮仅连接外部聊天与视觉模型服务；图像和音乐生成适配器未接入。
              </p>
            </section>
            <section className="settings-card">
              <h2>本地存储</h2>
              <p>项目素材保存在各自工程文件夹内，设置和最近项目记录保存在：</p>
              <code>{data.storagePath}</code>
            </section>
          </>
        ) : (
          <>
            <div className="studio-heading">
              <div>
                <p className="eyebrow">YOUR FOOTAGE. YOUR STORY.</p>
                <h1>{page === '工作台' ? '你好，创作者' : page}</h1>
                <p>让素材，成为你的作品。每一个好故事，从这里开始。</p>
              </div>
              <div className="hero-orbit">
                ✦<span>▶</span>
              </div>
            </div>
            {page === '工作台' && (
              <>
                <div className="stats-grid">
                  {[
                    ['今日完成导出', data.exportsToday, '份成片'],
                    ['已登记项目', data.projects.length, '个工程'],
                    ['已登记素材', data.assetsCount, '份创作素材'],
                  ].map(([label, value, sub], i) => (
                    <section className="stat-card" key={label}>
                      <span className="stat-icon">{['↗', '▣', '▧'][i]}</span>
                      <div>
                        <p>{label}</p>
                        <strong>{value}</strong>
                        <small>{sub}</small>
                      </div>
                    </section>
                  ))}
                </div>
                <div className="feature-grid">
                  {[
                    ['新建剪辑', '从素材开始，剪出你的故事', '＋'],
                    ['AI 生成初剪', '让真实素材组成可编辑的故事', '✧'],
                    ['语音转文字', '文稿、字幕与时间码', '≋'],
                    ['按句切分', '保留原声，逐句调整', '✂'],
                  ].map(([title, desc, icon], i) => (
                    <section className="feature-card" key={title}>
                      <span>{icon}</span>
                      <h2>{title}</h2>
                      <p>{desc}</p>
                      <button
                        className={i === 0 ? 'primary' : ''}
                        onClick={() => (i === 0 ? onCreate() : setPage('AI 剪辑'))}
                      >
                        {i === 0 ? '开始创作' : '查看功能'} →
                      </button>
                    </section>
                  ))}
                </div>
              </>
            )}
            {page === 'AI 剪辑' ? (
              <section className="settings-card">
                <h2>AI 剪辑工作区</h2>
                <p>
                  先创建或打开工程、导入素材，再点击顶部“AI
                  剪辑”：生成初剪方案、语音转文字、生成字幕或按语句切分。请先配置所需服务和模型。
                </p>
                <button onClick={() => setPage('软件设置')}>配置 AI 服务</button>
                {hasProject && <button onClick={onResume}>进入当前工程</button>}
              </section>
            ) : page === '素材库' ? (
              <>
                <div className="section-title">
                  <h2>工程素材</h2>
                  <select
                    aria-label="按工程筛选"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="">全部工程</option>
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="material-grid">
                  {data.projects
                    .filter((p) => !filter || p.id === filter)
                    .flatMap((p) =>
                      p.assets.map((a) => (
                        <button
                          key={p.id + a.id}
                          className="material-item"
                          onClick={() => onRecent(p.id)}
                        >
                          <span>{a.kind === 'audio' ? '♫' : '▧'}</span>
                          <strong>{a.name}</strong>
                          <small>{p.name}</small>
                        </button>
                      )),
                    )}
                </div>
                {!data.assetsCount && (
                  <div className="studio-empty">创建或打开工程后，在编辑器中导入素材。</div>
                )}
              </>
            ) : (
              <>
                <div className="section-title">
                  <h2>{page === '工作台' ? '最近项目' : '视频项目'}</h2>
                  <button onClick={onOpen}>打开已有工程 ↗</button>
                </div>
                {data.projects.length ? (
                  <div className="project-grid">
                    {data.projects.map((p) => (
                      <article className="project-card" key={p.id}>
                        <button className="project-cover" onClick={() => onRecent(p.id)}>
                          {p.cover ? (
                            <img
                              src={`cutcut-media://cover/${p.id}?v=${encodeURIComponent(p.updatedAt)}`}
                            />
                          ) : (
                            <span>✂</span>
                          )}
                          <small>
                            {p.missing ? '需要重新定位' : p.portrait ? '竖屏工程' : '横屏工程'}
                          </small>
                        </button>
                        <div>
                          <h3>{p.name}</h3>
                          <p>
                            {new Date(p.updatedAt).toLocaleString()} · {p.assets.length} 份素材
                          </p>
                          <button onClick={() => onRecent(p.id)}>
                            {p.missing ? '重新定位' : '继续编辑'}
                          </button>
                          <button
                            title="定位项目文件夹"
                            onClick={() =>
                              void window.cutcut
                                ?.revealProject(p.id)
                                .catch((e) => setNotice(String(e)))
                            }
                          >
                            ↗
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="studio-empty">
                    <span>▣</span>
                    <h2>你的下一部作品，从这里开始</h2>
                    <p>创建工程，或打开已有的 .cutcut 文件。</p>
                    <button className="primary large" onClick={onCreate}>
                      ＋ 创建剪辑工程
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {notice && (
          <div className="notice" role="alert">
            {notice}
          </div>
        )}
      </main>
    </div>
  );
}
