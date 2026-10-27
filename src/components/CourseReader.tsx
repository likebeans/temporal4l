import { useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { documentHeadings, documentLink, REPOSITORY, studyHref, type StudyRoute } from '../course';
import type { CourseDocument } from '../course-documents';

function assetUrl(href: string, path: string, assets: Record<string, string>): string | undefined {
  try {
    const url = new URL(href, `https://course.local/${path}`);
    return url.origin === 'https://course.local' ? assets[`../${decodeURIComponent(url.pathname.slice(1))}`] : undefined;
  } catch { return undefined; }
}

function textContent(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (value && typeof value === 'object' && 'props' in value) return textContent((value.props as { children?: ReactNode }).children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [status, setStatus] = useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(textContent(children)); setStatus('已复制'); }
    catch { setStatus('请选中代码复制'); }
  }
  return <div className="reader-code"><div className="reader-code__bar"><span>代码 / 命令</span><button type="button" onClick={() => void copy()}>{status === '已复制' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}复制代码</button><span role="status">{status}</span></div><pre tabIndex={0}>{children}</pre></div>;
}

export function CourseReader({ documents, route, assets }: { documents: CourseDocument[]; route: StudyRoute; assets: Record<string, string> }) {
  return <div className="course-prose">{documents.map((document) => {
    const headings = documentHeadings(document.markdown);
    const heading: Components['h2'] = ({ node, children }) => {
      const item = headings.find((entry) => entry.line === node?.position?.start.line);
      return <h2 id={item?.id}>{children}<a className="reader-heading-link" href={studyHref(route.view, route.chapter, item?.id)} aria-label={`直达 ${item?.title ?? '此段落'}`}>#</a></h2>;
    };
    const components: Components = {
      h1: ({ node, children }) => {
        const item = headings.find((entry) => entry.line === node?.position?.start.line);
        return <h2 className="reader-document-title" id={item?.id}>{children}</h2>;
      },
      h2: heading,
      h3: ({ node, children }) => {
        const item = headings.find((entry) => entry.line === node?.position?.start.line);
        return <h3 id={item?.id}>{children}</h3>;
      },
      a: ({ href = '', children }) => {
        const url = assetUrl(href, document.path, assets) ?? documentLink(href, document.path, route);
        const external = !url.startsWith('#');
        return <a href={url || undefined} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>{children}{external && <ExternalLink size={12} className="reader-external" aria-hidden="true" />}</a>;
      },
      img: ({ src = '', alt = '' }) => {
        const url = assetUrl(src, document.path, assets);
        // 仓库徽章不属于课程正文；只加载构建中包含的教学图示。
        if (!url) return null;
        return <a className="reader-image" href={url} target="_blank" rel="noreferrer"><img src={url} alt={alt} loading="lazy" /><span>查看完整图示 <ExternalLink size={13} aria-hidden="true" /></span></a>;
      },
      table: ({ children }) => <div className="reader-table" tabIndex={0} role="region" aria-label="可横向滚动的对照表"><table>{children}</table></div>,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    };
    return <article className="reader-document" key={document.path}>
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={components}>{document.markdown}</Markdown>
      <a className="reader-original" href={`${REPOSITORY}/blob/main/${document.path}`} target="_blank" rel="noreferrer">查看原始文档 <ExternalLink size={14} aria-hidden="true" /></a>
    </article>;
  })}</div>;
}
