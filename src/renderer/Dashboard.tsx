import React, { useEffect, useState } from 'react';
import {
  defaultSettings,
  providerNames,
  providers,
  themeNames,
  themes,
  type DashboardData,
  type SettingsView,
  type Settings,
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
    settings: defaultSettings,
    keys: { openai: false, anthropic: false, gemini: false, deepseek: false },
    secureStorage: false,
  });
  const [notice, setNotice] = useState('');
  const [key, setKey] = useState('');
  const [provider, setProvider] = useState<(typeof providers)[number]>('openai');
  const [filter, setFilter] = useState('');
  useEffect(() => {
    void Promise.all([window.cutcut?.dashboard(), window.cutcut?.settings()])
      .then(([d, s]) => {
        if (d) setData(d);
        if (s) setView(s);
      })
      .catch((e) => setNotice(String(e)));
  }, []);
  const update = async (settings: Settings) => {
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
            <section className="settings-card">
              <h2>AI 服务</h2>
              <p>高级模型负责规划，低成本模型整理素材。填写厂商提供的模型 ID。</p>
              {(['planner', 'worker', 'vision'] as const).map((role, i) => (
                <div className="model-row" key={role}>
                  <label>{['高级规划', '低成本执行', '视觉分析'][i]}</label>
                  <select
                    aria-label={`${role} 厂商`}
                    value={view.settings[role].provider}
                    onChange={(e) =>
                      void update({
                        ...view.settings,
                        [role]: { ...view.settings[role], provider: e.target.value },
                      })
                    }
                  >
                    {providers
                      .filter((p) => role !== 'vision' || p !== 'deepseek')
                      .map((p) => (
                        <option value={p} key={p}>
                          {providerNames[p]}
                        </option>
                      ))}
                  </select>
                  <input
                    aria-label={`${role} 模型 ID`}
                    placeholder="模型 ID"
                    value={view.settings[role].model}
                    onChange={(e) =>
                      setView({
                        ...view,
                        settings: {
                          ...view.settings,
                          [role]: { ...view.settings[role], model: e.target.value },
                        },
                      })
                    }
                    onBlur={() => void update(view.settings)}
                  />
                  <button
                    onClick={async () => {
                      setNotice('正在测试连接…');
                      try {
                        await window.cutcut?.updateSettings(view.settings);
                        const usage = await window.cutcut?.testModel(role);
                        if (usage)
                          setNotice(
                            `连接成功：文本请求通过，输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} tokens。此测试不验证图片或音频能力。`,
                          );
                      } catch (error) {
                        setNotice(String(error));
                      }
                    }}
                  >
                    测试连接
                  </button>
                </div>
              ))}
              <div className="model-row">
                <select
                  aria-label="密钥厂商"
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as typeof provider);
                    setKey('');
                  }}
                >
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {providerNames[p]}
                      {view.keys[p] ? ' · 已配置' : ''}
                    </option>
                  ))}
                </select>
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="API 密钥"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="输入密钥，仅保存在本机"
                />
                <button
                  disabled={!key.trim()}
                  onClick={() =>
                    void window.cutcut
                      ?.setKey(provider, key)
                      .then((s) => {
                        setView(s);
                        setKey('');
                        setNotice('密钥已保存');
                      })
                      .catch((e) => setNotice(String(e)))
                  }
                >
                  保存密钥
                </button>
                <button
                  onClick={() =>
                    void window.cutcut
                      ?.setKey(provider, '')
                      .then(setView)
                      .catch((e) => setNotice(String(e)))
                  }
                >
                  清除
                </button>
              </div>
              <p>
                {view.secureStorage
                  ? '使用系统保护机制加密保存密钥。'
                  : '此环境无法安全持久保存密钥，仅在本次运行中使用。'}
              </p>
            </section>
            <section className="settings-card">
              <h2>语音识别偏好</h2>
              <select
                aria-label="语音识别方式"
                value={view.settings.speech}
                onChange={(e) =>
                  void update({ ...view.settings, speech: e.target.value as 'local' | 'openai' })
                }
              >
                <option value="local">本地优先 · whisper.cpp</option>
                <option value="openai">OpenAI · whisper-1</option>
              </select>
              <p>本地模型下载和转写任务尚在接入中。</p>
            </section>
            <section className="settings-card">
              <h2>生成工具规划</h2>
              <p>
                制图本地后端：leejet/stable-diffusion.cpp。音乐本地后端：audio.cpp（0xShug0/audio.cpp）。当前优先接入
                API；本地生成引擎尚未安装或启用。
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
                  初剪、转写和按句切分的任务流程正在接入。当前可以配置模型服务，继续使用完整的手动剪辑。
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
