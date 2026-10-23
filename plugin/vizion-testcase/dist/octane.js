"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearCookieCache = clearCookieCache;
exports.normalizeDefectId = normalizeDefectId;
exports.fetchDefectById = fetchDefectById;
exports.fetchWorkItem = fetchWorkItem;
exports.createTestCase = createTestCase;
exports.createDefect = createDefect;
exports.writeTestSteps = writeTestSteps;
exports.fetchTestSteps = fetchTestSteps;
exports.buildOctaneUrl = buildOctaneUrl;
exports.buildDefectUrl = buildDefectUrl;
/**
 * Octane API client — HTTP 请求 + cookie 认证。
 *
 * 重写自 vizion-lab/backend/analytics/ingest/client.py 的 OctaneApiClient
 * 和 backend/analytics/ingest/auth.py 的 build_cookie_session。
 *
 * 用 Node.js 内置 fetch (Node 24) 代替 Python requests。
 * Cookie 从环境变量 OCTANE_COOKIE_FILE 指向的文件读取。
 */
const node_fs_1 = require("node:fs");
const defect_js_1 = require("./defect.js");
const OCTANE_BASE_URL = process.env['OCTANE_BASE_URL'] ?? 'https://octane-prod.bmwgroup.net';
const SHARED_SPACE_ID = process.env['OCTANE_SHARED_SPACE_ID'] ?? '1002';
const WORKSPACE_ID = process.env['OCTANE_WORKSPACE_ID'] ?? '2001';
const API_BASE = `${OCTANE_BASE_URL.replace(/\/+$/, '')}/api/shared_spaces/${SHARED_SPACE_ID}/workspaces/${WORKSPACE_ID}`;
const DEFECT_FIELDS = [
    'id', 'name', 'description', 'creation_time', 'last_modified',
    'team{name}', 'problem_finder_team_udf{name}', 'product_areas{name}', 'requirements{name}',
    'assigned_ecu_udf{name}', 'software_version_udf', 'solution_cluster_udf{name}',
    'problem_category_udf{name}', 'reporting_class_udf{name}', 'problem_severity_udf{name}',
    'vin_udf', 'first_use_sop_of_function_udf', 'function_responsible1_udf{full_name,name}',
    'ecu_to_modul_udf{name}', 'lead_model_udf{name}', 'phase{name,id}', 'severity{name,id}',
    'owner{full_name,name}', 'author{full_name,name}',
].join(',');
let cachedCookie;
function loadCookie() {
    if (cachedCookie)
        return cachedCookie;
    const cookieFile = process.env['OCTANE_COOKIE_FILE'];
    if (!cookieFile) {
        throw new Error('缺少环境变量 OCTANE_COOKIE_FILE');
    }
    const header = (0, node_fs_1.readFileSync)(cookieFile, 'utf-8').trim();
    if (!header) {
        throw new Error(`Cookie file is empty: ${cookieFile}`);
    }
    let xsrf = '';
    for (const part of header.split(';')) {
        const trimmed = part.trim();
        if (!trimmed || !trimmed.includes('='))
            continue;
        const [name, value] = trimmed.split('=', 2);
        if (name?.trim() === 'XSRF_COOKIE') {
            xsrf = (value ?? '').trim();
        }
    }
    cachedCookie = { header, xsrf };
    return cachedCookie;
}
/** 清除缓存的 cookie（测试用）。 */
function clearCookieCache() {
    cachedCookie = undefined;
}
function buildHeaders() {
    const { header, xsrf } = loadCookie();
    const headers = {
        Cookie: header,
        'User-Agent': 'Mozilla/5.0',
    };
    if (xsrf) {
        headers['XSRF-HEADER'] = xsrf;
    }
    return headers;
}
/** 规范化缺陷 ID — 去掉 D 前缀。 */
function normalizeDefectId(defectId) {
    let normalized = defectId.trim();
    if (normalized.length > 1 && (normalized[0] === 'D' || normalized[0] === 'd') && /^\d+$/.test(normalized.slice(1))) {
        normalized = normalized.slice(1);
    }
    return normalized;
}
/** 从 Octane API 读取单个缺陷（fallback，当本地 SQLite 无此缺陷时）。 */
async function fetchDefectById(defectId) {
    const normalized = normalizeDefectId(defectId);
    if (!normalized)
        throw new Error('defect_id is required');
    const query = `"(id='${normalized.replace(/'/g, "\\'")}')`;
    const url = new URL(`${API_BASE}/defects`);
    url.searchParams.set('fields', DEFECT_FIELDS);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', '2');
    const response = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Octane API ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    const rows = payload.data ?? [];
    if (rows.length === 0) {
        throw new Error(`defect ${normalized} not found in Octane`);
    }
    return rows[0];
}
/** 读取任意 work item（feature/story/epic）— defect fallback。 */
async function fetchWorkItem(workItemId) {
    const normalized = workItemId.trim();
    if (!normalized)
        throw new Error('work_item_id is required');
    const url = new URL(`${API_BASE}/work_items/${normalized}`);
    url.searchParams.set('fields', 'id,name,subtype,description,phase{name,id},last_modified');
    const response = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
        throw new Error(`Octane API ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    return payload;
}
/** 创建 test_manual 实体（生产写入 — 需用户确认后调用）。 */
async function createTestCase(params) {
    const { name, descriptionHtml, ownerWorkspaceUserId, servicepackNodeId, coveredWorkItemIds } = params;
    const fields = {
        subtype: 'test_manual',
        name,
        description: descriptionHtml,
        phase: { type: 'phase', id: 'phase.test_manual.new' },
        owner: { type: 'workspace_user', id: ownerWorkspaceUserId },
        servicepack_udf: { data: [{ type: 'list_node', id: servicepackNodeId }] },
    };
    if (coveredWorkItemIds?.length) {
        fields['covered_content'] = {
            data: coveredWorkItemIds.map((wid) => ({ type: 'work_item', id: wid })),
        };
    }
    const response = await fetch(`${API_BASE}/tests`, {
        method: 'POST',
        headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ type: 'test', ...fields }] }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`Octane create test ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    const rows = payload.data ?? [];
    return { id: String(rows[0]?.id ?? '') };
}
/** 创建 Octane Defect（生产写入 — 需用户确认后调用）。 */
async function createDefect(draft) {
    const response = await fetch(`${API_BASE}/defects`, {
        method: 'POST',
        headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [{ type: 'defect', ...(0, defect_js_1.buildDefectFields)(draft) }] }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`Octane create defect ${response.status}: ${await response.text()}`);
    }
    const payload = await response.json();
    const rows = payload.data ?? [];
    return { id: String(rows[0]?.id ?? '') };
}
/** 写入测试步骤到 /tests/{id}/script。 */
async function writeTestSteps(testId, stepsText) {
    const response = await fetch(`${API_BASE}/tests/${testId}/script`, {
        method: 'PUT',
        headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: stepsText }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`Octane write steps ${response.status}: ${await response.text()}`);
    }
    return response.json();
}
/** 读取测试步骤（验证写入是否成功）。 */
async function fetchTestSteps(testId) {
    const response = await fetch(`${API_BASE}/tests/${testId}/script`, {
        headers: buildHeaders(),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        throw new Error(`Octane fetch steps ${response.status}: ${await response.text()}`);
    }
    return response.json();
}
/** 生成 Octane UI 链接。 */
function buildOctaneUrl(testId) {
    return `https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=test&id=${testId}`;
}
/** 生成 Octane Defect UI 链接。 */
function buildDefectUrl(defectId) {
    return `https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=defect&id=${defectId}`;
}
