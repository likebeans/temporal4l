import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, BookOpen, Info, LoaderCircle } from 'lucide-react';
import type { ApprovalFeedback } from '../../shared/approval';
import type { OrderDetail } from '../../shared/types';
import { LEARNING_TOPICS, type LearningTopicId } from '../learning-catalog';
import { learningEvidence } from '../learning-evidence';
import type { SourceExcerpt } from '../source-excerpts';
import { formatDateTime } from '../format';

interface SourceEvidencePanelProps {
  detail: OrderDetail | null;
  queryFresh: boolean;
  responseFresh: boolean;
  feedback?: ApprovalFeedback | null;
  onHistoryEvent: (eventId: string) => void;
  sources?: Record<LearningTopicId, SourceExcerpt[]>;
  active?: boolean;
}

const observationLabels = { observed: '已读到', unknown: '待观察 / 未取得', stale: '已过期' };

export function SourceEvidencePanel({ detail, queryFresh, responseFresh, feedback, onHistoryEvent, sources, active = true }: SourceEvidencePanelProps) {
  const [topicId, setTopicId] = useState<LearningTopicId>('execution');
  const [loadedSources, setLoadedSources] = useState(sources);
  const [sourceError, setSourceError] = useState(false);
  const selectId = useId();
  const topic = LEARNING_TOPICS.find((item) => item.id === topicId)!;
  const observations = learningEvidence(topicId, { detail, queryFresh, responseFresh, feedback });

  useEffect(() => {
    if (sources || loadedSources || !active) return;
    let disposed = false;
    void import('../learning-sources').then(
      (module) => { if (!disposed) { setLoadedSources(module.learningSources); setSourceError(false); } },
      () => { if (!disposed) setSourceError(true); },
    );
    return () => { disposed = true; };
  }, [sources, loadedSources, active]);

  const excerpts = (sources ?? loadedSources)?.[topicId];
  return (
    <div className="source-evidence">
      <div className="source-evidence__intro">
        <div>
          <p className="panel__kicker">Trace code with evidence</p>
          <h3>从一次操作追到源码和运行证据</h3>
          <p>先读问题与操作，再对照当前 Run 的记录。“已读到”表示有观测数据，结论需要结合来源和实验条件。</p>
        </div>
        <div className="source-topic">
          <label htmlFor={selectId}>选择观察主题</label>
          <select id={selectId} value={topicId} onChange={(event) => setTopicId(event.target.value as LearningTopicId)}>
            {LEARNING_TOPICS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </div>
      </div>

      <div className="source-question">
        <BookOpen size={19} aria-hidden="true" />
        <div><h4>{topic.question}</h4><p>{topic.action}</p></div>
      </div>

      <div className="source-evidence__columns">
        <section className="source-reading" aria-label="当前源码摘录">
          <h4>1. 找到真实代码</h4>
          <p>以下摘录直接取自当前源码，保留文件、符号与行号。完整调用链按 API → Worker → Workflow → Activity 阅读；概念示意另见“核心代码概念”。</p>
          {sourceError ? (
            <p className="source-unavailable" role="status">源码摘录暂不可用。可在编辑器按下列文件与符号查找，右侧运行证据仍可阅读。{topic.sources.map((source) => ` ${source.file} · ${source.symbol}`).join('；')}</p>
          ) : excerpts ? excerpts.map((excerpt, index) => (
            <details className="source-excerpt" key={`${topic.id}-${excerpt.symbol}`} open={index === 0}>
              <summary>
                <span><code>{excerpt.file}</code><span>{excerpt.symbol}</span></span>
                <span>L{excerpt.startLine}–{excerpt.endLine}</span>
              </summary>
              <pre tabIndex={0} aria-label={`${excerpt.file} ${excerpt.symbol} 真实摘录`}><code>
                {excerpt.code.split('\n').map((line, offset) => (
                  <span className="source-line" key={offset}><span className="source-line__number" aria-hidden="true">{excerpt.startLine + offset}</span><span>{line || ' '}</span></span>
                ))}
              </code></pre>
            </details>
          )) : <p className="source-loading" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />正在读取当前源码摘录…</p>}
        </section>

        <section className="source-observations" aria-label="当前运行证据">
          <h4>2. 对照当前运行</h4>
          {detail ? (
            <div className="source-run">
              <dl>
                <div><dt>Workflow ID</dt><dd><code>{detail.workflowId}</code></dd></div>
                <div><dt>Run ID</dt><dd><code>{detail.runId}</code></dd></div>
                <div><dt>响应观测时间</dt><dd>{formatDateTime(detail.observedAt)}{responseFresh ? '' : ' · 上次响应'}</dd></div>
              </dl>
              {!responseFresh ? <p role="status">详情刷新失败，以下执行状态、History、心跳和账本均为上次响应；旧 Query 也不能代表当前状态。</p>
                : !queryFresh || detail.stateError ? <p role="status">Query 暂不可用或已过期；其他来源是本次响应，不能使用旧业务快照补齐结论。</p>
                  : <p>Describe、Query、History 与账本依次读取，并非原子快照。这里只展示记录，不自动评定实验通过。</p>}
            </div>
          ) : <p className="source-run">选择或创建一条订单后，这里会展示真实观测。源码和原理可先阅读。</p>}
          <ul className="observation-list">
            {observations.map((observation) => (
              <li key={observation.id} data-status={observation.status} data-observation={observation.id}>
                <div className="observation-list__heading"><strong>{observation.source}</strong><span>{observationLabels[observation.status]}</span></div>
                <p className="observation-list__value">{observation.value}</p>
                {observation.result && <pre className="observation-result" tabIndex={0} aria-label="Update handler 返回结果"><code>{JSON.stringify(observation.result, null, 2)}</code></pre>}
                {Boolean(observation.events?.length) && (
                  <ul className="observation-events" aria-label="查看对应 History 事件">
                    {observation.events!.map((event) => (
                      <li key={event.id}><button type="button" onClick={() => onHistoryEvent(event.id)} aria-label={`查看事件 #${event.id} ${event.type}`}>
                        <code>#{event.id}</code><span><span>{event.type}{event.activityType ? ` · ${event.activityType}` : ''}{event.attempt ? ` · attempt ${event.attempt}` : ''}{event.updateId ? ` · ${event.updateId}` : ''}</span>{event.detail && <span className="observation-events__detail">{event.detail}</span>}</span><ArrowUpRight size={14} aria-hidden="true" />
                      </button></li>
                    ))}
                  </ul>
                )}
                <p className="observation-list__note">{observation.note}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="source-interpretation">
        <h4>3. 用机制解释证据</h4>
        <p>{topic.explanation}</p>
        <p><Info size={16} aria-hidden="true" /><span>{topic.boundary}</span></p>
      </div>
    </div>
  );
}
