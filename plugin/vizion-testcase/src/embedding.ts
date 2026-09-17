/**
 * 嵌入向量 — 远程 Beacon embedding API + 本地 SQLite 缓存。
 *
 * 直连 BMW Beacon API (https://beaconapi.bmwbrill.cn) 的 OpenAI 兼容
 * /v1/embeddings endpoint，模型 qwen3-embedding-8b。
 * 不依赖 GLM-proxy 或 vizion-lab 的 Python sentence-transformers。
 *
 * 嵌入向量按文本 SHA-256 hash 缓存到 plugin 本地 SQLite，避免重复 API 调用。
 */
import { createHash } from 'node:crypto';
import { getEmbeddingDb } from './db.js';

const EMBEDDING_API_URL = process.env['EMBEDDING_API_URL'] ?? 'https://beaconapi.bmwbrill.cn/project-poc/v1/embeddings';
const EMBEDDING_API_KEY = process.env['EMBEDDING_API_KEY'] ?? '';
const EMBEDDING_MODEL = process.env['EMBEDDING_MODEL'] ?? 'qwen3-embedding-8b';
const EMBEDDING_BATCH_SIZE = parseInt(process.env['EMBEDDING_BATCH_SIZE'] ?? '32', 10);
const EMBEDDING_TIMEOUT_MS = parseInt(process.env['EMBEDDING_TIMEOUT_MS'] ?? '120000', 10);

let tableInitialized = false;

/** 初始化嵌入缓存表（懒加载）。 */
function initCacheTable(): void {
  if (tableInitialized) return;
  const db = getEmbeddingDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      text_hash TEXT PRIMARY KEY,
      text_content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dim INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  tableInitialized = true;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** 从缓存读取嵌入向量（返回 Float64Array 或 undefined）。 */
function readFromCache(textHash: string): Float64Array | undefined {
  const db = getEmbeddingDb();
  const row = db
    .prepare('SELECT embedding, dim FROM embeddings WHERE text_hash = ?')
    .get(textHash) as { embedding: Buffer; dim: number } | undefined;
  if (!row) return undefined;
  return new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8);
}

/** 写入嵌入向量到缓存。 */
function writeToCache(textHash: string, text: string, vector: Float64Array): void {
  const db = getEmbeddingDb();
  const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.prepare(
    'INSERT OR REPLACE INTO embeddings (text_hash, text_content, embedding, dim) VALUES (?, ?, ?, ?)',
  ).run(textHash, text, buffer, vector.length);
}

/** L2 归一化。 */
function normalize(vector: number[]): Float64Array {
  const arr = new Float64Array(vector);
  let norm = 0;
  for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  const eps = 1e-12;
  const result = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) result[i] = arr[i] / Math.max(norm, eps);
  return result;
}

/** Cosine 相似度（假设向量已归一化 — 点积即 cosine）。 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

/** 调用远程 embedding API 批量获取向量。 */
async function callEmbeddingApi(texts: string[]): Promise<number[][]> {
  if (!EMBEDDING_API_KEY) {
    throw new Error('缺少环境变量 EMBEDDING_API_KEY');
  }

  const response = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Embedding API ${response.status}: ${errorBody}`);
  }

  const payload = await response.json() as { data?: { embedding?: number[] }[] };
  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new Error('Embedding API response missing data array');
  }
  return data.map((item) => item.embedding ?? []);
}

/**
 * 批量嵌入文本 — 先查缓存，miss 的调远程 API。
 * 返回归一化向量数组（与输入顺序一致）。
 */
export async function embed(texts: string[]): Promise<Float64Array[]> {
  if (texts.length === 0) return [];

  initCacheTable();
  const results: (Float64Array | undefined)[] = new Array(texts.length);
  const missIndices: number[] = [];
  const missTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const hash = hashText(texts[i]!);
    const cached = readFromCache(hash);
    if (cached) {
      results[i] = cached;
    } else {
      missIndices.push(i);
      missTexts.push(texts[i]!);
    }
  }

  for (let start = 0; start < missTexts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = missTexts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const batchIndices = missIndices.slice(start, start + EMBEDDING_BATCH_SIZE);
    const vectors = await callEmbeddingApi(batch);
    for (let j = 0; j < vectors.length; j++) {
      const normalized = normalize(vectors[j]!);
      const text = batch[j]!;
      const hash = hashText(text);
      writeToCache(hash, text, normalized);
      results[batchIndices[j]!] = normalized;
    }
  }

  return results as Float64Array[];
}

/** 嵌入单个文本（带缓存）。 */
export async function embedOne(text: string): Promise<Float64Array> {
  const [result] = await embed([text]);
  return result;
}
