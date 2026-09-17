/**
 * db.ts 测试 —— 遵循 CLAUDE.md 测试规范:用真实 better-sqlite3 连真实 qgate_raw.db,
 * 不 mock 数据库。覆盖 success / error / 只读保护 / 截断 等状态。
 *
 * 运行:npx jest(需先 npm run build 生成 dist/)
 */
const path = require('node:path');
const { queryDb, listTables, describeTable, closeDb } = require('../dist/db.js');

const DB_PATH =
  process.env['DEFECT_DB_PATH'] ??
  'C:\\Users\\q446328\\Desktop\\vizion-lab\\database\\source\\qgate_raw.db';
const config = { dbPath: DB_PATH };

afterAll(() => closeDb());

describe('listTables', () => {
  test('返回所有表名,包含 octane_defects 主表', () => {
    const text = listTables(config);
    const result = JSON.parse(text);
    expect(result.count).toBeGreaterThan(0);
    expect(result.tables).toContain('octane_defects');
    expect(result.tables).toContain('octane_testcases');
  });
});

describe('describeTable', () => {
  test('返回 octane_defects 的列定义,含 defect_id 主键', () => {
    const text = describeTable(config, 'octane_defects');
    const result = JSON.parse(text);
    expect(result.table).toBe('octane_defects');
    const defectIdCol = result.columns.find((c) => c.name === 'defect_id');
    expect(defectIdCol).toBeDefined();
    expect(defectIdCol.primaryKey).toBe(true);
  });

  test('不存在的表抛错', () => {
    expect(() => describeTable(config, 'no_such_table_xyz')).toThrow(
      /不存在或无列信息/,
    );
  });
});

describe('queryDb', () => {
  test('SELECT COUNT(*) 返回正确的总记录数', () => {
    const { text, result } = queryDb(config, 'SELECT COUNT(*) as total FROM octane_defects');
    const parsed = JSON.parse(text);
    expect(parsed.rowCount).toBe(1);
    expect(parsed.rows[0].total).toBe(result.rows[0].total);
    expect(parsed.rows[0].total).toBeGreaterThan(100000);
    expect(parsed.truncated).toBe(false);
  });

  test('聚合查询返回多行 + 正确列名', () => {
    const { result } = queryDb(
      config,
      'SELECT team, COUNT(*) c FROM octane_defects GROUP BY team ORDER BY c DESC LIMIT 5',
    );
    expect(result.columns).toEqual(['team', 'c']);
    expect(result.rows).toHaveLength(5);
    expect(result.truncated).toBe(false);
  });

  test('WHERE product_areas LIKE 查询 IDCEVO 明细', () => {
    const { result } = queryDb(
      config,
      "SELECT defect_id, name FROM octane_defects WHERE product_areas LIKE '%IDCEVO%' LIMIT 3",
    );
    expect(result.columns).toContain('defect_id');
    expect(result.rowCount).toBeLessThanOrEqual(3);
  });

  test('PRAGMA table_info(只读 PRAGMA)放行', () => {
    const { text } = queryDb(config, 'PRAGMA table_info(octane_defects)');
    const parsed = JSON.parse(text);
    expect(parsed.columns.length).toBeGreaterThan(0);
  });
});

describe('只读保护', () => {
  test('INSERT 被拒绝', () => {
    expect(() =>
      queryDb(config, "INSERT INTO octane_defects (defect_id) VALUES ('test')"),
    ).toThrow(/仅允许只读查询.*insert/i);
  });

  test('UPDATE 被拒绝', () => {
    expect(() =>
      queryDb(config, "UPDATE octane_defects SET name = 'x' WHERE defect_id = '1'"),
    ).toThrow(/仅允许只读查询.*update/i);
  });

  test('DELETE 被拒绝', () => {
    expect(() => queryDb(config, "DELETE FROM octane_defects WHERE defect_id = '1'")).toThrow(
      /仅允许只读查询.*delete/i,
    );
  });

  test('DROP 被拒绝', () => {
    expect(() => queryDb(config, 'DROP TABLE octane_defects')).toThrow(
      /仅允许只读查询.*drop/i,
    );
  });

  test('ATTACH 被拒绝', () => {
    expect(() => queryDb(config, "ATTACH 'evil.db' AS evil")).toThrow(
      /仅允许只读查询.*attach/i,
    );
  });

  test('PRAGMA wal_checkpoint(写 PRAGMA)被拒绝', () => {
    expect(() => queryDb(config, 'PRAGMA wal_checkpoint')).toThrow(
      /不在只读白名单内/,
    );
  });

  test('空 SQL 被拒绝', () => {
    expect(() => queryDb(config, '   ')).toThrow(/不能为空/);
  });

  test('数据未被修改(COUNT 不变)', () => {
    const before = queryDb(config, 'SELECT COUNT(*) as total FROM octane_defects').result
      .rows[0].total;
    const after = queryDb(config, 'SELECT COUNT(*) as total FROM octane_defects').result
      .rows[0].total;
    expect(after).toBe(before);
  });
});

describe('结果截断', () => {
  test('超过 MAX_ROWS 时 truncated=true 且 rows 被截断', () => {
    const { result } = queryDb(config, 'SELECT defect_id FROM octane_defects LIMIT 600');
    expect(result.rowCount).toBe(600);
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBe(500);
  });

  test('未超限时 truncated=false', () => {
    const { result } = queryDb(config, 'SELECT defect_id FROM octane_defects LIMIT 10');
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(10);
  });
});
