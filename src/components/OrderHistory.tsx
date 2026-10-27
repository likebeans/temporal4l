import { Clock3, History, LoaderCircle, RotateCw } from 'lucide-react';
import type { OrderSummary } from '../../shared/types';
import { formatDateTime, orderStatusLabel, orderStatusTone } from '../format';

interface OrderHistoryProps {
  orders: OrderSummary[];
  selectedWorkflowId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (workflowId: string) => void;
}

export function OrderHistory({ orders, selectedWorkflowId, loading, error, onSelect }: OrderHistoryProps) {
  return (
    <aside className="panel history-sidebar" aria-labelledby="recent-orders-title">
      <div className="history-sidebar__header">
        <div>
          <p className="panel__kicker">View past runs</p>
          <h2 id="recent-orders-title">最近实验</h2>
        </div>
        <span className="history-sidebar__count" aria-label={`${orders.length} 条记录`}>{orders.length}</span>
      </div>

      {error && (
        <div className="sidebar-notice" role="status">
          <RotateCw size={16} aria-hidden="true" />
          <span>{error} 正在自动重试。</span>
        </div>
      )}

      {orders.length === 0 ? (
        <div className="compact-empty">
          {loading ? <LoaderCircle className="spin" size={22} aria-hidden="true" /> : <History size={22} aria-hidden="true" />}
          <strong>{loading ? '正在读取运行记录' : '还没有实验记录'}</strong>
          <p>{loading ? '稍等片刻，Temporal 正在响应。' : '从左侧创建第一个订单，记录会保存在 Temporal 中。'}</p>
        </div>
      ) : (
        <ul className="history-list" aria-label="工作流运行记录">
          {orders.map((order, index) => {
            const selected = selectedWorkflowId === order.workflowId;
            const tone = orderStatusTone(order.status);
            return (
              <li key={`${order.workflowId}-${order.runId}`}>
                <button
                  className={`history-item${selected ? ' is-selected' : ''}`}
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(order.workflowId)}
                >
                  <span className="history-item__topline">
                    <span className="history-item__index">RUN {String(orders.length - index).padStart(2, '0')}</span>
                    <span className={`status-badge status-badge--${tone}`}>
                      <span aria-hidden="true" />
                      {orderStatusLabel(order.status)}
                    </span>
                  </span>
                  <code title={order.workflowId}>{order.workflowId}</code>
                  <span className="history-item__time">
                    <Clock3 size={14} aria-hidden="true" />
                    {formatDateTime(order.startedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="history-sidebar__footnote">选择任一记录即可重新查看状态与事件历史。</p>
    </aside>
  );
}
