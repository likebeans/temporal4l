import { useId, useState } from 'react';
import { Check, CircleHelp, LoaderCircle, MessageSquareMore, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ApprovalFeedback } from '../../shared/approval';
import type { OrderDetail } from '../../shared/types';
import { formatDateTime } from '../format';

interface ApprovalComparisonProps {
  detail: OrderDetail;
  canApprove: boolean;
  pending: 'approve' | 'update' | 'cancel' | null;
  awaiting: boolean;
  feedback: ApprovalFeedback | null;
  recoveryReady: boolean;
  onSignal: () => Promise<void>;
  onUpdate: (confirmed: boolean, recovery?: 'query' | 'retry') => Promise<void>;
}

const feedbackTitles = {
  sent: 'Signal 收件回执 · 已接收',
  approved: 'Update 业务结果 · 已确认',
  rejected: 'Update 被拒绝',
  unknown: 'Update 结果暂时未知',
};

export function ApprovalComparison({
  detail, canApprove, pending, awaiting, feedback, recoveryReady, onSignal, onUpdate,
}: ApprovalComparisonProps) {
  const [method, setMethod] = useState<'signal' | 'update'>(
    () => feedback?.method ?? detail.state?.approvalMethod ?? 'signal',
  );
  const [confirmed, setConfirmed] = useState(() => feedback?.request?.confirmed ?? false);
  const id = useId();
  const unknown = feedback?.status === 'unknown';
  const settledMethod = feedback?.status === 'sent' || feedback?.status === 'approved'
    ? feedback.method : detail.state?.approvalMethod;
  const selectedMethod = settledMethod ?? method;
  const sending = pending === 'approve' || pending === 'update';
  const locked = !canApprove || unknown;
  const allowMethodChoice = !pending && !unknown && !settledMethod && !detail.state?.approvedAt;
  const FeedbackIcon = feedback?.status === 'rejected' ? TriangleAlert
    : feedback?.status === 'unknown' ? CircleHelp : Check;

  return (
    <section className="approval-comparison" aria-labelledby={`${id}-title`}>
      <div className="approval-comparison__heading">
        <span className="approval-callout__icon" aria-hidden="true"><MessageSquareMore size={19} /></span>
        <div>
          <h3 id={`${id}-title`}>Signal / Update 对照</h3>
          <p>同一次订单确认，观察两种返回语义。每条订单只需确认一次，比较另一种方式时请创建新订单。</p>
        </div>
      </div>

      <fieldset className="approval-methods" disabled={!allowMethodChoice}>
        <legend>选择订单确认方式</legend>
        <label className={selectedMethod === 'signal' ? 'is-selected' : ''}>
          <span><input type="radio" name={`${id}-method`} value="signal" checked={selectedMethod === 'signal'} onChange={() => setMethod('signal')} /><strong>Signal</strong><Send size={16} aria-hidden="true" /></span>
          <span>服务端接收消息后返回；业务处理结果继续看 Query。</span>
        </label>
        <label className={selectedMethod === 'update' ? 'is-selected' : ''}>
          <span><input type="radio" name={`${id}-method`} value="update" checked={selectedMethod === 'update'} onChange={() => setMethod('update')} /><strong>Update</strong><ShieldCheck size={16} aria-hidden="true" /></span>
          <span>先由 Worker 校验，再等待 handler 返回确认结果。</span>
        </label>
      </fieldset>

      {selectedMethod === 'update' && (
        <div className="approval-validation">
          <label htmlFor={`${id}-confirmed`}>
            <input id={`${id}-confirmed`} type="checkbox" checked={confirmed} disabled={locked} onChange={(event) => setConfirmed(event.target.checked)} aria-describedby={`${id}-validation-hint`} />
            <span>我已核对订单信息，确认继续处理</span>
          </label>
          <p id={`${id}-validation-hint`}>先不勾选并发送一次，可观察 Workflow validator 拒绝；勾选后再次发送即可完成确认。校验不会修改订单。</p>
        </div>
      )}

      {detail.state?.status === 'waiting_approval' && (
        <p className="approval-deadline">{detail.state.approvalDeadline ? `确认截止 ${formatDateTime(detail.state.approvalDeadline)}` : 'Workflow 正在等待人工确认。'}</p>
      )}
      {detail.state?.status === 'waiting_approval' && !unknown && (
        <button
          className="primary-button primary-button--compact approval-submit"
          type="button" disabled={locked}
          onClick={() => void (selectedMethod === 'signal' ? onSignal() : onUpdate(confirmed))}
        >
          {sending ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
          {sending ? awaiting ? 'Signal 已接收，等待状态…' : '正在等待返回…'
            : selectedMethod === 'signal' ? '发送确认 Signal'
              : confirmed ? '发送确认 Update' : '发送 Update（校验拒绝实验）'}
        </button>
      )}
      {detail.state?.approvedAt && (
        <p className="approval-observed"><Check size={16} aria-hidden="true" />Query 已观察到{detail.state.approvalMethod === 'update' ? ' Update' : detail.state.approvalMethod === 'signal' ? ' Signal' : ''} 确认，时间 {formatDateTime(detail.state.approvedAt)}。</p>
      )}

      {feedback && (
        <div className={`approval-feedback approval-feedback--${feedback.status}`} role={feedback.status === 'rejected' ? 'alert' : 'status'}>
          <div className="approval-feedback__title"><FeedbackIcon size={18} aria-hidden="true" /><strong>{feedbackTitles[feedback.status]}</strong></div>
          <p>{feedback.message}</p>
          {feedback.request && (
            <dl className="approval-identifiers">
              <div><dt>Update ID</dt><dd><code>{feedback.request.updateId}</code></dd></div>
              <div><dt>Run ID</dt><dd><code>{feedback.runId}</code></dd></div>
            </dl>
          )}
          {feedback.result && <pre aria-label="Update handler 返回结果"><code>{JSON.stringify(feedback.result, null, 2)}</code></pre>}
          {unknown && feedback.request && (
            <>
              <div className="approval-recovery-actions">
                <button className="approval-secondary" type="button" disabled={!recoveryReady} onClick={() => void onUpdate(feedback.request!.confirmed, 'query')}>查询原 Update 结果</button>
                <button className="approval-secondary" type="button" disabled={!recoveryReady} onClick={() => void onUpdate(feedback.request!.confirmed, 'retry')}>重试同一 Update ID</button>
                {pending === 'update' && <LoaderCircle className="spin" size={17} aria-label="正在取回 Update 结果" />}
              </div>
              <p>查询不会新建 Update；重试复用原参数和 ID。未找到结果仍保持未知。记录仅保存在本页内存，刷新前请保留这两个 ID。</p>
            </>
          )}
        </div>
      )}
      <p className="approval-boundary">Update 的成功结果只表示人工确认 handler 已完成。订单是否最终完成，以 Temporal 执行状态和发货结果为准。本页 Signal API 会先做 Query 检查，Worker 停机收信请使用恢复实验中的官方 UI。</p>
    </section>
  );
}
