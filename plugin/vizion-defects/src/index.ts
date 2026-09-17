/**
 * vizion-tpm MCP server 入口。
 *
 * 用 @modelcontextprotocol/sdk 的 McpServer 高阶 API(真实 SDK,非 stub,
 * 遵循 CLAUDE.md 测试规范)暴露三个通用查询工具,让 agent pi 式自主探索
 * BMW 缺陷数据库。stdio transport —— LibreChat Agent Plugin 启动本进程,
 * 通过 stdin/stdout 通信。
 *
 * 工具语义照搬 chatter-clone-craft/agent-service/src/agent.ts 的 SYSTEM_BASE:
 * 探结构(list_tables/describe_table)→ 查聚合 → 查明细(query_defects),
 * 全部只读,agent 自主决定查什么。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { queryDb, listTables, describeTable } from './db.js';
import { toCsv, writeExport } from './export.js';

const DB_PATH = process.env['DEFECT_DB_PATH'];
if (!DB_PATH) {
  console.error('[vizion-tpm] 缺少环境变量 DEFECT_DB_PATH');
  process.exit(1);
}

const config = { dbPath: DB_PATH };

/** 导出目录与下载 URL 前缀。缺失时 export_csv 工具不注册,查询工具不受影响。 */
const EXPORT_DIR = process.env['EXPORT_DIR'] ?? '';
const EXPORT_BASE_URL = process.env['EXPORT_BASE_URL'] ?? '';
const exportEnabled = EXPORT_DIR.length > 0 && EXPORT_BASE_URL.length > 0;
if (!exportEnabled) {
  console.error('[vizion-tpm] 未配置 EXPORT_DIR/EXPORT_BASE_URL,export_csv 工具不可用');
}

const server = new McpServer({
  name: 'vizion-tpm',
  version: '0.1.0',
});

server.registerTool('list_tables', {
  description:
    '列出缺陷数据库中的所有表名及数量。探索数据库结构的第一步,先看有哪些表再决定查哪张。',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: listTables(config) }],
}));

server.registerTool('describe_table', {
  description:
    '返回指定表的列定义(列名/类型/是否可空/是否主键)。查数据前先用它了解表结构,避免盲目查询。',
  inputSchema: {
    table: z.string().min(1).describe('要查看结构的表名,如 octane_defects'),
  },
}, async ({ table }) => ({
  content: [{ type: 'text', text: describeTable(config, table) }],
}));

server.registerTool('query_defects', {
  description:
    '对缺陷数据库执行只读 SQL 查询(SELECT/WITH/EXPLAIN/只读 PRAGMA),返回列名+行数据(JSON)。' +
    '单次最多返回 500 行,输出超长时尾部截断。写操作(INSERT/UPDATE/DELETE/DROP)会被拒绝。' +
    '大表务必带 LIMIT。示例:SELECT team, COUNT(*) c FROM octane_defects GROUP BY team ORDER BY c DESC LIMIT 20',
  inputSchema: {
    sql: z.string().min(1).describe('只读 SQL 查询语句'),
  },
}, async ({ sql }) => {
  const { text } = queryDb(config, sql);
  return { content: [{ type: 'text', text }] };
});

if (exportEnabled) {
  server.registerTool('export_csv', {
    description:
      '把已查到的结构化数据导出为 CSV 文件,返回下载链接。' +
      '用于大结果集(>30 行)场景:先用 query_defects 查到数据,再调本工具落盘,' +
      '对话里只给摘要+下载链接,避免把全部行数据贴进回复被截断。' +
      '输入:filename(不含后缀,自动加 .csv)、columns(列名数组)、rows(行数据数组,每行是对象)。',
    inputSchema: {
      filename: z
        .string()
        .min(1)
        .describe('文件名,不含路径和后缀,自动加 .csv。如 defects-high'),
      columns: z.array(z.string()).min(1).describe('列名数组,如 ["defect_id","name","severity"]'),
      rows: z
        .array(z.record(z.string(), z.unknown()))
        .describe('行数据数组,每行是对象,键名对应 columns 中的列名'),
    },
  }, async ({ filename, columns, rows }) => {
    const csv = toCsv(columns, rows);
    const result = writeExport(EXPORT_DIR, filename, csv, rows.length, EXPORT_BASE_URL);
    const text =
      `已导出 ${result.rowCount} 行到 ${filename}.csv\n` +
      `下载链接: ${result.downloadUrl}\n` +
      `本地路径: ${result.path}`;
    return { content: [{ type: 'text', text }] };
  });
}


async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[vizion-tpm] MCP server 已启动,等待工具调用');
}

main().catch((error) => {
  console.error('[vizion-tpm] 启动失败:', error);
  process.exit(1);
});
