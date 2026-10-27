import { AlertTriangle, Check, Copy, Terminal } from 'lucide-react';
import { useState } from 'react';

interface DisconnectedStateProps {
  message: string;
}

export function DisconnectedState({ message }: DisconnectedStateProps) {
  const [mode, setMode] = useState<'native' | 'docker'>('native');
  const [copied, setCopied] = useState<string | null>(null);
  const commands = [mode === 'native' ? 'npm run temporal:local' : 'npm run temporal:up', 'npm run dev'];

  async function copyCommand(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(command);
      window.setTimeout(() => setCopied((current) => (current === command ? null : current)), 1800);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section className="disconnected-state" aria-labelledby="disconnected-title">
      <div className="disconnected-state__icon" aria-hidden="true"><AlertTriangle size={21} /></div>
      <div className="disconnected-state__copy">
        <p className="eyebrow">Local services</p>
        <h2 id="disconnected-title">实验环境尚未就绪</h2>
        <p>{message}</p>
      </div>
      <div className="disconnected-state__setup">
        <fieldset className="startup-mode">
          <legend>Temporal 启动方式</legend>
          <div className="startup-mode__options">
            <label><input type="radio" name="temporal-startup-mode" value="native" checked={mode === 'native'} onChange={() => setMode('native')} />原生 · 无需 Docker</label>
            <label><input type="radio" name="temporal-startup-mode" value="docker" checked={mode === 'docker'} onChange={() => setMode('docker')} />Docker</label>
          </div>
        </fieldset>
        <div className="command-list" aria-label="所选方式的启动命令">
          {commands.map((command, index) => (
            <div className="command" key={command}>
              <span aria-hidden="true">{index + 1}</span>
              <Terminal size={16} aria-hidden="true" />
              <code>{command}</code>
              <button type="button" aria-label={`复制命令 ${command}`} onClick={() => void copyCommand(command)}>
                {copied === command ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              </button>
            </div>
          ))}
        </div>
        <p>从仓库根目录运行；首次先执行 <code>npm ci</code>。只选择一种 Temporal 启动方式，已有服务时直接复用。在独立终端启动 Temporal，等待就绪后再运行应用；当前 API 或 Worker 已启动时，只补启缺失的进程。</p>
      </div>
    </section>
  );
}
