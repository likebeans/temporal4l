import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, Code2, ExternalLink, FilePenLine, List, Play, Search, Terminal, Waypoints, X } from 'lucide-react';
import { CHAPTERS, documentHeadings, readStudyRoute, REPOSITORY, studyHref, type StudyView } from '../course';
import type { CourseDocument } from '../course-documents';
import { useLocalDraft } from '../use-local-draft';
import { CourseReader } from './CourseReader';
import { LearningPractice } from './LearningPractice';
import { SourceTool, WalkthroughTool } from './StudyTools';

const tools = [
  { id: 'read', label: '阅读课程', icon: BookOpen },
  { id: 'walkthrough', label: '机制推演', icon: Play },
  { id: 'source', label: '源码解读', icon: Code2 },
  { id: 'notes', label: '自测与笔记', icon: FilePenLine },
] as const;
const isReadChapters = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');

export default function OnlineLearning() {
  const [route, setRoute] = useState(() => readStudyRoute(window.location.hash));
  const [menuOpen, setMenuOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(() => window.matchMedia?.('(min-width: 1201px)').matches ?? true);
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState<Record<string, CourseDocument[]> | null>(null);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);
  const [readChapters, setReadChapters, saved] = useLocalDraft<string[]>('temporal4l.read-chapters.v1', [], isReadChapters);
  const main = useRef<HTMLElement>(null);
  const chapter = CHAPTERS.find((item) => item.id === route.chapter)!;
  const index = CHAPTERS.indexOf(chapter);
  const selectedDocuments = documents?.[route.view === 'setup' ? 'setup' : chapter.id] ?? [];
  const headings = useMemo(() => selectedDocuments.flatMap((document) => documentHeadings(document.markdown).filter((item) => item.level === 2)), [selectedDocuments]);
  const matches = CHAPTERS.filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    const onHashChange = () => {
      if (!window.location.hash.startsWith('#view=') && !['#walkthrough', '#online-source', '#learning-practice', '#local-lab'].includes(window.location.hash)) return;
      setRoute(readStudyRoute(window.location.hash));
      setMenuOpen(false);
      setSearch('');
    };
    window.addEventListener('hashchange', onHashChange);
    let disposed = false;
    void import('../course-documents').then(
      (module) => { if (!disposed) { setDocuments(module.courseDocuments); setAssets(module.courseAssets); } },
      () => { if (!disposed) setLoadError(true); },
    );
    return () => { disposed = true; window.removeEventListener('hashchange', onHashChange); };
  }, []);

  useEffect(() => {
    document.title = `${route.view === 'setup' ? '本地实验准备' : chapter.title} · Temporal4L`;
    if (route.anchor) {
      const target = document.getElementById(route.anchor);
      if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); target.scrollIntoView?.({ block: 'start' }); }
    } else {
      main.current?.focus({ preventScroll: true });
      document.documentElement.scrollTop = 0;
    }
  }, [route, chapter.title, documents]);

  function markRead() {
    setReadChapters((current) => current.includes(chapter.id) ? current.filter((id) => id !== chapter.id) : [...current, chapter.id]);
  }
  const chapterLink = (id: string, view: StudyView = 'read') => studyHref(view, id);

  return <div className="study-shell online-learning">
    <header className="study-header">
      <a className="brand" href={studyHref('read')} aria-label="Temporal4L 课程首页"><span className="brand__mark" aria-hidden="true"><Waypoints size={23} /></span><span className="brand__copy"><strong>Temporal4L<span className="brand-dot">.</span></strong><span>把持久化执行学明白</span></span></a>
      <nav className="study-topnav" aria-label="站点导航"><a href={studyHref('read', chapter.id)} aria-current={route.view !== 'setup' ? 'page' : undefined}>学习中心</a><a href={studyHref('setup', chapter.id)} aria-current={route.view === 'setup' ? 'page' : undefined}><Terminal size={15} aria-hidden="true" />本地实验</a><a href={REPOSITORY} target="_blank" rel="noreferrer">GitHub<ExternalLink size={14} aria-hidden="true" /></a></nav>
      <button className="study-menu-button" type="button" aria-expanded={menuOpen} aria-controls="study-sidebar" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X size={19} aria-hidden="true" /> : <List size={19} aria-hidden="true" />}课程目录</button>
    </header>
    <div className="study-layout">
      <aside className={`study-sidebar${menuOpen ? ' is-open' : ''}`} id="study-sidebar">
        <div className="study-sidebar-intro"><span className="study-overline">THE TEMPORAL FIELD GUIDE</span><h2>从理解到亲手实现</h2><p>循序阅读 · 随时动手 · 留下证据</p></div>
        <label className="study-search"><Search size={16} aria-hidden="true" /><input aria-label="搜索课程章节" placeholder="查找课程，例如：恢复" value={search} onChange={(event) => setSearch(event.target.value)} type="search" /></label>
        <nav aria-label="课程章节">{['认识 Temporal', '理解可靠性', '独立实践'].map((group) => {
          const items = matches.filter((item) => item.group === group);
          return items.length ? <div className="study-nav-group" key={group}><h3>{group}</h3>{items.map((item) => <a href={chapterLink(item.id)} key={item.id} aria-current={route.view === 'read' && item.id === chapter.id ? 'page' : undefined}><span className={`study-chapter-number${readChapters.includes(item.id) ? ' is-read' : ''}`}>{readChapters.includes(item.id) ? <Check size={14} aria-label="已标记读过" /> : String(CHAPTERS.indexOf(item) + 1).padStart(2, '0')}</span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><ChevronRight size={14} aria-hidden="true" /></a>)}</div> : null;
        })}{matches.length === 0 && <p className="study-empty" role="status">没有找到匹配章节，试试“重试”或“Signal”。</p>}</nav>
        <div className="study-reading-state"><BookOpen size={16} aria-hidden="true" /><p><strong>已标记读过 {CHAPTERS.filter((item) => readChapters.includes(item.id)).length} / {CHAPTERS.length} 章</strong><span>{saved ? '保存在此浏览器 · 不代表实验通过' : '浏览器保存不可用 · 本次页面有效'}</span></p></div>
        <a className="study-lab-link" href={studyHref('setup', chapter.id)}><Terminal size={18} aria-hidden="true" /><span><strong>准备好动手了吗？</strong><small>启动本地 Temporal 实验</small></span><ArrowRight size={16} aria-hidden="true" /></a>
      </aside>
      <main className="study-main" id="main-content" tabIndex={-1} ref={main}>
        <div className="study-breadcrumb"><span>学习中心</span><ChevronRight size={13} aria-hidden="true" /><span>{route.view === 'setup' ? '本地实验准备' : chapter.group}</span><span className="study-edition">开源 · 中文 · 实践导向</span></div>
        {route.view !== 'setup' && <>
          <div className="study-chapter-heading"><span className="study-overline">CHAPTER {String(index + 1).padStart(2, '0')} / {String(CHAPTERS.length).padStart(2, '0')}</span><h1>{chapter.title}<span className="study-heading-dot">.</span></h1><p>{chapter.subtitle}。把机制、代码与自己的解释放在一起。</p></div>
          <nav className="study-view-nav" aria-label="章节学习工具">{tools.map(({ id, label, icon: Icon }) => <a key={id} href={studyHref(id, chapter.id)} aria-current={route.view === id ? 'page' : undefined}><Icon size={17} aria-hidden="true" />{label}</a>)}</nav>
        </>}
        {route.view === 'read' && <>
          {chapter.id === 'start' && <section className="study-welcome" aria-labelledby="study-welcome-title"><div><span className="study-tag">一个能带走的学习方法</span><h2 id="study-welcome-title">别急着记 API，<br />先跟着一条订单走。</h2><p>读懂谁在执行、失败后如何继续，再用自己的代码验证。课程、源码和笔记都在这里。</p><a className="study-button study-button--primary" href={studyHref('walkthrough', chapter.id)}>先看一次执行推演<ArrowRight size={16} aria-hidden="true" /></a></div><ol className="study-method"><li><span>01</span><div><strong>先理解</strong><p>按章节阅读，建立执行模型</p></div></li><li><span>02</span><div><strong>再预测</strong><p>推演流程，对照真实源码</p></div></li><li><span>03</span><div><strong>用证据验证</strong><p>在本地做实验，留下自己的解释</p></div></li></ol></section>}
          <div className="study-reading-layout"><div>
            <div className="study-context-note"><BookOpen size={17} aria-hidden="true" /><p>正文可直接在此阅读。文中的创建订单、History 和停机操作指<strong>本地实验室</strong>；在线推演是教学示意。</p></div>
            {documents ? <CourseReader documents={selectedDocuments} assets={assets} route={route} /> : <p className="study-loading" role="status">{loadError ? '课程加载失败，请刷新页面重试。也可从 GitHub 阅读原始文档。' : '正在加载课程内容…'}</p>}
            <div className="study-chapter-completion"><div><strong>能用自己的话解释这一章了吗？</strong><p>标记只记录你的阅读进度；实验结果请写进笔记。</p></div><button className="study-button" type="button" aria-pressed={readChapters.includes(chapter.id)} onClick={markRead}><Check size={16} aria-hidden="true" />{readChapters.includes(chapter.id) ? '已标记读过' : '标记为已读'}</button></div>
            <nav className="study-pagination" aria-label="章节翻页">{index > 0 ? <a href={chapterLink(CHAPTERS[index - 1].id)}><ArrowLeft size={17} aria-hidden="true" /><span><small>上一章</small>{CHAPTERS[index - 1].title}</span></a> : <a href={studyHref('walkthrough', chapter.id)}><Play size={17} aria-hidden="true" /><span><small>换个角度理解</small>用交互推演走一遍</span></a>}{index < CHAPTERS.length - 1 ? <a href={chapterLink(CHAPTERS[index + 1].id)}><span><small>下一章</small>{CHAPTERS[index + 1].title}</span><ArrowRight size={17} aria-hidden="true" /></a> : <a href={studyHref('notes', chapter.id)}><span><small>整理你的收获</small>自测与实验笔记</span><ArrowRight size={17} aria-hidden="true" /></a>}</nav>
          </div><aside className="study-toc"><button className="study-toc-toggle" type="button" aria-expanded={tocOpen} aria-controls="chapter-contents" onClick={() => setTocOpen((open) => !open)}><List size={15} aria-hidden="true" />本章目录<ChevronRight size={14} aria-hidden="true" /></button><nav id="chapter-contents" aria-label="本章目录" hidden={!tocOpen}>{headings.map((item) => <a key={item.id} href={studyHref('read', chapter.id, item.id)}>{item.title.replace(/^\d+\.\s*/, '')}</a>)}</nav><a className="study-toc-action" href={studyHref('source', chapter.id)}><Code2 size={16} aria-hidden="true" />对照本章源码</a></aside></div>
        </>}
        {route.view === 'walkthrough' && <WalkthroughTool key={chapter.id} chapter={chapter.id} />}
        {route.view === 'source' && <SourceTool key={chapter.id} initialTopic={chapter.topic} chapter={chapter.id} />}
        {route.view === 'notes' && <LearningPractice expanded />}
        {route.view === 'setup' && <section className="study-setup"><span className="study-overline">FROM READING TO RUNNING</span><h1>让学习，真正运行起来。</h1><p className="study-description">在线课程帮助你理解；本地环境给你真实的执行、历史和故障证据。</p><div className="study-setup-cards"><div><BookOpen size={22} aria-hidden="true" /><h2>浏览器里的学习中心</h2><p>课程阅读、机制推演、源码、自测与笔记。不需要安装，也不运行 Temporal 后端。</p></div><div><Terminal size={22} aria-hidden="true" /><h2>电脑上的实验室</h2><p>Node 22.13+，推荐 Node 24 LTS。按下方说明启动服务，亲手操作真实工作流。</p></div></div><a className="study-text-link" href={studyHref('setup', chapter.id, '快速启动')}>跳到启动步骤<ArrowDown size={15} aria-hidden="true" /></a>{documents ? <CourseReader documents={selectedDocuments} assets={assets} route={route} /> : <p role="status">{loadError ? '安装文档加载失败，请从 GitHub 查看 README。' : '正在加载安装文档…'}</p>}</section>}
        <footer className="study-footer"><span><strong>Temporal4L</strong> · 社区学习项目 · MIT</span><span>理解机制，尊重证据。</span></footer>
      </main>
    </div>
  </div>;
}
