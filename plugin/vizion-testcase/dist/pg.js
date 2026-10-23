"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveSimilarDefects = retrieveSimilarDefects;
exports.retrieveSimilarTestCasesFromPg = retrieveSimilarTestCasesFromPg;
exports.closePool = closePool;
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
const pg_1 = __importDefault(require("pg"));
const embedding_js_1 = require("./embedding.js");
const PG_CONN_STR = process.env['PG_CONNECTION_STRING'] ??
    'postgresql://postgres:admin@localhost:5432/vizion_vectors';
let pool;
function getPool() {
    if (pool)
        return pool;
    pool = new pg_1.default.Pool({ connectionString: PG_CONN_STR, max: 4 });
    return pool;
}
const EMBEDDING_DIM = 4096;
function vectorLiteral(vec) {
    let parts = '[';
    for (let i = 0; i < vec.length; i++) {
        if (i > 0)
            parts += ',';
        parts += vec[i].toFixed(8);
    }
    return parts + ']';
}
/** 检索相似缺陷 — 通过 query embedding 在 PG pgvector 中做 cosine 距离搜索。 */
async function retrieveSimilarDefects(query, topK = 10) {
    const effectiveTopK = Math.min(Math.max(topK, 1), 30);
    const [queryVec] = await (0, embedding_js_1.embed)([query]);
    if (!queryVec || queryVec.length !== EMBEDDING_DIM) {
        throw new Error(`query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryVec?.length ?? 0}`);
    }
    const client = await getPool().connect();
    try {
        const rows = await client.query(`SELECT defect_id, name, project, tproject, problem_severity, team,
              embedding <=> $1::vector AS distance
       FROM defect_vectors
       ORDER BY embedding <=> $1::vector
       LIMIT $2`, [vectorLiteral(queryVec), effectiveTopK]);
        return rows.rows.map((row) => ({
            defect_id: row.defect_id,
            name: row.name ?? '',
            score: Math.round((1 - row.distance) * 1000) / 1000,
            project: row.project ?? '',
            tproject: row.tproject ?? '',
            problem_severity: row.problem_severity ?? '',
            team: row.team ?? '',
        }));
    }
    finally {
        client.release();
    }
}
/** 检索相似测试用例 — 通过 query embedding 在 PG pgvector 中做 cosine 距离搜索。 */
async function retrieveSimilarTestCasesFromPg(query, topK = 5) {
    const effectiveTopK = Math.min(Math.max(topK, 1), 30);
    const [queryVec] = await (0, embedding_js_1.embed)([query]);
    if (!queryVec || queryVec.length !== EMBEDDING_DIM) {
        throw new Error(`query embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${queryVec?.length ?? 0}`);
    }
    const client = await getPool().connect();
    try {
        const rows = await client.query(`SELECT test_id, test_name, test_subtype, scope_team, scope_release,
              embedding <=> $1::vector AS distance
       FROM testcase_vectors
       ORDER BY embedding <=> $1::vector
       LIMIT $2`, [vectorLiteral(queryVec), effectiveTopK]);
        return rows.rows.map((row) => ({
            test_id: row.test_id,
            name: row.test_name ?? '',
            score: Math.round((1 - row.distance) * 1000) / 1000,
            team: row.scope_team ?? '',
            release: row.scope_release ?? '',
            subtype: row.test_subtype ?? '',
        }));
    }
    finally {
        client.release();
    }
}
/** 关闭 PG 连接池（测试用）。 */
async function closePool() {
    if (pool) {
        await pool.end();
        pool = undefined;
    }
}
