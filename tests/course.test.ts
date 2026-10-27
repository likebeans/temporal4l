import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAPTERS, documentHeadings, documentLink, readStudyRoute, studyHref } from '../src/course';
import { CourseReader } from '../src/components/CourseReader';

const route = { view: 'read', chapter: 'execution' } as const;

test('课程链接按源文件目录解析，内部课程留在站内，代码与协议边界明确', () => {
  assert.equal(documentLink('worker-recovery-guide.md#等待时恢复', 'docs/learning-path.md', route), studyHref('read', 'recovery', '等待时恢复'));
  assert.equal(documentLink('../README.md#快速启动', 'docs/learning-path.md', route), studyHref('setup', 'execution', '快速启动'));
  assert.equal(documentLink('../readme.md', 'exercises/01-transfer/01.01-document-review/problem/readme.md', route), studyHref('read', 'transfer'));
  assert.equal(documentLink('problem/readme.md', 'exercises/01-transfer/01.01-document-review/readme.md', route), studyHref('read', 'transfer', '自行实现资料审核编排'));
  assert.match(documentLink('../server/workflows.ts', 'docs/learning-path.md', route), /github.com\/likebeans\/temporal4l\/blob\/main\/server\/workflows.ts$/);
  assert.equal(documentLink('javascript:alert(1)', 'docs/learning-path.md', route), '');
  assert.deepEqual(readStudyRoute(studyHref('source', 'recovery', '中文标题')), { view: 'source', chapter: 'recovery', anchor: '中文标题' });
  assert.deepEqual(readStudyRoute('#view=invalid&chapter=missing'), { view: 'read', chapter: 'start', anchor: undefined });
  assert.equal(readStudyRoute('#learning-practice').view, 'notes');
});

test('章节标题生成可分享锚点，不把代码块内容当目录，重复标题不冲突', () => {
  const headings = documentHeadings('# 文档\n## 一、`Signal` 与 Query\n```bash\n## 不是标题\n```\n## 重复\n## 重复');
  assert.deepEqual(headings.map(({ id }) => id), ['文档', '一signal-与-query', '重复', '重复-1']);
  assert.equal(headings.length, 4);
  assert.deepEqual(documentHeadings('```text\n~~~\n## 并非标题\n```\n## 正文').map(({ id }) => id), ['正文']);
  assert.deepEqual(documentHeadings('````text\n```\n## 仍在代码块\n````\n## 正文').map(({ id }) => id), ['正文']);
});

test('真实课程 Markdown 保留图表、代码和折叠内容，清理可执行 HTML', async () => {
  for (const chapter of CHAPTERS) {
    const markdown = await readFile(new URL(`../${chapter.path}`, import.meta.url), 'utf8');
    const html = renderToStaticMarkup(createElement(CourseReader, { documents: [{ path: chapter.path, markdown }], route: { view: 'read', chapter: chapter.id }, assets: {} }));
    assert.ok(html.includes('reader-document'), chapter.id);
    for (const heading of documentHeadings(markdown).filter((item) => item.level <= 3)) {
      assert.ok(html.includes(`id="${heading.id}"`), `${chapter.id}: missing ${heading.id}`);
    }
  }
  const html = renderToStaticMarkup(createElement(CourseReader, {
    documents: [{ path: 'docs/test.md', markdown: '## [阅读](https://example.com)\n\n<details><summary>展开答案</summary>解释</details>\n\n<script>alert(1)</script>\n\n![图](diagrams/test.svg)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```' }],
    route, assets: { '../docs/diagrams/test.svg': '/temporal4l/assets/test.svg' },
  }));
  assert.match(html, /<details><summary>展开答案<\/summary>/);
  assert.match(html, /<table>/);
  assert.match(html, /src="\/temporal4l\/assets\/test.svg"/);
  assert.match(html, /复制代码/);
  assert.doesNotMatch(html, /<script|javascript:/);
  assert.match(html, /<h2 id="阅读"><a href="https:\/\/example.com"/);
  assert.match(html, /<\/a><a class="reader-heading-link"/);
});
