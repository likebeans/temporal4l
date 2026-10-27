import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, ChevronDown, Circle, ClipboardCopy,
  ExternalLink, FlaskConical, LoaderCircle, RotateCcw, Terminal,
} from 'lucide-react';
import type { CreateOrderResponse, HealthResponse, OrderDetail, OrderInput } from '../../shared/types';
import { formatDateTime, formatMoney, isTerminalExecutionStatus } from '../format';
import {
  captureRecoveryBaseline, emptyRecoveryEvidence, observeRecovery, recoveryChecks, recoveryReadiness,
  transitionRecoveryPhase, type RecoveryMode, type RecoverySession,
} from '../recovery';

interface RecoveryGuideProps {
  detail: OrderDetail | null;
  health: HealthResponse | null;
  servicesReady: boolean;
  queryFresh: boolean;
  responseFresh: boolean;
  createPending: boolean;
  createError: string | null;
  actionPending: boolean;
  actionError: string | null;
  onCreate: (input: OrderInput) => Promise<CreateOrderResponse | null>;
  onApprove: () => Promise<void>;
  onSelect: (workflowId: string) => void;
  onSessionChange: (active: boolean) => void;
}

const modes: { id: RecoveryMode; title: string; description: string }[] = [
  { id: 'approval', title: '等待确认时重启', description: 'Signal 先入库，恢复编排后继续发货。' },
  { id: 'packing', title: '打包期间崩溃', description: '中断 Activity，从服务端心跳检查点继续。' },
];
const steps = ['准备订单', '保存基线并停止', '观察停机窗口', '重启并核对'];

function workflowUrl(health: HealthResponse | null, workflowId?: string, runId?: string): string | null {
  if (!health?.temporalUiUrl || !workflowId || !runId) return null;
  try {
    const url = new URL(health.temporalUiUrl, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/namespaces/${encodeURIComponent(health.namespace)}/workflows/${encodeURIComponent(workflowId)}/${encodeURIComponent(runId)}/history`;
    return url.toString();
  } catch {
    return null;
  }
}

function Command({ label, command }: { label: string; command: string }) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setFeedback('已复制');
    } catch {
      setFeedback('请选中命令复制');
    }
  }

  return (
    <div className="recovery-command">
      <span>{label}</span>
      <div>
        <Terminal size={16} aria-hidden="true" />
        <code>{command}</code>
        <button className="recovery-copy" type="button" aria-label={`复制 ${label}`} onClick={() => void copy()}>
          <ClipboardCopy size={16} aria-hidden="true" />
        </button>
      </div>
      {feedback && <small role="status">{feedback}</small>}
    </div>
  );
}

export function RecoveryGuide({
  detail, health, servicesReady, queryFresh, responseFresh, createPending, createError,
  actionPending, actionError, onCreate, onApprove, onSelect, onSessionChange,
}: RecoveryGuideProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RecoveryMode>('approval');
  const [preparedWorkflowId, setPreparedWorkflowId] = useState<string | null>(null);
  const [session, setSession] = useState<RecoverySession | null>(null);
  const [experimentCreating, setExperimentCreating] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const sessionActive = Boolean(session);

  const baseline = session?.baseline;
  const targetId = baseline?.workflowId ?? preparedWorkflowId;
  const targetSelected = !targetId || detail?.workflowId === targetId;
  const current = targetSelected ? detail : null;
  const currentQueryFresh = Boolean(current && queryFresh && responseFresh && !current.stateError);
  const readiness = recoveryReadiness(mode, current, currentQueryFresh);
  const checks = baseline && session
    ? recoveryChecks(baseline, session.evidence, current, responseFresh && targetSelected, currentQueryFresh)
    : [];
  const allPassed = session?.phase === 'restarted' && checks.length > 0 && checks.every((check) => check.status === 'pass');
  const hasFailure = checks.some((check) => check.status === 'fail');
  const step = !session ? 0 : session.phase === 'captured' ? 1 : session.phase === 'stopped' ? 2 : 3;
  const uiUrl = workflowUrl(health, baseline?.workflowId ?? current?.workflowId, baseline?.runId ?? current?.runId);
  const packingActivity = current?.pendingActivities.find((activity) => activity.activityType === 'packOrder');
  const checkpoint = packingActivity?.heartbeat ?? (currentQueryFresh ? current?.state?.packing : undefined);
  const sameRun = Boolean(baseline && current?.workflowId === baseline.workflowId && current.runId === baseline.runId);
  const stoppedReadiness = session
    ? transitionRecoveryPhase(session, 'stopped', current, responseFresh)
    : { ready: false, reason: '' };
  const restartedReadiness = session
    ? transitionRecoveryPhase(session, 'restarted', current, responseFresh)
    : { ready: false, reason: '' };

  useEffect(() => {
    onSessionChange(sessionActive);
  }, [sessionActive, onSessionChange]);

  useEffect(() => {
    if (session?.phase) stageHeadingRef.current?.focus({ preventScroll: true });
  }, [session?.phase]);

  useEffect(() => {
    if (!detail || !responseFresh) return;
    setSession((previous) => {
      if (!previous || previous.phase === 'captured' ||
          !(Date.parse(detail.observedAt) > Date.parse(previous.phaseResponseAt))) return previous;
      const evidence = observeRecovery(previous.baseline, previous.evidence, detail, previous.phase);
      return JSON.stringify(evidence) === JSON.stringify(previous.evidence) ? previous : { ...previous, evidence };
    });
  }, [detail, responseFresh]);

  async function createExperiment() {
    setCaptureError(null);
    setExperimentCreating(true);
    try {
      const created = await onCreate({
        customerName: mode === 'approval' ? '恢复实验 · 等待确认' : '恢复实验 · 打包检查点',
        productId: 'keyboard', quantity: 1,
        scenario: mode === 'approval' ? 'normal' : 'heartbeat',
        approvalTimeoutSeconds: 300,
      });
      if (created) setPreparedWorkflowId(created.workflowId);
    } finally {
      setExperimentCreating(false);
    }
  }

  function capture() {
    if (!current || !readiness.ready || !responseFresh) return;
    try {
      const saved = captureRecoveryBaseline(mode, current);
      setSession({ baseline: saved, phase: 'captured', phaseResponseAt: saved.capturedAt, evidence: emptyRecoveryEvidence() });
      setCaptureError(null);
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : '保存失败，请等待新的状态后重试。');
    }
  }

  function recordPhase(phase: 'stopped' | 'restarted') {
    setSession((previous) => previous
      ? transitionRecoveryPhase(previous, phase, current, responseFresh).session
      : previous);
  }

  function reset() {
    setSession(null);
    setPreparedWorkflowId(null);
    setCaptureError(null);
  }

  return (
    <section className={`recovery-guide${open ? ' is-open' : ''}`} aria-labelledby="recovery-title">
      <div className="recovery-guide__heading">
        <div className="recovery-guide__identity">
          <span className="recovery-guide__icon"><FlaskConical size={22} aria-hidden="true" /></span>
          <div>
            <p className="panel__kicker">Learn by restarting a Worker</p>
            <h2 id="recovery-title">Worker 恢复实验</h2>
            <p>亲手停止 Worker，对照同一次执行的历史、付款和检查点。</p>
          </div>
        </div>
        <button className="recovery-button" type="button" aria-expanded={open} aria-controls="recovery-body" onClick={() => setOpen((value) => !value)}>
          {open ? '收起向导' : session ? '继续实验' : '打开恢复向导'}
          <ChevronDown className={open ? 'recovery-chevron is-open' : 'recovery-chevron'} size={17} aria-hidden="true" />
        </button>
      </div>

      <div id="recovery-body" hidden={!open} className="recovery-guide__body">
        <fieldset className="recovery-modes" disabled={Boolean(session) || createPending}>
          <legend>选择恢复实验</legend>
          {modes.map((item) => (
            <label key={item.id} className={mode === item.id ? 'is-selected' : ''}>
              <input type="radio" name="recoveryMode" value={item.id} checked={mode === item.id} onChange={() => { setMode(item.id); setPreparedWorkflowId(null); }} />
              <span><strong>{item.title}</strong><small>{item.description}</small></span>
            </label>
          ))}
        </fieldset>

        <ol className="recovery-steps" aria-label="恢复实验步骤">
          {steps.map((label, index) => (
            <li key={label} className={index < step || allPassed ? 'is-done' : index === step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}>
              <span aria-hidden="true">{index < step || allPassed ? <Check size={15} /> : index + 1}</span>
              <strong>{label}</strong>
            </li>
          ))}
        </ol>

        <details className="recovery-setup" open={!session}>
          <summary>开始前：让 Worker 在独立终端运行</summary>
          <p>在项目目录执行。保留已运行的 Temporal、API 和前端；若正使用 <code>npm run dev</code>，先停止它，再分别启动。任务队列只保留一个 Worker。</p>
          <div className="recovery-command-grid">
            <Command label="终端 A · API" command="npm run dev:api" />
            <Command label="终端 B · Worker（无热重载）" command="npm run worker:recovery" />
            <Command label="终端 C · 页面" command="npm run dev:web" />
          </div>
          <p>Worker 就绪后会打印 <code>Worker PID: 数字</code>。打包实验中使用这个 PID；热重载监控进程可能自动重启 Worker，影响停机观察。</p>
        </details>

        {!targetSelected && targetId && (
          <div className="recovery-notice" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <p>当前选中了另一张订单，实验观察已暂停。向导只核对保存的 Workflow ID / Run ID。</p>
            <button className="recovery-button" type="button" onClick={() => onSelect(targetId)}>返回实验订单</button>
          </div>
        )}

        {!session ? (
          <div className="recovery-stage">
            <div>
              <p className="eyebrow">步骤 1 · 准备</p>
              <h3>{mode === 'approval' ? '先停在人工确认这一步' : '先让打包保存至少一批心跳'}</h3>
              <p>可创建一条 300 秒确认期限的实验订单，也可使用当前符合条件的订单。{mode === 'packing' && '确认订单后约有 12 秒打包窗口，看到检查点后及时保存并停止 Worker。'}</p>
            </div>
            <div className="recovery-actions">
              <button className="recovery-button" type="button" disabled={!servicesReady || createPending} onClick={() => void createExperiment()}>
                {createPending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <FlaskConical size={16} aria-hidden="true" />}
                创建{mode === 'approval' ? '等待确认' : '打包恢复'}实验订单
              </button>
              {mode === 'packing' && current?.state?.status === 'waiting_approval' && (
                <button className="recovery-button" type="button" disabled={!servicesReady || !currentQueryFresh || actionPending} onClick={() => void onApprove()}>
                  确认并开始打包 <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
              <button className="primary-button" type="button" disabled={!readiness.ready || !responseFresh || actionPending || createPending || experimentCreating} onClick={capture}>保存实验前快照</button>
            </div>
            <p className={`recovery-readiness${readiness.ready ? ' is-ready' : ''}`} role="status">
              {readiness.ready ? <Check size={16} aria-hidden="true" /> : <Circle size={16} aria-hidden="true" />}
              {readiness.reason}
              {mode === 'packing' && checkpoint && ` · 当前 ${checkpoint.completedBatches}/${checkpoint.totalBatches} 批，尝试 #${checkpoint.attempt}`}
            </p>
            {(createError || actionError || captureError) && <p className="recovery-error" role="alert">{captureError || createError || actionError}</p>}
          </div>
        ) : (
          <>
            <div className="recovery-baseline">
              <div className="recovery-section-heading">
                <h3>已保存的实验基线</h3>
                <span>采集于 {formatDateTime(baseline!.capturedAt)}</span>
              </div>
              <dl className="recovery-identifiers">
                <div><dt>Workflow ID</dt><dd><code>{baseline!.workflowId}</code></dd></div>
                <div><dt>Run ID</dt><dd><code>{baseline!.runId}</code></dd></div>
              </dl>
              <table className="recovery-comparison">
                <caption>实验前与当前观测对照</caption>
                <thead><tr><th scope="col">观察项</th><th scope="col">实验前</th><th scope="col">当前{!responseFresh ? '（过期）' : ''}</th></tr></thead>
                <tbody>
                  <tr><th scope="row">付款调用</th><td>{baseline!.paymentAttempts} 次</td><td>{sameRun ? `${current!.payment.attempts} 次` : '未取得'}</td></tr>
                  <tr><th scope="row">实际扣款</th><td>{baseline!.debitCount} 笔 · {formatMoney(baseline!.totalCharged)}</td><td>{sameRun ? `${current!.payment.debitCount} 笔 · ${formatMoney(current!.payment.totalCharged)}` : '未取得'}</td></tr>
                  {baseline!.packing && <tr><th scope="row">打包检查点</th><td>#{baseline!.packing.attempt} · {baseline!.packing.completedBatches}/{baseline!.packing.totalBatches} 批</td><td>{sameRun && checkpoint ? `#${checkpoint.attempt} · ${checkpoint.completedBatches}/${checkpoint.totalBatches} 批；从 ${checkpoint.resumedFrom} 恢复` : '未取得新检查点'}</td></tr>}
                </tbody>
              </table>
            </div>

            {session.phase === 'captured' && (
              <div className="recovery-stage">
                <p className="eyebrow">步骤 2 · 在终端停止 Worker</p>
                <h3 ref={stageHeadingRef} tabIndex={-1}>{mode === 'approval' ? '在终端 B 按 Ctrl+C，等待 Worker 退出' : '中断正在执行的打包进程'}</h3>
                {mode === 'approval' ? (
                  <p>只停止 Worker，保持 Temporal、API 和页面运行。确认等待使用持久化 Timer，停机期间时间仍然流逝。</p>
                ) : (
                  <>
                    <p>先读取终端 B 打印的 Worker PID，再在另一个终端强制结束该进程。将下方 <code>&lt;Worker_PID&gt;</code> 替换为数字；只操作本实验的 Worker。</p>
                    <Command label="模拟 Worker 进程崩溃" command="kill -KILL <Worker_PID>" />
                    <p>普通 Ctrl+C 会给予 10 秒退出宽限期，打包可能直接完成，无法保证出现 Activity 重试。若已完成，请清除向导记录并重新创建实验订单。</p>
                  </>
                )}
                <button className="primary-button" type="button" disabled={!stoppedReadiness.ready} onClick={() => recordPhase('stopped')}>已在终端停止 Worker</button>
                <small>这是手动操作记录；页面随后会用真实观测核对中断。</small>
                {!stoppedReadiness.ready && <p className="recovery-error" role="status">{stoppedReadiness.reason}</p>}
              </div>
            )}

            {session.phase === 'stopped' && (
              <div className="recovery-stage">
                <p className="eyebrow">步骤 3 · 观察停机窗口</p>
                <h3 ref={stageHeadingRef} tabIndex={-1}>{mode === 'approval' ? '先等待 Query 中断，再通过官方 UI 发送 Signal' : '等待心跳超时，保留服务端检查点'}</h3>
                {mode === 'approval' ? (
                  <>
                    <p>先等下方明确显示 Query 中断及 History 边界。随后保持 Worker 停止，在当前执行的官方 UI 中选择 <code>More Actions → Send a Signal</code>，填写 <code>approveOrder</code>，无需参数。首次中断响应若已包含 Signal，就无法证明先后顺序，需要重做。页面普通确认接口需要先 Query，因此停机时请使用官方 UI。</p>
                    {uiUrl && session.evidence.queryInterrupted && !session.evidence.invalidReason && <a className="recovery-button" href={uiUrl} target="_blank" rel="noreferrer">打开本次执行的 Temporal UI <ExternalLink size={15} aria-hidden="true" /></a>}
                    <p>{current?.state?.approvalDeadline ? `确认截止：${formatDateTime(current.state.approvalDeadline)}。` : ''}不要等到期限结束才重启；最终分支取决于持久化历史和实际处理顺序。</p>
                  </>
                ) : (
                  <p>心跳期限为 5 秒。Pending Activity 的尝试号可能先增加，而心跳内容仍来自旧尝试；这还不能证明已经恢复。整个打包 Activity 的排队、执行和重试总时限为 2 分钟。</p>
                )}
                <ul className="recovery-observations">
                  <li>{session.evidence.queryInterrupted ? <Check size={17} aria-hidden="true" /> : <LoaderCircle className="spin" size={17} aria-hidden="true" />}<span>{session.evidence.queryInterrupted ? `同一 Run 仍为 RUNNING 时 Query 不可用，已固定 History 边界 #${session.evidence.interruptionHistoryEventId}。` : '等待 Query 中断证据；请求可能需要约 4–6 秒才返回，此时先不要发送 Signal。'}</span></li>
                  {mode === 'approval' && <li>{session.evidence.signalEventId ? <Check size={17} aria-hidden="true" /> : <Circle size={17} aria-hidden="true" />}<span>{session.evidence.signalEventId ? `停机阶段已认证边界后的 approveOrder，事件 #${session.evidence.signalEventId}。` : '尚未在停机阶段观察到中断边界之后新增的 approveOrder 事件。'}</span></li>}
                </ul>
                <Command label="终端 B · 重启 Worker" command="npm run worker:recovery" />
                <p>先等待停机证据齐全，再执行重启命令。看到终端打印就绪后，点击下方按钮开始对比。若订单已在重启后完成，仍可进入核对；后续新鲜响应将确认恢复结果。</p>
                <button className="primary-button" type="button" disabled={!restartedReadiness.ready} onClick={() => recordPhase('restarted')}>已在终端重启，开始核对</button>
                {!restartedReadiness.ready && <p className="recovery-error" role="status">{restartedReadiness.reason}</p>}
              </div>
            )}

            {session.phase === 'restarted' && (
              <div className="recovery-stage">
                <p className="eyebrow">步骤 4 · 根据真实数据核对</p>
                <h3 ref={stageHeadingRef} tabIndex={-1} aria-live="polite">{allPassed ? '恢复证据齐全' : hasFailure ? '观察结果与预期不同' : '等待恢复证据'}</h3>
                <p>{allPassed
                  ? mode === 'approval'
                    ? '同一个 Run 接收了停机窗口中的 Signal，Query 恢复且订单完成；原有付款和已完成 Activity 没有再次安排。'
                    : '同一个 Run 的打包 Activity 进入新尝试，并从已保存批次继续；付款次数保持不变，订单已完成。'
                  : '按钮只记录终端操作。下面各项由最新响应与实验中已采集的证据判断，缺少证据时保留“待观察”。'}</p>
              </div>
            )}

            <div className="recovery-checks" aria-label="恢复证据核对">
              {checks.map((check) => (
                <div key={check.id} className={`recovery-check recovery-check--${check.status}`}>
                  {check.status === 'pass' ? <Check size={18} aria-hidden="true" /> : check.status === 'fail' ? <AlertTriangle size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
                  <div><strong>{check.label}<span>{check.status === 'pass' ? '已观察' : check.status === 'fail' ? '不符合' : '待观察'}</span></strong><p>{check.detail}</p></div>
                </div>
              ))}
            </div>
            {current && isTerminalExecutionStatus(current.status) && !allPassed && (
              <p className="recovery-notice"><AlertTriangle size={18} aria-hidden="true" /><span>当前执行已结束：{current.status}。若中断窗口、Signal 或检查点证据未采集到，请查看 History，或新建订单重做实验。</span></p>
            )}
            <div className="recovery-reset">
              <button className="recovery-button" type="button" onClick={reset}><RotateCcw size={16} aria-hidden="true" />清除向导记录</button>
              <small>只清除本页实验记录，不取消 Workflow。记录在刷新页面后清空，服务端执行和账本仍保留。</small>
            </div>
          </>
        )}

        <div className="recovery-footnote">
          <AlertTriangle size={17} aria-hidden="true" />
          <p>顶部 Worker 状态来自最近 90 秒内的轮询记录，可能滞后；Query 中断也可能由网络或调度导致。向导核对执行行为，进程确实停止与重启仍需结合终端确认。{current && <span> 当前 Query：{!responseFresh ? '响应已过期' : currentQueryFresh ? '可用' : '暂不可用'}；最近响应：{formatDateTime(current.observedAt)}。</span>}</p>
        </div>
      </div>
    </section>
  );
}
