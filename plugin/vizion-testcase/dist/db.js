"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefectDb = getDefectDb;
exports.getEmbeddingDb = getEmbeddingDb;
exports.queryDefectDb = queryDefectDb;
exports.readDefectById = readDefectById;
exports.filterDefectsByKeyword = filterDefectsByKeyword;
exports.loadLinkedDefectIds = loadLinkedDefectIds;
exports.loadTestCases = loadTestCases;
exports.canonicalDefectId = canonicalDefectId;
exports.closeAllDbs = closeAllDbs;
/**
 * SQLite 数据库访问层。
 *
 * 两个数据库连接：
 * - **缺陷数据库**（只读）：DEFECT_DB_PATH 指向 qgate_raw.db，包含 octane_defects /
 *   octane_testcases / octane_traceability_testcases 表。readonly + SQL 层只读双保险。
 * - **嵌入缓存数据库**（可写）：plugin 本地的 data/embeddings.db，缓存嵌入向量
 *   和 TF-IDF 索引，避免重复 API 调用。
 */
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
/** 嵌入缓存数据库路径 — plugin 本地 data/embeddings.db。 */
function getEmbeddingDbPath() {
    const pluginRoot = process.env['PLUGIN_ROOT'] ?? (0, node_path_1.join)(__dirname, '..', '..');
    return process.env['EMBEDDING_DB_PATH'] ?? (0, node_path_1.join)(pluginRoot, 'data', 'embeddings.db');
}
let defectDb;
let embeddingDb;
const BUSY_TIMEOUT_MS = 5_000;
/** 只允许这些 SQL 首关键字（缺陷库只读）。 */
const READONLY_FIRST_TOKENS = new Set([
    'select',
    'with',
    'explain',
    'pragma',
    'values',
]);
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
function assertReadonly(sql) {
    const trimmed = sql.trim();
    if (trimmed.length === 0) {
        throw new Error('SQL 不能为空');
    }
    const firstTokenMatch = trimmed.match(/^([A-Za-z_]+)/);
    if (!firstTokenMatch) {
        throw new Error(`无法解析 SQL 首关键字, 拒绝执行: ${trimmed.slice(0, 60)}`);
    }
    const firstToken = firstTokenMatch[1].toLowerCase();
    if (!READONLY_FIRST_TOKENS.has(firstToken)) {
        throw new Error(`仅允许只读查询 (SELECT/WITH/EXPLAIN/PRAGMA), 拒绝首关键字 "${firstToken}"`);
    }
    if (firstToken === 'pragma') {
        const pragmaNameMatch = trimmed.match(/^pragma\s+([A-Za-z_]+)/i);
        const pragmaName = pragmaNameMatch?.[1]?.toLowerCase() ?? '';
        if (!READONLY_PRAGMAS.has(pragmaName)) {
            throw new Error(`PRAGMA "${pragmaName}" 不在只读白名单内, 拒绝执行`);
        }
    }
}
/** 打开缺陷数据库（只读）。 */
function getDefectDb() {
    const dbPath = process.env['DEFECT_DB_PATH'];
    if (!dbPath) {
        throw new Error('缺少环境变量 DEFECT_DB_PATH');
    }
    if (defectDb)
        return defectDb;
    const normalized = dbPath.replace(/\\/g, '/');
    defectDb = new better_sqlite3_1.default(normalized, { readonly: true, timeout: BUSY_TIMEOUT_MS });
    return defectDb;
}
/** 打开嵌入缓存数据库（可写）。 */
function getEmbeddingDb() {
    if (embeddingDb)
        return embeddingDb;
    const dbPath = getEmbeddingDbPath();
    const dir = (0, node_path_1.dirname)(dbPath);
    if (!(0, node_fs_1.existsSync)(dir)) {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
    }
    embeddingDb = new better_sqlite3_1.default(dbPath, { timeout: BUSY_TIMEOUT_MS });
    embeddingDb.pragma('journal_mode = WAL');
    return embeddingDb;
}
/** 在缺陷数据库上执行只读查询。 */
function queryDefectDb(sql, params = []) {
    assertReadonly(sql);
    const db = getDefectDb();
    const stmt = db.prepare(sql);
    const columns = stmt.columns().map((c) => c.name);
    const allRows = stmt.all(...params);
    const rowCount = allRows.length;
    const MAX_ROWS = 500;
    const truncated = rowCount > MAX_ROWS;
    const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
    return { columns, rows, rowCount, truncated };
}
/** 读取单个缺陷（按 defect_id）。 */
function readDefectById(defectId) {
    const db = getDefectDb();
    const normalized = defectId.replace(/^[Dd]/, '').trim();
    return db
        .prepare('SELECT defect_id, name, severity, software_version, assigned_ecu, '
        + 'lead_model, project, phase, description FROM octane_defects WHERE defect_id = ?')
        .get(normalized);
}
/** 按主题关键词筛选缺陷（精确匹配 project 或 name LIKE）。 */
function filterDefectsByKeyword(keyword, project, limit, offset) {
    const db = getDefectDb();
    const projectParam = project ?? keyword;
    const likePattern = `%${keyword}%`;
    const allRows = db
        .prepare('SELECT defect_id, name, project, phase, status_phase '
        + 'FROM octane_defects '
        + 'WHERE (project = ? COLLATE NOCASE OR name LIKE ? COLLATE NOCASE) '
        + 'ORDER BY defect_id')
        .all(projectParam, likePattern);
    return {
        rows: allRows.slice(offset, offset + limit),
        total: allRows.length,
    };
}
/** 加载已有测试用例关联的缺陷 ID 集合（用于排除已有覆盖）。 */
function loadLinkedDefectIds() {
    const db = getDefectDb();
    const linked = new Set();
    for (const table of ['octane_testcases', 'octane_traceability_testcases']) {
        try {
            const rows = db
                .prepare(`SELECT defect_ids_json FROM ${table} WHERE defect_ids_json IS NOT NULL AND defect_ids_json != ''`)
                .all();
            for (const { defect_ids_json } of rows) {
                try {
                    const ids = JSON.parse(defect_ids_json);
                    if (Array.isArray(ids)) {
                        for (const id of ids) {
                            const normalized = canonicalDefectId(id);
                            if (normalized)
                                linked.add(normalized);
                        }
                    }
                }
                catch {
                    // skip invalid JSON
                }
            }
        }
        catch {
            // table might not exist — skip
        }
    }
    return linked;
}
/** 加载所有测试用例（用于 RAG 索引构建）。 */
function loadTestCases() {
    const db = getDefectDb();
    return db
        .prepare('SELECT test_id AS id, test_name AS name, test_subtype, scope_team, scope_release '
        + 'FROM octane_testcases WHERE test_name IS NOT NULL AND TRIM(test_name) != \'\'')
        .all();
}
/** 规范化缺陷 ID — 去掉 D 前缀，返回纯数字。 */
function canonicalDefectId(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/^(?:d\s*-?\s*)?(\d+)$/i);
    return match?.[1] ?? '';
}
/** 关闭所有数据库连接（测试用）。 */
function closeAllDbs() {
    if (defectDb) {
        defectDb.close();
        defectDb = undefined;
    }
    if (embeddingDb) {
        embeddingDb.close();
        embeddingDb = undefined;
    }
}
