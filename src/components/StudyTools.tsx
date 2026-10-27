import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Code2, RotateCcw, Server, Terminal, Wallet } from 'lucide-react';
import { LEARNING_TOPICS, type LearningTopicId } from '../learning-catalog';
import { WALKTHROUGHS } from '../online-lessons';
import { studyHref } from '../course';
import type { SourceExcerpt } from '../source-excerpts';

export function WalkthroughTool({ chapter }: { chapter: string }) {
  const [scenarioId, setScenarioId] = useState(chapter === 'recovery' ? 'recovery' : chapter === 'reliability' ? 'idempotency' : 'normal');
  const [stepIndex, setStepIndex] = useState(0);
  const scenario = WALKTHROUGHS.find((item) => item.id === scenarioId)!;
  const step = scenario.steps[stepIndex];
  return <section className="study-tool" aria-labelledby="walkthrough-title">
    <div className="study-tool-heading"><div><span className="study-overline">INTERACTIVE WALKTHROUGH</span><h2 id="walkthrough-title">把执行过程，一步步拆开看</h2></div><span className="study-tag">教学示意 · 非真实运行</span></div>
    <p className="study-description">这里没有运行 Temporal 后端。切换步骤，观察同一时刻 Server、Worker 和业务系统各自负责什么。</p>
    <fieldset className="online-scenarios"><legend>选择要理解的机制</legend><div>{WALKTHROUGHS.map((item, index) => <label key={item.id}><input type="radio" name="walkthrough" value={item.id} checked={scenarioId === item.id} onChange={() => { setScenarioId(item.id); setStepIndex(0); }} /><span><small>场景 0{index + 1}</small>{item.title}</span></label>)}</div></fieldset>
    <p className="online-question">{scenario.question}</p>
    <div className="online-walkthrough">
      <ol className="online-steps" aria-label="教学步骤">{scenario.steps.map((item, index) => <li key={item.title}><button type="button" aria-current={index === stepIndex ? 'step' : undefined} onClick={() => setStepIndex(index)}><span>{String(index + 1).padStart(2, '0')}</span>{item.title}</button></li>)}</ol>
      <article className="online-step-detail" aria-live="polite" aria-atomic="true">
        <span className="study-overline">STEP {String(stepIndex + 1).padStart(2, '0')} / {String(scenario.steps.length).padStart(2, '0')}</span><h3>{step.title}</h3>
        <dl><div><dt><Server size={17} aria-hidden="true" />Temporal Server</dt><dd>{step.server}</dd></div><div><dt><Terminal size={17} aria-hidden="true" />Worker</dt><dd>{step.worker}</dd></div><div><dt><Wallet size={17} aria-hidden="true" />业务效果</dt><dd>{step.effect}</dd></div></dl>
        <p className="online-explanation">{step.explanation}</p>
        <div className="online-step-actions"><button type="button" disabled={stepIndex === 0} onClick={() => setStepIndex((value) => value - 1)}><ArrowLeft size={16} aria-hidden="true" />上一步</button><button type="button" disabled={stepIndex === scenario.steps.length - 1} onClick={() => setStepIndex((value) => value + 1)}>下一步<ArrowRight size={16} aria-hidden="true" /></button><button type="button" onClick={() => setStepIndex(0)}><RotateCcw size={15} aria-hidden="true" />重新推演</button></div>
      </article>
    </div>
    <aside className="study-callout"><strong>带着这个问题去做实验</strong><p>{scenario.verify}</p><a href={studyHref('setup', chapter)}>准备本地实验 <ArrowRight size={14} aria-hidden="true" /></a></aside>
  </section>;
}

export function SourceTool({ initialTopic, chapter }: { initialTopic: LearningTopicId; chapter: string }) {
  const [topicId, setTopicId] = useState(initialTopic);
  const [sources, setSources] = useState<Record<LearningTopicId, SourceExcerpt[]> | null>(null);
  const [sourceError, setSourceError] = useState(false);
  const topic = LEARNING_TOPICS.find((item) => item.id === topicId)!;
  useEffect(() => {
    let disposed = false;
    void import('../learning-sources').then(
      (module) => { if (!disposed) setSources(module.learningSources); },
      () => { if (!disposed) setSourceError(true); },
    );
    return () => { disposed = true; };
  }, []);
  return <section className="study-tool" id="online-source" aria-labelledby="online-source-title">
    <div className="study-tool-heading"><div><span className="study-overline">READ THE IMPLEMENTATION</span><h2 id="online-source-title">让概念落到真实代码上</h2></div><Code2 size={24} aria-hidden="true" /></div>
    <p className="study-description">本站构建时的真实源码，保留文件、符号和行号。选择一个问题，沿着调用关系阅读。</p>
    <div className="source-topic online-topic"><label htmlFor="online-topic">选择源码主题</label><select id="online-topic" value={topicId} onChange={(event) => setTopicId(event.target.value as LearningTopicId)}>{LEARNING_TOPICS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
    <h3>{topic.question}</h3><p className="online-topic-explanation">{topic.explanation}</p>
    {sources ? sources[topicId].map((excerpt, index) => <details className="source-excerpt" key={`${topicId}-${excerpt.symbol}`} open={index === 0}><summary><span><code>{excerpt.file}</code><span>{excerpt.symbol}</span></span><span>L{excerpt.startLine}–{excerpt.endLine}</span></summary><pre tabIndex={0} aria-label={`${excerpt.symbol} 真实源码`}><code>{excerpt.code.split('\n').map((line, offset) => <span className="source-line" key={offset}><span className="source-line__number" aria-hidden="true">{excerpt.startLine + offset}</span><span>{line || ' '}</span></span>)}</code></pre></details>) : <p role="status">{sourceError ? '源码暂未加载，请刷新重试或从 GitHub 阅读。' : '正在加载源码…'}</p>}
    <aside className="study-callout"><strong>解释时，留意这个边界</strong><p>{topic.boundary}</p><a href={studyHref('read', 'evidence')}>阅读源码与证据导读 <ArrowRight size={14} aria-hidden="true" /></a></aside>
    <a className="study-text-link" href={studyHref('read', chapter)}>返回本章正文</a>
  </section>;
}
