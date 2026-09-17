/**
 * RAG 检索引擎 — PostgreSQL pgvector 后端。
 *
 * 原先使用进程内 TF-IDF + 暴力扫描 16K 测试用例向量。
 * 现在直接查 PG vizion_vectors 数据库的预计算向量（109K 缺陷 + 16K 测试用例，
 * 4096-dim qwen3-embedding-8b），启动近即时，查询一条 SQL 搞定。
 *
 * query embedding 仍通过 Beacon API 计算（embed()），PG 只存储预计算的文档向量。
 */
import { retrieveSimilarTestCasesFromPg } from './pg.js';
import type { SimilarTestCase } from './types.js';

/** 检索相似测试用例 — 委托给 PG pgvector cosine distance 查询。 */
export async function retrieveSimilarTestCases(query: string, topK = 5): Promise<SimilarTestCase[]> {
  return retrieveSimilarTestCasesFromPg(query, topK);
}

/** 格式化 few-shot 上下文。 */
export function formatFewShotExamples(cases: SimilarTestCase[], maxCases = 3): string {
  if (cases.length === 0) return '';
  const lines = ['Here are similar existing test cases in the same domain for reference (structure, naming, granularity):'];
  for (const c of cases.slice(0, maxCases)) {
    lines.push(`- [T${c.test_id}] ${c.name} (similarity: ${c.score.toFixed(2)})`);
  }
  lines.push('Use these as style/structure reference, but generate content specific to the source defect.');
  return lines.join('\n');
}

/** 清除索引缓存 — 兼容旧接口，PG 模式下无内存缓存，空操作。 */
export function clearIndexCache(): void {
  // No-op: PG 模式下无进程内缓存
}
