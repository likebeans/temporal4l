export const REPOSITORY = 'https://github.com/likebeans/temporal4l';

export const CHAPTERS = [
  { id: 'start', title: '从这里开始', subtitle: '学习路线与实验方法', path: 'docs/learning-path.md', group: '认识 Temporal', topic: 'execution' },
  { id: 'execution', title: '一条订单如何运行', subtitle: 'Server、Worker 与持久化执行', path: 'docs/temporal-execution-flow.md', group: '认识 Temporal', topic: 'execution' },
  { id: 'recovery', title: '停机之后，继续执行', subtitle: 'History、重放与恢复证据', path: 'docs/worker-recovery-guide.md', group: '理解可靠性', topic: 'recovery' },
  { id: 'reliability', title: '面对失败与未知结果', subtitle: '重试、幂等、补偿与心跳', path: 'docs/reliability-experiments.md', group: '理解可靠性', topic: 'idempotency' },
  { id: 'messages', title: '与运行中的流程交互', subtitle: 'Signal、Update 与 Query', path: 'docs/signal-update-comparison.md', group: '理解可靠性', topic: 'signal' },
  { id: 'evidence', title: '用源码和证据解释', subtitle: '区分观察、推断与未知', path: 'docs/source-evidence-guide.md', group: '独立实践', topic: 'execution' },
  { id: 'transfer', title: '实现你的第一个流程', subtitle: '资料审核迁移练习', path: 'exercises/01-transfer/01.01-document-review/readme.md', group: '独立实践', topic: 'cancellation' },
] as const;

export type Chapter = typeof CHAPTERS[number];
export type StudyView = 'read' | 'walkthrough' | 'source' | 'notes' | 'setup';
export interface StudyRoute { view: StudyView; chapter: string; anchor?: string }
const views: StudyView[] = ['read', 'walkthrough', 'source', 'notes', 'setup'];

export function studyHref(view: StudyView, chapter = 'start', anchor?: string): string {
  const params = new URLSearchParams({ view, chapter });
  if (anchor) params.set('section', anchor);
  return `#${params}`;
}

export function readStudyRoute(hash: string): StudyRoute {
  const legacy: Record<string, StudyView> = { '#walkthrough': 'walkthrough', '#online-source': 'source', '#learning-practice': 'notes', '#local-lab': 'setup' };
  if (legacy[hash]) return { view: legacy[hash], chapter: 'start' };
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const view = params.get('view') as StudyView;
  const chapter = params.get('chapter') ?? 'start';
  return { view: views.includes(view) ? view : 'read', chapter: CHAPTERS.some((item) => item.id === chapter) ? chapter : 'start', anchor: params.get('section') ?? undefined };
}

export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/ /g, '-');
}

export function documentHeadings(markdown: string) {
  const counts = new Map<string, number>();
  let fence: { character: string; length: number } | null = null;
  return markdown.split('\n').flatMap((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return [];
    }
    if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return []; }
    const match = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (!match) return [];
    const title = match[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '');
    const slug = headingSlug(title);
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return [{ title, level: match[1].length, line: index + 1, id: count ? `${slug}-${count}` : slug }];
  });
}

export function documentLink(href: string, from: string, route: StudyRoute): string {
  if (!href) return '';
  if (href.startsWith('#')) return studyHref(route.view, route.chapter, decodeURIComponent(href.slice(1)));
  const base = `https://course.local/${from}`;
  let url: URL;
  try { url = new URL(href, base); } catch { return ''; }
  if (url.origin !== 'https://course.local') return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? href : '';
  const path = decodeURIComponent(url.pathname.slice(1));
  const chapter = CHAPTERS.find((item) => item.path === path);
  const anchor = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  if (chapter) return studyHref('read', chapter.id, anchor);
  if (path === 'exercises/01-transfer/01.01-document-review/problem/readme.md') return studyHref('read', 'transfer', '自行实现资料审核编排');
  if (path === 'README.md') return studyHref('setup', route.chapter, anchor);
  if (path === 'docs/self-check.md' || path === 'docs/experiment-record-template.md') return studyHref('notes', route.chapter);
  return `${REPOSITORY}/blob/main/${path}${url.hash}`;
}
