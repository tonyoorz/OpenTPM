/**
 * PostgreSQL + pgvector 检索 — 直接复用 vizion-lab 预建的向量索引。
 *
 * vizion-lab 的 `scripts/pgvector_import.py` 已将 109,625 条 defect 和 16,842 条
 * testcase 用 qwen3-embedding-8b (4096 维) 向量化后写入 PG pgvector。本模块直接查
 * PG 做向量相似度搜索，不需要调 Beacon API、不需要本地 embed、不需要重建索引。
 *
 * PG schema:
 *   defect_vectors(defect_id, name, project, tproject, problem_severity, team,
 *                  embedding_text, text_hash, embedding vector(4096), model_name, created_at)
 *   testcase_vectors(test_id, test_name, test_subtype, scope_team, scope_release,
 *                   embedding_text, text_hash, embedding vector(4096), model_name, created_at)
 *
 * 连接通过环境变量 PG_CONNECTION_STRING 配置，
 * 默认 `postgresql://postgres:admin@localhost:5432/vizion_vectors`。
 */
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { embed } from './embedding.js';
import type { SimilarDefect, SimilarTestCase } from './types.js';

const PG_CONN_STR =
  process.env['PG_CONNECTION_STRING'] ??
  'postgresql://postgres:admin@localhost:5432/vizion_vectors';

let pool: Pool | undefined;

function getPool(): Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: PG_CONN_STR, max: 4 });
  return pool;
}

interface DefectVectorRow {
  defect_id: string;
  name: string;
  project: string | null;
  tproject: string | null;
  problem_severity: string | null;
  team: string | null;
  distance: number;
}

interface TestCaseVectorRow {
  test_id: string;
  test_name: string;
  test_subtype: string | null;
  scope_team: string | null;
  scope_release: string | null;
  distance: number;
}

const EMBEDDING_DIM = 4096;

function vectorLiteral(vec: Float64Array): string {
  let parts = '[';
  for (let i = 0; i < vec.length; i++) {
    if (i > 0) parts += ',';
    parts += vec[i]!.toFixed(8);
  }
  return parts + ']';
}

/** 检索相似缺陷 — 通过 query embedding 在 PG pgvector 中做 cosine 距离搜索。 */
export async function retrieveSimilarDefects(
  query: string,
  topK = 10,
): Promise<SimilarDefect[]> {
  const effectiveTopK = Math.min(Math.max(topK, 1), 30);
  const [queryVec] = await embed([query]);
  if (!queryVec || queryVec.length !== EMBEDDING_DIM) {
    throw new Error(`query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryVec?.length ?? 0}`);
  }

  const client = await getPool().connect();
  try {
    const rows = await client.query<DefectVectorRow>(
      `SELECT defect_id, name, project, tproject, problem_severity, team,
              embedding <=> $1::vector AS distance
       FROM defect_vectors
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral(queryVec), effectiveTopK],
    );

    return rows.rows.map((row) => ({
      defect_id: row.defect_id,
      name: row.name ?? '',
      score: Math.round((1 - row.distance) * 1000) / 1000,
      project: row.project ?? '',
      tproject: row.tproject ?? '',
      problem_severity: row.problem_severity ?? '',
      team: row.team ?? '',
    }));
  } finally {
    client.release();
  }
}

/** 检索相似测试用例 — 通过 query embedding 在 PG pgvector 中做 cosine 距离搜索。 */
export async function retrieveSimilarTestCasesFromPg(
  query: string,
  topK = 5,
): Promise<SimilarTestCase[]> {
  const effectiveTopK = Math.min(Math.max(topK, 1), 30);
  const [queryVec] = await embed([query]);
  if (!queryVec || queryVec.length !== EMBEDDING_DIM) {
    throw new Error(`query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryVec?.length ?? 0}`);
  }

  const client = await getPool().connect();
  try {
    const rows = await client.query<TestCaseVectorRow>(
      `SELECT test_id, test_name, test_subtype, scope_team, scope_release,
              embedding <=> $1::vector AS distance
       FROM testcase_vectors
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral(queryVec), effectiveTopK],
    );

    return rows.rows.map((row) => ({
      test_id: row.test_id,
      name: row.test_name ?? '',
      score: Math.round((1 - row.distance) * 1000) / 1000,
      team: row.scope_team ?? '',
      release: row.scope_release ?? '',
      subtype: row.test_subtype ?? '',
    }));
  } finally {
    client.release();
  }
}

/** 关闭 PG 连接池（测试用）。 */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
