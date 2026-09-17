/**
 * 只读 SQLite 数据库访问层。
 *
 * 设计借鉴 chatter-clone-craft/agent-service/src/tools/bash.ts 的截断/超时模式,
 * 但用 better-sqlite3 同步连接直查本地文件,不经过 shell。18.7 GB 的库不全部
 * 加载进内存,SQLite 按页读取;连接以只读模式打开,并额外在 SQL 层强制只读,
 * 双重保险防止 agent 误写。
 */
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

/** 单次查询最多返回的行数,避免大结果集拖垮 agent 上下文。 */
const MAX_ROWS = 500;
/** 输出字符上限:保留尾部(最新输出最相关),照搬 bash 工具的截断策略。 */
const MAX_OUTPUT_CHARS = 20_000;
/** busy timeout(毫秒),等待数据库解锁。 */
const BUSY_TIMEOUT_MS = 5_000;

/** 只允许这些 SQL 首关键字(大小写不敏感)。PRAGMA 仅允许只读类。 */
const READONLY_FIRST_TOKENS = new Set([
  'select',
  'with',
  'explain',
  'pragma',
  'values',
]);

/** 只读 PRAGMA 白名单(其余 PRAGMA 可能改库,一律拒绝)。 */
const READONLY_PRAGMAS = new Set([
  'table_info',
  'table_list',
  'table_xinfo',
  'database_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'collation_list',
  'compile_options',
  'function_list',
  'module_list',
  'pragma_list',
  'table_valued',
  'version',
]);

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface DbConfig {
  dbPath: string;
}

let dbInstance: DatabaseType | undefined;

function getDb(dbPath: string): DatabaseType {
  if (dbInstance) return dbInstance;
  const normalized = dbPath.replace(/\\/g, '/');
  dbInstance = new Database(normalized, {
    readonly: true,
    timeout: BUSY_TIMEOUT_MS,
  });
  return dbInstance;
}

/**
 * 校验 SQL 是否只读。首 token 必须在白名单内;PRAGMA 进一步校验其操作名只读。
 * 不做完整 SQL 解析 —— SQLite 的 readonly 模式已是硬保险,这里只是尽早拒绝、
 * 给 agent 清晰的错误反馈,避免它收到底层 "attempt to write a readonly database"。
 */
function assertReadonly(sql: string): void {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    throw new Error('SQL 不能为空');
  }
  const firstTokenMatch = trimmed.match(/^([A-Za-z_]+)/);
  if (!firstTokenMatch) {
    throw new Error(`无法解析 SQL 首关键字,拒绝执行: ${trimmed.slice(0, 60)}`);
  }
  const firstToken = firstTokenMatch[1].toLowerCase();
  if (!READONLY_FIRST_TOKENS.has(firstToken)) {
    throw new Error(
      `仅允许只读查询(SELECT/WITH/EXPLAIN/PRAGMA),拒绝首关键字 "${firstToken}"`,
    );
  }
  if (firstToken === 'pragma') {
    const pragmaNameMatch = trimmed.match(/^pragma\s+([A-Za-z_]+)/i);
    const pragmaName = pragmaNameMatch?.[1]?.toLowerCase() ?? '';
    if (!READONLY_PRAGMAS.has(pragmaName)) {
      throw new Error(`PRAGMA "${pragmaName}" 不在只读白名单内,拒绝执行`);
    }
  }
}

/** 截断到尾部 MAX_OUTPUT_CHARS 字符,并附截断说明(照搬 bash 工具策略)。 */
function truncateTail(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const dropped = text.length - MAX_OUTPUT_CHARS;
  return `[已截断：省略前 ${dropped} 字符]\n` + text.slice(-MAX_OUTPUT_CHARS);
}

/** 将查询结果格式化为 JSON 字符串,超长则整体截断尾部。 */
function formatResult(result: QueryResult): string {
  const json = JSON.stringify(result, null, 2);
  return truncateTail(json);
}

/** 执行只读 SQL,返回结构化结果 + 格式化文本。 */
export function queryDb(config: DbConfig, sql: string): { text: string; result: QueryResult } {
  assertReadonly(sql);
  const db = getDb(config.dbPath);
  const stmt = db.prepare(sql);
  const columns = stmt.columns().map((c) => c.name);
  const allRows = stmt.all() as Record<string, unknown>[];
  const rowCount = allRows.length;
  const truncated = rowCount > MAX_ROWS;
  const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
  const result: QueryResult = { columns, rows, rowCount, truncated };
  if (truncated) {
    result.rows = rows;
  }
  return { text: formatResult(result), result };
}

/** 列出所有表名。 */
export function listTables(config: DbConfig): string {
  const db = getDb(config.dbPath);
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const result = {
    tables: rows.map((r) => r.name),
    count: rows.length,
  };
  return truncateTail(JSON.stringify(result, null, 2));
}

/** 返回某张表的列定义(列名/类型/是否可空/主键)。 */
export function describeTable(config: DbConfig, tableName: string): string {
  const db = getDb(config.dbPath);
  const columns = db.pragma(`table_info(${JSON.stringify(tableName)})`) as Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>;
  if (columns.length === 0) {
    throw new Error(`表 "${tableName}" 不存在或无列信息`);
  }
  const result = {
    table: tableName,
    columns: columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.notnull === 0,
      default: c.dflt_value,
      primaryKey: c.pk > 0,
    })),
  };
  return truncateTail(JSON.stringify(result, null, 2));
}

/** 关闭数据库连接(测试用)。 */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = undefined;
  }
}
