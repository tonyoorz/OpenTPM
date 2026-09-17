/**
 * Octane API client — HTTP 请求 + cookie 认证。
 *
 * 重写自 vizion-lab/backend/analytics/ingest/client.py 的 OctaneApiClient
 * 和 backend/analytics/ingest/auth.py 的 build_cookie_session。
 *
 * 用 Node.js 内置 fetch (Node 24) 代替 Python requests。
 * Cookie 从环境变量 OCTANE_COOKIE_FILE 指向的文件读取。
 */
import { readFileSync } from 'node:fs';

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

interface CookieData {
  header: string;
  xsrf: string;
}

let cachedCookie: CookieData | undefined;

function loadCookie(): CookieData {
  if (cachedCookie) return cachedCookie;
  const cookieFile = process.env['OCTANE_COOKIE_FILE'];
  if (!cookieFile) {
    throw new Error('缺少环境变量 OCTANE_COOKIE_FILE');
  }
  const header = readFileSync(cookieFile, 'utf-8').trim();
  if (!header) {
    throw new Error(`Cookie file is empty: ${cookieFile}`);
  }
  let xsrf = '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [name, value] = trimmed.split('=', 2);
    if (name?.trim() === 'XSRF_COOKIE') {
      xsrf = (value ?? '').trim();
    }
  }
  cachedCookie = { header, xsrf };
  return cachedCookie;
}

/** 清除缓存的 cookie（测试用）。 */
export function clearCookieCache(): void {
  cachedCookie = undefined;
}

function buildHeaders(): Record<string, string> {
  const { header, xsrf } = loadCookie();
  const headers: Record<string, string> = {
    Cookie: header,
    'User-Agent': 'Mozilla/5.0',
  };
  if (xsrf) {
    headers['XSRF-HEADER'] = xsrf;
  }
  return headers;
}

/** 规范化缺陷 ID — 去掉 D 前缀。 */
export function normalizeDefectId(defectId: string): string {
  let normalized = defectId.trim();
  if (normalized.length > 1 && (normalized[0] === 'D' || normalized[0] === 'd') && /^\d+$/.test(normalized.slice(1))) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

interface OctaneRow {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

/** 从 Octane API 读取单个缺陷（fallback，当本地 SQLite 无此缺陷时）。 */
export async function fetchDefectById(defectId: string): Promise<Record<string, unknown>> {
  const normalized = normalizeDefectId(defectId);
  if (!normalized) throw new Error('defect_id is required');

  const query = `"(id='${normalized.replace(/'/g, "\\'")}')`;
  const url = new URL(`${API_BASE}/defects`);
  url.searchParams.set('fields', DEFECT_FIELDS);
  url.searchParams.set('query', query);
  url.searchParams.set('limit', '2');

  const response = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Octane API ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json() as { data?: OctaneRow[] };
  const rows = payload.data ?? [];
  if (rows.length === 0) {
    throw new Error(`defect ${normalized} not found in Octane`);
  }
  return rows[0]!;
}

/** 读取任意 work item（feature/story/epic）— defect fallback。 */
export async function fetchWorkItem(workItemId: string): Promise<Record<string, unknown>> {
  const normalized = workItemId.trim();
  if (!normalized) throw new Error('work_item_id is required');

  const url = new URL(`${API_BASE}/work_items/${normalized}`);
  url.searchParams.set('fields', 'id,name,subtype,description,phase{name,id},last_modified');

  const response = await fetch(url, { headers: buildHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    throw new Error(`Octane API ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  return payload;
}

interface CreateTestCaseParams {
  name: string;
  descriptionHtml: string;
  ownerWorkspaceUserId: string;
  servicepackNodeId: string;
  coveredWorkItemIds?: string[];
}

/** 创建 test_manual 实体（生产写入 — 需用户确认后调用）。 */
export async function createTestCase(params: CreateTestCaseParams): Promise<{ id: string }> {
  const { name, descriptionHtml, ownerWorkspaceUserId, servicepackNodeId, coveredWorkItemIds } = params;

  const fields: Record<string, unknown> = {
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
  const payload = await response.json() as { data?: OctaneRow[] };
  const rows = payload.data ?? [];
  return { id: String(rows[0]?.id ?? '') };
}

/** 写入测试步骤到 /tests/{id}/script。 */
export async function writeTestSteps(testId: string, stepsText: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}/tests/${testId}/script`, {
    method: 'PUT',
    headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: stepsText }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Octane write steps ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

/** 读取测试步骤（验证写入是否成功）。 */
export async function fetchTestSteps(testId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}/tests/${testId}/script`, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Octane fetch steps ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

/** 生成 Octane UI 链接。 */
export function buildOctaneUrl(testId: string): string {
  return `https://octane-prod.bmwgroup.net/ui/entity-navigation?p=1002/2001&entityType=test&id=${testId}`;
}
