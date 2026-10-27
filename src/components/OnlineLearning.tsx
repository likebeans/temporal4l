import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Code2, ExternalLink, RotateCcw, Waypoints } from 'lucide-react';
import { LEARNING_TOPICS, type LearningTopicId } from '../learning-catalog';
import { WALKTHROUGHS } from '../online-lessons';
import type { SourceExcerpt } from '../source-excerpts';
import { LearningPractice } from './LearningPractice';

const repository = 'https://github.com/likebeans/temporal4l';
const documents = [
  ['五阶段学习路径', '从正常订单到恢复、幂等、心跳与消息。', 'docs/learning-path.md'],
  ['执行流程与架构', '理解 API、Server、Worker、Workflow 和 Activity。', 'docs/temporal-execution-flow.md'],
  ['真实恢复实验', '准备本地环境，用同一个 Run 的证据验证恢复。', 'docs/worker-recovery-guide.md'],
  ['Signal / Update / Query', '区分收件、业务结果与执行完成。', 'docs/signal-update-comparison.md'],
  ['幂等、心跳与补偿', '观察未知结果、重试与清理的边界。', 'docs/reliability-experiments.md'],
  ['资料审核迁移练习', '独立设计一个流程，再对照参考实现。', 'exercises/01-transfer/01.01-document-review/problem/readme.md'],
];

export default function OnlineLearning() {
  const [scenarioId, setScenarioId] = useState('normal');
  const [stepIndex, setStepIndex] = useState(0);
  const [topicId, setTopicId] = useState<LearningTopicId>('execution');
  const [sources, setSources] = useState<Record<LearningTopicId, SourceExcerpt[]> | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const [copied, setCopied] = useState('');
  const scenario = WALKTHROUGHS.find((item) => item.id === scenarioId)!;
  const step = scenario.steps[stepIndex];
  const topic = LEARNING_TOPICS.find((item) => item.id === topicId)!;
  const commands = 'git clone https://github.com/likebeans/temporal4l.git\ncd temporal4l\nnpm ci\nnpm run temporal:local';

  useEffect(() => {
    document.title = 'Temporal4L · 在线学习 Temporal';
    let disposed = false;
    void import('../learning-sources').then(
      (module) => { if (!disposed) setSources(module.learningSources); },
      () => { if (!disposed) setSourceError(true); },
    );
    return () => { disposed = true; };
  }, []);

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(commands);
      setCopied('启动命令已复制。Temporal 就绪后，在另一个终端运行 npm run dev。');
    } catch {
      setCopied('无法访问剪贴板，请选中下方命令复制。');
    }
  }

  return (
    <div className="app-shell online-learning">
      <header className="topbar">
        <div className="topbar__inner">
          <a className="brand" href="#main-content"><span className="brand__mark" aria-hidden="true"><Waypoints size={21} /></span><span className="brand__copy"><strong>Temporal4L</strong><span>Learn durable execution</span></span></a>
          <nav className="online-nav" aria-label="学习导航">
            <a href="#walkthrough">机制演示</a><a href="#online-source">读源码</a><a href="#learning-practice">自测</a>
            <a href={repository} target="_blank" rel="noreferrer">GitHub <ExternalLink size={14} aria-hidden="true" /></a>
          </nav>
        </div>
      </header>
      <main id="main-content" className="page-shell" tabIndex={-1}>
        <section className="page-intro" aria-labelledby="online-title">
          <div>
            <p className="eyebrow"><BookOpen size={14} aria-hidden="true" /> Online learning companion</p>
            <h1 id="online-title">从一次等待，<br />理解持久化执行。</h1>
            <p className="page-intro__subtitle">先在浏览器里理解流程、阅读真实源码并写下预测，再用本地 Temporal 实验验证你的解释。</p>
            <div className="online-hero-actions"><a className="online-primary" href="#walkthrough">开始学习 <ArrowRight size={17} aria-hidden="true" /></a><a className="online-secondary" href="#local-lab">运行真实实验</a></div>
          </div>
          <aside className="online-mode-note"><strong>在线学习版</strong><p>此站由 GitHub Pages 托管，没有运行 Temporal 后端。下方逐步演示是教学示意；真实 History、停机恢复和业务账本需在本地实验中取得。</p></aside>
        </section>

        <section className="online-section" id="walkthrough" aria-labelledby="walkthrough-title">
          <div className="online-section-heading"><div><p className="panel__kicker">01 · Follow the mechanism</p><h2 id="walkthrough-title">沿着一条订单，逐步推演</h2></div><span className="online-badge">教学示意 · 非真实运行</span></div>
          <fieldset className="online-scenarios"><legend>选择要理解的机制</legend><div>{WALKTHROUGHS.map((item) => <label key={item.id}><input type="radio" name="walkthrough" value={item.id} checked={scenarioId === item.id} onChange={() => { setScenarioId(item.id); setStepIndex(0); }} /><span>{item.title}</span></label>)}</div></fieldset>
          <p className="online-question">{scenario.question}</p>
          <div className="online-walkthrough">
            <ol className="online-steps" aria-label="教学步骤">{scenario.steps.map((item, index) => <li key={item.title}><button type="button" aria-current={index === stepIndex ? 'step' : undefined} onClick={() => setStepIndex(index)}><span>{String(index + 1).padStart(2, '0')}</span>{item.title}</button></li>)}</ol>
            <article className="online-step-detail" aria-live="polite" aria-atomic="true">
              <p className="panel__kicker">步骤 {stepIndex + 1} / {scenario.steps.length}</p><h3>{step.title}</h3>
              <dl><div><dt>Temporal Server</dt><dd>{step.server}</dd></div><div><dt>Worker</dt><dd>{step.worker}</dd></div><div><dt>业务效果</dt><dd>{step.effect}</dd></div></dl>
              <p className="online-explanation">{step.explanation}</p>
              <div className="online-step-actions"><button type="button" disabled={stepIndex === 0} onClick={() => setStepIndex((value) => value - 1)}><ArrowLeft size={16} aria-hidden="true" />上一步</button><button type="button" disabled={stepIndex === scenario.steps.length - 1} onClick={() => setStepIndex((value) => value + 1)}>下一步<ArrowRight size={16} aria-hidden="true" /></button><button type="button" onClick={() => setStepIndex(0)}><RotateCcw size={15} aria-hidden="true" />重新推演</button></div>
            </article>
          </div>
          <p className="online-verify"><strong>接下来用真实证据验证：</strong>{scenario.verify} <a href="#local-lab">准备本地实验 →</a></p>
        </section>

        <section className="online-section" id="online-source" aria-labelledby="online-source-title">
          <div className="online-section-heading"><div><p className="panel__kicker">02 · Read the implementation</p><h2 id="online-source-title">读源码，再解释为什么</h2></div><Code2 size={24} aria-hidden="true" /></div>
          <p>以下代码取自本站构建时的项目源码，包含真实文件、符号和行号。线上没有当前 Run，源码内容不代表运行证据。</p>
          <div className="source-topic online-topic"><label htmlFor="online-topic">选择源码主题</label><select id="online-topic" value={topicId} onChange={(event) => setTopicId(event.target.value as LearningTopicId)}>{LEARNING_TOPICS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
          <h3>{topic.question}</h3><p className="online-topic-explanation">{topic.explanation}</p>
          {sources ? sources[topicId].map((excerpt, index) => <details className="source-excerpt" key={`${topicId}-${excerpt.symbol}`} open={index === 0}><summary><span><code>{excerpt.file}</code><span>{excerpt.symbol}</span></span><span>L{excerpt.startLine}–{excerpt.endLine}</span></summary><pre tabIndex={0} aria-label={`${excerpt.symbol} 真实源码`}><code>{excerpt.code.split('\n').map((line, offset) => <span className="source-line" key={offset}><span className="source-line__number" aria-hidden="true">{excerpt.startLine + offset}</span><span>{line || ' '}</span></span>)}</code></pre></details>) : <p role="status">{sourceError ? '源码暂未加载，请从下方仓库入口阅读。' : '正在加载源码…'}</p>}
          <p className="online-verify">{topic.boundary}</p><a className="online-text-link" href={`${repository}/blob/main/docs/source-evidence-guide.md`} target="_blank" rel="noreferrer">阅读完整源码与证据导读 <ExternalLink size={15} aria-hidden="true" /></a>
        </section>

        <section className="online-section" aria-labelledby="online-docs-title"><div className="online-section-heading"><div><p className="panel__kicker">03 · Build your understanding</p><h2 id="online-docs-title">按自己的节奏深入</h2></div></div><div className="online-doc-grid">{documents.map(([title, description, path]) => <a key={path} href={`${repository}/blob/main/${path}`} target="_blank" rel="noreferrer"><h3>{title}<ExternalLink size={15} aria-hidden="true" /></h3><p>{description}</p></a>)}</div></section>

        <LearningPractice />

        <section className="online-section online-local" id="local-lab" aria-labelledby="local-title"><div className="online-section-heading"><div><p className="panel__kicker">04 · Verify with Temporal</p><h2 id="local-title">把预测带到真实实验里</h2></div></div><p>需要 Node.js 22.13+，推荐 Node 24 LTS。原生方式无需 Docker。这里只展示命令，不会从网页执行本机程序。</p><h3>终端 A · 首次安装并启动 Temporal</h3><pre tabIndex={0} aria-label="安装与启动 Temporal 命令"><code>{commands}</code></pre><button className="online-secondary" type="button" onClick={() => void copyCommands()}>复制启动命令</button><p role="status">{copied}</p><h3>终端 B · 在同一仓库目录启动应用</h3><pre tabIndex={0} aria-label="启动本地应用命令"><code>npm run dev</code></pre><p>看到 Temporal 就绪后，在另一个终端运行上面的命令，再打开 <code>http://localhost:5173/</code>。已有环境时复用它，避免重复占用端口。</p><a className="online-text-link" href={`${repository}#快速启动`} target="_blank" rel="noreferrer">完整安装、Docker 方式与排查 <ExternalLink size={15} aria-hidden="true" /></a></section>
      </main>
      <footer className="site-footer"><p><strong>Temporal4L</strong> · 社区学习项目 · MIT</p><p>线上推演帮助理解机制；学习结论仍需真实运行证据。</p></footer>
    </div>
  );
}
