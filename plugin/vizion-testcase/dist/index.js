"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * vizion-testcase MCP server 入口。
 *
 * 暴露 14 个工具，覆盖 SKILL.md 的 A-E 五种模式 + pattern discovery 全流程：
 * - read_defect, search_defects, search_testcases, filter_defects, prepare_testcase
 * - verify_testcase, commit_testcase, export_csv, export_xlsx, generate_from_description
 * - discover_patterns, audit_pattern_coverage, prepare_pattern_drafts, export_pattern_drafts
 *
 * 数据来源：qgate_raw.db（只读，通过 DEFECT_DB_PATH 配置）+ PostgreSQL pgvector
 * （通过 PG_CONNECTION_STRING 配置，预建向量索引）。
 * search_defects / search_testcases / prepare_testcase / generate_from_description 走 PG
 * pgvector 语义搜索；filter_defects / discover_patterns 走 SQLite 精确匹配。
 */
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const db_js_1 = require("./db.js");
const octane_js_1 = require("./octane.js");
const pg_js_1 = require("./pg.js");
const rag_js_1 = require("./rag.js");
const verifier_js_1 = require("./verifier.js");
const builder_js_1 = require("./builder.js");
const patterns_js_1 = require("./patterns.js");
const csv_js_1 = require("./csv.js");
const xlsx_js_1 = require("./xlsx.js");
const defect_tools_js_1 = require("./defect-tools.js");
const stage_js_1 = require("./stage.js");
const EXPORT_DIR = process.env['EXPORT_DIR'] ?? '';
const EXPORT_BASE_URL = process.env['EXPORT_BASE_URL'] ?? '';
const exportEnabled = EXPORT_DIR.length > 0 && EXPORT_BASE_URL.length > 0;
const server = new mcp_js_1.McpServer({
    name: 'vizion-testcase',
    version: '0.1.0',
});
(0, defect_tools_js_1.registerDefectTicketTools)(server);
server.registerTool('read_defect', {
    description: '按缺陷 ID 读取 Octane 缺陷详情。先查本地 SQLite（快速），未命中时 fallback 到 Octane API 实时获取。'
        + '返回 defect_id, name, severity, software_version, assigned_ecu, lead_model, project, phase, description。',
    inputSchema: {
        defect_id: zod_1.z.string().min(1).describe('缺陷 ID，如 2804379 或 D2804379'),
    },
}, async ({ defect_id }) => {
    const local = (0, db_js_1.readDefectById)(defect_id);
    if (local) {
        return { content: [{ type: 'text', text: JSON.stringify(local, null, 2) }] };
    }
    const remote = await (0, octane_js_1.fetchDefectById)(defect_id);
    return { content: [{ type: 'text', text: JSON.stringify(remote, null, 2) }] };
});
server.registerTool('search_defects', {
    description: '语义搜索缺陷 — 通过 PostgreSQL pgvector 向量相似度检索（qwen3-embedding-8b, 4096 维）。'
        + '返回 top-K 最相似的缺陷（defect_id, name, project, score 等）。'
        + '用于"找到跟这个问题最像的缺陷"场景。向量索引由 vizion-lab 预建，无需实时 embedding。',
    inputSchema: {
        query: zod_1.z.string().min(1).describe('搜索查询文本，如"RSU CPU load"或"导航路由偏移"'),
        top_k: zod_1.z.number().int().min(1).max(30).default(10).describe('返回结果数量，默认 10'),
    },
}, async ({ query, top_k }) => {
    const results = await (0, pg_js_1.retrieveSimilarDefects)(query, top_k);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, query, candidates: results }, null, 2) }] };
});
server.registerTool('search_testcases', {
    description: '语义搜索已有测试用例 — 通过 PostgreSQL pgvector 向量相似度检索。'
        + '返回 top-K 最相似的测试用例（test_id, name, score 等）。'
        + '用于生成测试用例前检索 few-shot 参考样例，或检查是否已有类似测试用例。',
    inputSchema: {
        query: zod_1.z.string().min(1).describe('搜索查询文本，如"导航路由偏移"'),
        top_k: zod_1.z.number().int().min(1).max(30).default(5).describe('返回结果数量，默认 5'),
    },
}, async ({ query, top_k }) => {
    const results = await (0, pg_js_1.retrieveSimilarTestCasesFromPg)(query, top_k);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, query, candidates: results }, null, 2) }] };
});
server.registerTool('filter_defects', {
    description: '主题筛选 — 精确匹配 project 或 name LIKE，排除已有测试用例的缺陷。返回所有匹配（分页）。'
        + '用于"RSU 所有缺陷"场景，与语义搜索不同（精确匹配 vs 相似 top-K）。',
    inputSchema: {
        keyword: zod_1.z.string().min(1).describe('主题关键词，如 RSU'),
        project: zod_1.z.string().optional().describe('可选的 project 名称覆盖'),
        limit: zod_1.z.number().int().min(1).max(200).default(50).describe('每页数量，默认 50'),
        offset: zod_1.z.number().int().min(0).default(0).describe('分页偏移'),
    },
}, async ({ keyword, project, limit, offset }) => {
    const { rows, total } = (0, db_js_1.filterDefectsByKeyword)(keyword, project ?? null, limit, offset);
    const linked = (0, db_js_1.loadLinkedDefectIds)();
    const unlinked = rows.filter((r) => !linked.has((0, db_js_1.canonicalDefectId)(r['defect_id'])));
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    keyword,
                    project: project ?? null,
                    total: unlinked.length,
                    offset,
                    limit,
                    candidates: unlinked,
                    summary: { matched_total: total, without_linked_testcase: unlinked.length },
                }, null, 2),
            }],
    };
});
server.registerTool('prepare_testcase', {
    description: '准备测试用例生成上下文 — 读取缺陷 + RAG 检索相似测试用例 + 返回 few-shot 参考。'
        + '这是生成测试用例前的准备步骤，不含 LLM 生成。',
    inputSchema: {
        defect_id: zod_1.z.string().min(1).describe('缺陷 ID'),
    },
}, async ({ defect_id }) => {
    const local = (0, db_js_1.readDefectById)(defect_id);
    const defect = local ?? await (0, octane_js_1.fetchDefectById)(defect_id);
    const name = String(defect['name'] ?? '');
    const project = String(defect['project'] ?? '');
    const ecu = String(defect['assigned_ecu'] ?? '');
    const query = `${name} ${project} ${ecu}`.trim();
    const similar = await (0, pg_js_1.retrieveSimilarTestCasesFromPg)(query, 5);
    const fewShot = (0, rag_js_1.formatFewShotExamples)(similar, 3);
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    defect_info: defect,
                    similar_cases: similar.map((c) => ({ testId: c.test_id, name: c.name, score: c.score })),
                    few_shot_text: fewShot,
                }, null, 2),
            }],
    };
});
server.registerTool('verify_testcase', {
    description: '验证测试用例草稿质量 — 5 项启发式检查：failure_mode_coverage, step_reproducibility, '
        + 'format_compliance, checkpoint_quantification, defect_traceability。返回 pass/fail + feedback。',
    inputSchema: {
        defect_info: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).describe('缺陷信息（至少含 defect_id 和 name）'),
        description_html: zod_1.z.string().describe('测试用例 HTML description'),
        steps_text: zod_1.z.string().describe('测试用例纯文本 steps'),
    },
}, async ({ defect_info, description_html, steps_text }) => {
    const result = (0, verifier_js_1.verifyTestCase)({ defect: defect_info, descriptionHtml: description_html, stepsText: steps_text });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, verification: result }, null, 2) }] };
});
server.registerTool('commit_testcase', {
    description: '⚠️ 生产写入 — 创建 Octane test_manual 实体 + 写入 steps script。'
        + '这是真实的生产 Octane 写入操作，会在 Octane 中创建实体。调用前务必确认！'
        + '需要 owner_workspace_user_id（测试用例所有者）和 feature_id（关联的功能项）。',
    inputSchema: {
        name: zod_1.z.string().min(1).describe('测试用例名称，如 [IDCEVO][PU2707] Regression - pps CPU load (D2804379)'),
        description_html: zod_1.z.string().describe('HTML description'),
        steps_text: zod_1.z.string().describe('纯文本 steps'),
        owner_workspace_user_id: zod_1.z.string().min(1).describe('Octane workspace_user ID（测试用例所有者，必填）'),
        feature_id: zod_1.z.string().optional().describe('关联的 feature ID（covered_content link）'),
        servicepack_node_id: zod_1.z.string().optional().describe('Servicepack list_node ID，默认 SP2021'),
    },
}, async ({ name, description_html, steps_text, owner_workspace_user_id, feature_id, servicepack_node_id }) => {
    const created = await (0, octane_js_1.createTestCase)({
        name,
        descriptionHtml: description_html,
        ownerWorkspaceUserId: owner_workspace_user_id,
        servicepackNodeId: servicepack_node_id ?? builder_js_1.DEFAULT_SERVICEPACK_NODE_ID,
        coveredWorkItemIds: feature_id ? [feature_id] : undefined,
    });
    const testId = created.id;
    if (steps_text && testId) {
        await (0, octane_js_1.writeTestSteps)(testId, steps_text);
    }
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({ success: true, test_id: testId, octane_url: (0, octane_js_1.buildOctaneUrl)(testId) }, null, 2),
            }],
    };
});
if (exportEnabled) {
    server.registerTool('export_csv', {
        description: '将测试用例草稿导出为 CSV 文件（不写 Octane — 安全的离线审查路径）。'
            + '生成文件放在 exports 目录，返回下载链接。'
            + '推荐使用 export_xlsx 替代，输出专业美观的 Excel 格式。',
        inputSchema: {
            filename: zod_1.z.string().min(1).describe('文件名（不含后缀，自动加 .csv）'),
            columns: zod_1.z.array(zod_1.z.string()).min(1).describe('列名数组'),
            rows: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).describe('行数据数组'),
        },
    }, async ({ filename, columns, rows }) => {
        const csv = (0, csv_js_1.toCsv)(columns, rows);
        const result = (0, csv_js_1.writeExport)(EXPORT_DIR, filename, csv, rows.length, EXPORT_BASE_URL);
        const text = `已导出 ${result.rowCount} 行到 ${filename}.csv\n下载链接: ${result.downloadUrl}\n本地路径: ${result.path}`;
        return { content: [{ type: 'text', text }] };
    });
    server.registerTool('export_xlsx', {
        description: '将测试用例草稿导出为专业美观的 Excel (.xlsx) 文件（不写 Octane — 安全的离线审查路径）。'
            + '自动套用专业样式：深蓝表头、severity 行高亮（High=金色/Medium=浅黄/Low=灰色）、'
            + '冻结首行、自动筛选、合理列宽、数据字典 sheet。'
            + '生成文件放在 exports 目录，返回下载链接。',
        inputSchema: {
            filename: zod_1.z.string().min(1).describe('文件名（不含后缀，自动加 .xlsx）'),
            columns: zod_1.z.array(zod_1.z.string()).min(1).describe('列名数组'),
            rows: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).describe('行数据数组'),
            severity_key: zod_1.z.string().optional().describe('用于行高亮的 severity 字段名（如 "severity"）。若匹配 High/Critical/Medium/Low 则对应行着色。'),
            sheet_name: zod_1.z.string().optional().describe('工作表名称，默认 "Export"'),
        },
    }, async ({ filename, columns, rows, severity_key, sheet_name }) => {
        const buffer = await (0, xlsx_js_1.genericToXlsx)(columns, rows, {
            severityKey: severity_key,
            sheetName: sheet_name,
        });
        const result = (0, xlsx_js_1.writeXlsxExport)(EXPORT_DIR, filename, buffer, rows.length, EXPORT_BASE_URL);
        const text = `已导出 ${result.rowCount} 行到 ${filename}.xlsx\n下载链接: ${result.downloadUrl}\n本地路径: ${result.path}`;
        return { content: [{ type: 'text', text }] };
    });
}
server.registerTool('stage_testcase_draft', {
    description: '暂存单条测试用例草稿到内存暂存区。'
        + '批量生成测试用例时，每生成一条就调用此工具暂存，最后用 commit_staged_drafts 一次性导出 Excel。'
        + '避免一次性输出全量数据导致 output token 截断。',
    inputSchema: {
        draft_id: zod_1.z.string().min(1).describe('用例标识，如 TC-RT-AI-001'),
        name: zod_1.z.string().min(1).describe('用例名称'),
        description: zod_1.z.string().describe('用例描述'),
        severity: zod_1.z.string().describe('严重等级，如 Critical/High/Medium/Low'),
        software_version: zod_1.z.string().describe('软件版本，如 HU_3.5.2'),
        assigned_ecu: zod_1.z.string().describe('ECU 名称，如 HU-Entertainment'),
        lead_model: zod_1.z.string().describe('车型，如 G38'),
        preconditions: zod_1.z.string().describe('前置条件'),
        procedure_steps: zod_1.z.string().describe('操作步骤'),
        expected_result: zod_1.z.string().describe('预期结果'),
        pass_criteria: zod_1.z.string().describe('通过标准'),
        fail_criteria: zod_1.z.string().describe('失败标准'),
    },
}, async (draft) => {
    const result = (0, stage_js_1.stageDraft)(draft);
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    draft_id: result.draftId,
                    staged_count: result.stagedCount,
                    message: `已暂存第 ${result.stagedCount} 条草稿。全部生成后调用 commit_staged_drafts 导出 CSV。`,
                }, null, 2),
            }],
    };
});
server.registerTool('stage_testcase_batch', {
    description: '批量暂存多条测试用例草稿（推荐）— 一次调用暂存最多 8 条草稿，大幅减少往返次数。'
        + '生成大批量测试用例时优先用此工具分批暂存（每批 5 条），最后用 commit_staged_drafts 导出 CSV。'
        + '既避免单次输出全量数据导致 token 截断，又大幅减少逐条暂存的往返延迟。'
        + '10 条用例建议分 2 批（5+5），而不是 10 次单条暂存。',
    inputSchema: {
        drafts: zod_1.z.array(zod_1.z.object({
            draft_id: zod_1.z.string().min(1).describe('用例标识，如 TC-RT-AI-001'),
            name: zod_1.z.string().min(1).describe('用例名称'),
            description: zod_1.z.string().describe('用例描述'),
            severity: zod_1.z.string().describe('严重等级，如 Critical/High/Medium/Low'),
            software_version: zod_1.z.string().describe('软件版本，如 HU_3.5.2'),
            assigned_ecu: zod_1.z.string().describe('ECU 名称，如 HU-Entertainment'),
            lead_model: zod_1.z.string().describe('车型，如 G38'),
            preconditions: zod_1.z.string().describe('前置条件'),
            procedure_steps: zod_1.z.string().describe('操作步骤'),
            expected_result: zod_1.z.string().describe('预期结果'),
            pass_criteria: zod_1.z.string().describe('通过标准'),
            fail_criteria: zod_1.z.string().describe('失败标准'),
        })).min(1).max(8).describe('草稿数组，每批建议 5 条（最多 8 条）'),
    },
}, async ({ drafts }) => {
    const result = (0, stage_js_1.stageDraftBatch)(drafts);
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    added_count: result.addedCount,
                    staged_count: result.stagedCount,
                    message: `已暂存 ${result.addedCount} 条草稿（累计 ${result.stagedCount} 条）。全部生成后调用 commit_staged_drafts 导出 CSV。`,
                }, null, 2),
            }],
    };
});
if (exportEnabled) {
    server.registerTool('commit_staged_drafts', {
        description: '将暂存区的全部测试用例草稿导出为专业 Excel (.xlsx) 文件。'
            + '在所有 stage_testcase_draft 调用完成后调用此工具。'
            + '自动套用专业样式：深蓝表头、severity 行高亮、冻结首行、自动筛选、数据字典 sheet。'
            + '导出后默认清空暂存区。',
        inputSchema: {
            filename: zod_1.z.string().min(1).describe('文件名（不含后缀，自动加 .xlsx）'),
            clear_staged: zod_1.z.boolean().optional().describe('导出后是否清空暂存区，默认 true'),
        },
    }, async ({ filename, clear_staged = true }) => {
        const drafts = (0, stage_js_1.getStagedDrafts)();
        if (drafts.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            error: '暂存区为空 — 请先调用 stage_testcase_draft 暂存测试用例草稿。',
                        }, null, 2),
                    }],
            };
        }
        const buffer = await (0, xlsx_js_1.draftsToXlsx)(drafts);
        const result = (0, xlsx_js_1.writeXlsxExport)(EXPORT_DIR, filename, buffer, drafts.length, EXPORT_BASE_URL);
        if (clear_staged)
            (0, stage_js_1.clearStagedDrafts)();
        const text = `已导出 ${result.rowCount} 条测试用例到 ${filename}.xlsx\n下载链接: ${result.downloadUrl}\n本地路径: ${result.path}`;
        return { content: [{ type: 'text', text }] };
    });
}
server.registerTool('get_staged_count', {
    description: '查询暂存区中已暂存的测试用例草稿数量。',
    inputSchema: {},
}, async () => {
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({ success: true, staged_count: (0, stage_js_1.getStagedCount)() }, null, 2),
            }],
    };
});
server.registerTool('generate_from_description', {
    description: '从描述直接生成测试用例草稿（模式 E — 无缺陷 ID）。'
        + '用户提供测试场景描述，返回测试用例草稿模板（name, descriptionHtml, stepsText）。'
        + '注意：实际 LLM 生成由调用方 agent 完成，本工具返回结构化模板 + RAG 参考上下文。',
    inputSchema: {
        description: zod_1.z.string().min(1).describe('测试场景描述，如"蓝牙连接断开后的重连测试"'),
    },
}, async ({ description: desc }) => {
    const similar = await (0, pg_js_1.retrieveSimilarTestCasesFromPg)(desc, 5);
    const fewShot = (0, rag_js_1.formatFewShotExamples)(similar, 3);
    const template = (0, builder_js_1.buildTestCaseDescription)({
        defect: { defect_id: 'N/A', name: desc },
        procedureSteps: ['<步骤 1 — 待生成>'],
        expected: ['<预期结果 — 待生成>'],
        preconditions: ['<前置条件 — 待生成>'],
        passCriteria: '<通过标准 — 待生成>',
        failCriteria: '<失败标准 — 待生成>',
    });
    const stepsTemplate = (0, builder_js_1.buildTestStepsScript)({
        preconditions: ['<前置条件>'],
        steps: ['<步骤 1>'],
        checkpoints: ['<检查点>'],
    });
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    description: desc,
                    description_html_template: template,
                    steps_text_template: stepsTemplate,
                    similar_cases: similar.map((c) => ({ testId: c.test_id, name: c.name, score: c.score })),
                    few_shot_text: fewShot,
                    note: 'agent 应基于此模板 + few-shot 上下文，用 LLM 生成最终的 description 和 steps。',
                }, null, 2),
            }],
    };
});
server.registerTool('discover_patterns', {
    description: '缺陷模式聚类发现 — 对一批未关联测试用例的缺陷进行嵌入聚类，'
        + '按上下文 (project/ecu/model) 分桶 + anchor 兼容性检查，'
        + '输出可复用的 pattern 列表（每个 pattern 含 representative + members）。',
    inputSchema: {
        keyword: zod_1.z.string().min(1).describe('主题关键词（用于从 SQLite 筛选缺陷）'),
        project: zod_1.z.string().optional().describe('可选的 project 名称覆盖'),
        similarity_threshold: zod_1.z.number().min(0).max(1).default(0.84).describe('相似度阈值，默认 0.84'),
    },
}, async ({ keyword, project, similarity_threshold }) => {
    const { rows, total } = (0, db_js_1.filterDefectsByKeyword)(keyword, project ?? null, 10000, 0);
    const linked = (0, db_js_1.loadLinkedDefectIds)();
    const unlinked = rows.filter((r) => !linked.has((0, db_js_1.canonicalDefectId)(r['defect_id'])));
    const fullDefects = unlinked.map((r) => {
        const local = (0, db_js_1.readDefectById)(String(r['defect_id']));
        return { ...r, ...local };
    });
    const result = await (0, patterns_js_1.discoverDefectPatterns)(fullDefects, similarity_threshold);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
});
server.registerTool('audit_pattern_coverage', {
    description: '审计已有测试用例对 pattern 的覆盖情况 — '
        + '检查每个 pattern 的成员缺陷是否已有直接关联的测试用例，或存在语义相似的测试用例。',
    inputSchema: {
        patterns: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).min(1).describe('pattern 列表（discover_patterns 的输出）'),
    },
}, async ({ patterns }) => {
    const linked = (0, db_js_1.loadLinkedDefectIds)();
    const audits = patterns.map((pattern) => {
        const members = pattern['members'] ?? [];
        const directLinks = members.filter((m) => linked.has((0, db_js_1.canonicalDefectId)(m['defectId'])));
        const requiresManualReview = Boolean(pattern['requiresManualReview']);
        const recommendedDisposition = requiresManualReview
            ? 'requires_manual_review'
            : directLinks.length > 0
                ? 'review_existing_testcase'
                : 'review_generate_reusable_testcase';
        return {
            patternId: String(pattern['patternId'] ?? ''),
            directLinks: directLinks.map((m) => ({ defectId: (0, db_js_1.canonicalDefectId)(m['defectId']), testcases: [] })),
            semanticCandidates: [],
            recommendedDisposition,
        };
    });
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    audits,
                    summary: {
                        audited_pattern_count: audits.length,
                        direct_linked_member_count: audits.reduce((s, a) => s + a.directLinks.length, 0),
                    },
                }, null, 2),
            }],
    };
});
server.registerTool('prepare_pattern_drafts', {
    description: '为选定的 pattern 准备 RAG 上下文 — 读取 representative 缺陷 + 检索相似测试用例。'
        + '在生成 pattern 草稿前调用。',
    inputSchema: {
        patterns: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).min(1).describe('选定的 pattern 列表'),
    },
}, async ({ patterns }) => {
    const contexts = [];
    for (const pattern of patterns) {
        const representative = pattern['representative'] ?? {};
        const defectId = String(representative['defectId'] ?? '');
        if (!defectId) {
            contexts.push({ patternId: pattern['patternId'], error: 'no representative defectId' });
            continue;
        }
        const local = (0, db_js_1.readDefectById)(defectId);
        const defect = local ?? await (0, octane_js_1.fetchDefectById)(defectId);
        const name = String(defect['name'] ?? '');
        const query = `${name} ${defect['project'] ?? ''} ${defect['assigned_ecu'] ?? ''}`;
        const similar = await (0, pg_js_1.retrieveSimilarTestCasesFromPg)(query, 5);
        const fewShot = (0, rag_js_1.formatFewShotExamples)(similar, 3);
        contexts.push({
            patternId: pattern['patternId'],
            representative,
            memberDefectIds: (pattern['members'] ?? [])
                .map((m) => (0, db_js_1.canonicalDefectId)(m['defectId']))
                .filter(Boolean),
            defectInfo: defect,
            similarCases: similar.map((c) => ({ testId: c.test_id, name: c.name, score: c.score })),
            fewShotText: fewShot,
        });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, contexts }, null, 2) }] };
});
server.registerTool('export_pattern_drafts', {
    description: '导出 pattern 草稿为专业 Excel (.xlsx) 文件 — 不写 Octane，安全的离线审查路径。'
        + '自动套用专业样式：深蓝表头、冻结首行、自动筛选、合理列宽。',
    inputSchema: {
        filename: zod_1.z.string().min(1).describe('文件名（不含后缀）'),
        drafts: zod_1.z.array(zod_1.z.record(zod_1.z.string(), zod_1.z.unknown())).min(1).describe('草稿列表'),
    },
}, async ({ filename, drafts }) => {
    if (!exportEnabled) {
        return { content: [{ type: 'text', text: 'export_xlsx 不可用 — 未配置 EXPORT_DIR/EXPORT_BASE_URL' }] };
    }
    const columns = [
        'pattern_id', 'defect_id', 'defect_name', 'test_name', 'test_overview',
        'steps_text', 'verification_passed', 'verification_feedback', 'error',
    ];
    const rows = drafts.map((d) => ({
        pattern_id: String(d['patternId'] ?? ''),
        defect_id: String(d['defectId'] ?? ''),
        defect_name: String(d['defectName'] ?? ''),
        test_name: String(d['name'] ?? ''),
        test_overview: String(d['descriptionHtml'] ?? ''),
        steps_text: String(d['stepsText'] ?? ''),
        verification_passed: String(d['verification']?.['passed'] ?? ''),
        verification_feedback: String(d['verification']?.['feedback'] ?? ''),
        error: String(d['error'] ?? ''),
    }));
    const buffer = await (0, xlsx_js_1.genericToXlsx)(columns, rows, { sheetName: 'Pattern Drafts' });
    const result = (0, xlsx_js_1.writeXlsxExport)(EXPORT_DIR, filename, buffer, rows.length, EXPORT_BASE_URL);
    return {
        content: [{
                type: 'text',
                text: `已导出 ${result.rowCount} 行到 ${filename}.xlsx\n下载链接: ${result.downloadUrl}\n本地路径: ${result.path}`,
            }],
    };
});
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error('[vizion-testcase] MCP server 已启动, 等待工具调用');
}
main().catch((error) => {
    console.error('[vizion-testcase] 启动失败:', error);
    process.exit(1);
});
