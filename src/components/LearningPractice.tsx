import { useId, useState } from 'react';
import { BookOpenCheck, ChevronDown, Download, FilePenLine, FlaskConical } from 'lucide-react';
import { EMPTY_EXPERIMENT_NOTE, SELF_CHECK_QUESTIONS, learningNotesMarkdown, type ExperimentNote } from '../learning-practice';

const noteFields: { key: keyof ExperimentNote; label: string; hint: string; short?: boolean }[] = [
  { key: 'topic', label: '主题 / 场景', hint: '例如：支付幂等、等待时恢复或资料审核。', short: true },
  { key: 'prediction', label: '操作前预测', hint: '先写会发生什么、为什么，以及什么证据会推翻预测。' },
  { key: 'workflowId', label: 'Workflow ID', hint: '粘贴本次执行的完整 Workflow ID。', short: true },
  { key: 'runId', label: 'Run ID', hint: '粘贴同一次 Run 的完整标识。', short: true },
  { key: 'observedAt', label: '观测时间与时区', hint: '注明响应 observedAt、时区；不同时间的观察分别记录。', short: true },
  { key: 'actions', label: '实际操作与时间', hint: '按顺序记录发送消息、停止 / 重启进程等真实操作，不把点击等同于执行事实。' },
  { key: 'evidence', label: '来源、事件 ID 与观测值', hint: '逐条注明 History #ID、Query、Describe 或账本；记录 attempt、Update ID、扣款 / 退款和检查点，标明新鲜或过期。' },
  { key: 'explanation', label: '用机制解释差异', hint: '对照预测说明结果，区分历史结果复用、Activity 新尝试和外部业务效果。' },
  { key: 'limits', label: '缺失证据与结论边界', hint: '还缺哪些证据？什么仍未知？单次响应非原子，旧 Query 和 Workflow ID 账本分别有什么限制？' },
];

export function LearningPractice() {
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState<ExperimentNote>({ ...EMPTY_EXPERIMENT_NOTE });
  const [exportStatus, setExportStatus] = useState('');
  const baseId = useId();

  function downloadNotes() {
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      const text = learningNotesMarkdown(answers, note);
      url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      link = document.createElement('a');
      link.href = url;
      link.download = 'temporal-learning-notes.md';
      document.body.append(link);
      link.click();
      const downloadUrl = url;
      window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
      setExportStatus('已生成 Markdown 下载，请确认文件已保存。');
    } catch {
      if (url) URL.revokeObjectURL(url);
      setExportStatus('浏览器未能导出，请直接复制作答和实验记录保存到本地。');
    } finally {
      link?.remove();
    }
  }

  return (
    <section className="panel learning-practice" id="learning-practice" aria-labelledby="learning-practice-title">
      <div className="learning-practice__header">
        <div>
          <p className="panel__kicker">Predict, observe, explain</p>
          <h2 id="learning-practice-title">自测与迁移练习</h2>
          <p>完成五阶段后，用自己的答案和运行证据检验理解，再独立编排一个资料审核流程。</p>
        </div>
        <button className="learning-guide__toggle" type="button" aria-expanded={open} aria-controls={`${baseId}-body`} onClick={() => setOpen((value) => !value)}>
          <BookOpenCheck size={16} aria-hidden="true" />
          {open ? '收起自测与练习' : '展开自测与练习'}
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>

      <div id={`${baseId}-body`} className="learning-practice__body" hidden={!open}>
        <div className="practice-notice">
          <FilePenLine size={18} aria-hidden="true" />
          <p>先作答，再展开参考要点自行核对。草稿仅保留在本次页面中，刷新或关闭会清空；离开前请导出。这里不自动读取运行证据，也不自动评分。</p>
        </div>

        <section className="practice-section" aria-labelledby={`${baseId}-questions`}>
          <h3 id={`${baseId}-questions`}>1. 先预测，再用证据解释</h3>
          <p>每题先写自己的判断，再做对应实验。保留预测与结果不一致的部分，并说明还缺什么证据。</p>
          <ol className="self-check-list">
            {SELF_CHECK_QUESTIONS.map((question, index) => (
              <li key={question.id}>
                <details className="self-check-question" open={index === 0}>
                  <summary><span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span>{question.title}</span><ChevronDown size={16} aria-hidden="true" /></summary>
                  <div className="self-check-question__body">
                    <p className="self-check-stage">{question.stage}</p>
                    <p className="self-check-prompt">{question.question}</p>
                    <label htmlFor={`${baseId}-answer-${question.id}`}>我的预测与解释</label>
                    <textarea id={`${baseId}-answer-${question.id}`} rows={4} value={answers[question.id] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />
                    <p><strong>动手核对：</strong>{question.action}</p>
                    <div className="practice-evidence"><strong>需要记录的证据</strong><ul>{question.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div>
                    <details className="self-check-reference">
                      <summary>展开参考要点 · {question.title}</summary>
                      <ul>{question.checkpoints.map((item) => <li key={item}>{item}</li>)}</ul>
                      <p>{question.explanation}</p>
                      <p className="self-check-reference__review">自行核对：解释是否覆盖了这些要点？引用是否属于同一次运行、来源是否新鲜？若证据不足，保留“尚不能确认”。</p>
                    </details>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>

        <section className="practice-section" aria-labelledby={`${baseId}-record`}>
          <h3 id={`${baseId}-record`}>2. 留下一份可复查的实验记录</h3>
          <p>先填预测，再操作并粘贴真实观察。导出文件同时包含自测作答与下方记录；未填写的内容会保留为空缺提示。</p>
          <div className="experiment-note-fields">
            {noteFields.map((field) => (
              <div className={field.short ? 'practice-field' : 'practice-field practice-field--wide'} key={field.key}>
                <label htmlFor={`${baseId}-note-${field.key}`}>{field.label}</label>
                {field.short ? (
                  <input id={`${baseId}-note-${field.key}`} type="text" value={note[field.key]} aria-describedby={`${baseId}-hint-${field.key}`} onChange={(event) => setNote((current) => ({ ...current, [field.key]: event.target.value }))} />
                ) : (
                  <textarea id={`${baseId}-note-${field.key}`} rows={4} value={note[field.key]} aria-describedby={`${baseId}-hint-${field.key}`} onChange={(event) => setNote((current) => ({ ...current, [field.key]: event.target.value }))} />
                )}
                <p id={`${baseId}-hint-${field.key}`}>{field.hint}</p>
              </div>
            ))}
          </div>
          <div className="practice-export">
            <button className="learning-guide__toggle" type="button" onClick={downloadNotes}><Download size={16} aria-hidden="true" />导出作答与实验记录</button>
            <p role="status">{exportStatus}</p>
          </div>
        </section>

        <section className="practice-section practice-transfer" aria-labelledby={`${baseId}-transfer`}>
          <div className="practice-transfer__heading"><FlaskConical size={20} aria-hidden="true" /><h3 id={`${baseId}-transfer`}>3. 独立实现资料审核流程</h3></div>
          <p>在独立练习中实现：准备资料 → 等待人工 Signal 或超时 → 归档；取消或失败后查账清理。先设计角色、稳定幂等键与失败分支，再阅读参考实现。</p>
          <ol>
            <li>在编辑器打开 <code>exercises/01-transfer/01.01-document-review/problem/readme.md</code>，按题目填写 <code>problem/workflow.ts</code> 的 TODO。</li>
            <li>使用专用 Task Queue 和独立资料账本运行；每次切换题目 / 参考实现前，先结束练习中的 Run 并停止对应练习 Worker。</li>
            <li>验收正常完成、等待时恢复、准备成功但响应丢失后的幂等，以及超时 / 取消清理。记录同一个 Run 的事件和账本变化。</li>
          </ol>
          <p className="practice-command-label">实现题目后，在独立终端启动练习 Worker</p>
          <pre tabIndex={0} aria-label="启动资料审核练习 Worker"><code>npm run exercise:review -- worker</code></pre>
          <p className="practice-command-label">在另一个终端创建一条练习执行</p>
          <pre tabIndex={0} aria-label="创建资料审核练习执行"><code>npm run exercise:review -- start --document study-001 --timeout 120</code></pre>
          <p>这些命令只作展示，不会从页面执行。题目尚未实现时会明确报错，避免将脚手架当作成功结果。完整观察、确认、取消和恢复步骤见练习目录。</p>
          <details className="self-check-reference">
            <summary>准备好后查看参考实现入口</summary>
            <p>先保存自己的设计与运行记录，再打开 <code>exercises/01-transfer/01.01-document-review/solution/readme.md</code> 对照参考解释和实现。参考命令为 <code>npm run exercise:review:solution -- worker</code>，不能与题目 Worker 同时消费同一队列。</p>
            <p>自动回归可运行 <code>npm run test:exercise</code>；它验证参考实现，不代表已经验证你修改的题目代码。自己的实现仍需按题目的 CLI 验收步骤记录证据。</p>
          </details>
        </section>
      </div>
    </section>
  );
}
