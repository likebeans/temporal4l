import start from '../docs/learning-path.md?raw';
import execution from '../docs/temporal-execution-flow.md?raw';
import recovery from '../docs/worker-recovery-guide.md?raw';
import reliability from '../docs/reliability-experiments.md?raw';
import messages from '../docs/signal-update-comparison.md?raw';
import evidence from '../docs/source-evidence-guide.md?raw';
import transfer from '../exercises/01-transfer/01.01-document-review/readme.md?raw';
import problem from '../exercises/01-transfer/01.01-document-review/problem/readme.md?raw';
import setup from '../README.md?raw';

export const courseAssets = import.meta.glob('../docs/**/*.{svg,png}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export interface CourseDocument { path: string; markdown: string }
export const courseDocuments: Record<string, CourseDocument[]> = {
  start: [{ path: 'docs/learning-path.md', markdown: start }],
  execution: [{ path: 'docs/temporal-execution-flow.md', markdown: execution }],
  recovery: [{ path: 'docs/worker-recovery-guide.md', markdown: recovery }],
  reliability: [{ path: 'docs/reliability-experiments.md', markdown: reliability }],
  messages: [{ path: 'docs/signal-update-comparison.md', markdown: messages }],
  evidence: [{ path: 'docs/source-evidence-guide.md', markdown: evidence }],
  transfer: [
    { path: 'exercises/01-transfer/01.01-document-review/readme.md', markdown: transfer },
    { path: 'exercises/01-transfer/01.01-document-review/problem/readme.md', markdown: problem },
  ],
  setup: [{ path: 'README.md', markdown: setup }],
};
