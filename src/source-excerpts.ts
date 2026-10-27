import { LEARNING_TOPICS, type LearningSourcePath, type LearningTopicId, type SourceReference } from './learning-catalog';

export interface SourceExcerpt {
  file: LearningSourcePath;
  symbol: string;
  startLine: number;
  endLine: number;
  code: string;
}

export function extractSource(source: string, reference: SourceReference): SourceExcerpt {
  const start = source.indexOf(reference.from);
  const end = reference.until ? source.indexOf(reference.until, start + reference.from.length) : source.length;
  if (start < 0 || end < 0) throw new Error(`教学源码定位失效：${reference.file} · ${reference.symbol}`);
  const code = source.slice(start, end).trimEnd();
  const startLine = source.slice(0, start).split('\n').length;
  return {
    file: reference.file,
    symbol: reference.symbol,
    startLine,
    endLine: startLine + code.split('\n').length - 1,
    code,
  };
}

export function collectSourceExcerpts(sources: Record<LearningSourcePath, string>): Record<LearningTopicId, SourceExcerpt[]> {
  return Object.fromEntries(LEARNING_TOPICS.map((topic) => [
    topic.id, topic.sources.map((reference) => extractSource(sources[reference.file], reference)),
  ])) as Record<LearningTopicId, SourceExcerpt[]>;
}
