import { BookOpen, ChevronDown, ExternalLink, GitBranch, Server, Waypoints } from 'lucide-react';
import type { HealthResponse } from '../../shared/types';

interface HeaderProps {
  health: HealthResponse | null;
  healthError: string | null;
  guideOpen: boolean;
  onToggleGuide: () => void;
}

function safeHttpUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function Header({ health, healthError, guideOpen, onToggleGuide }: HeaderProps) {
  const ready = Boolean(health?.temporal && health.worker && !healthError);
  const temporalUiUrl = safeHttpUrl(health?.temporalUiUrl);
  const statusLabel = healthError
    ? '连接中断'
    : health === null
      ? '正在连接'
      : ready
        ? '本地环境就绪'
        : '服务未就绪';

  return (
    <header className="topbar">
      <div className="topbar__inner">
        <a className="brand" href="#main-content" aria-label="Temporal Lab 首页">
          <span className="brand__mark" aria-hidden="true">
            <Waypoints size={21} strokeWidth={2} />
          </span>
          <span className="brand__copy">
            <strong>Temporal4L</strong>
            <span>本地实验室 · Real workflow, real evidence</span>
          </span>
        </a>

        <div className="topbar__actions">
          <a className="topbar-button" href="https://likebeans.github.io/temporal4l/" target="_blank" rel="noreferrer">
            <BookOpen size={17} aria-hidden="true" />在线课程<ExternalLink size={14} aria-hidden="true" />
          </a>
          <details className={`connection-pill connection-pill--${ready ? 'ready' : healthError ? 'error' : 'pending'}`}>
            <summary>
              <span className="connection-pill__dot" aria-hidden="true" />
              <Server size={15} aria-hidden="true" />
              <span>{statusLabel}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <div className="connection-details">
              <p>命名空间 <code>{health?.namespace ?? '等待连接'}</code></p>
              <p>Task Queue <code>{health?.taskQueue ?? '等待连接'}</code></p>
              <p>Worker 就绪依据最近 90 秒的轮询记录；实时进程状态请以终端为准。</p>
            </div>
          </details>
          <button
            className="topbar-button"
            type="button"
            aria-expanded={guideOpen}
            aria-controls="learning-guide-body"
            onClick={onToggleGuide}
          >
            <BookOpen size={17} aria-hidden="true" />
            学习指南
          </button>
          {temporalUiUrl ? (
            <a className="topbar-button topbar-button--accent" href={temporalUiUrl} target="_blank" rel="noreferrer">
              <GitBranch size={17} aria-hidden="true" />
              Temporal UI
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : (
            <span className="topbar-button topbar-button--disabled" aria-disabled="true">
              <GitBranch size={17} aria-hidden="true" />
              Temporal UI
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
