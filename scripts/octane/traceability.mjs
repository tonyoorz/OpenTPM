import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const baseUrl = 'https://octane-prod.bmwgroup.net';
const workspace = '1002/2001';
const teamId = '59139';
const teamName = 'DTSV_China';
const apiBase = `${baseUrl}/api/shared_spaces/1002/workspaces/2001`;

export function references(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) {
    if (Number.isFinite(value.total_count) && value.total_count > value.data.length) {
      throw new Error('Expanded reference collection was truncated; extraction is incomplete.');
    }
    return value.data;
  }
  return value?.id ? [value] : [];
}

export function isReusableCache(completion, signature, generationId) {
  return (
    completion.schemaVersion === 2 &&
    completion.signature === signature &&
    completion.generationId === generationId
  );
}

function referenceIds(value) {
  return Array.from(
    new Set(
      references(value)
        .map((item) => String(item.id))
        .filter((id) => /^\d+$/.test(id)),
    ),
  );
}

function referenceName(value) {
  return value?.name ?? '';
}

export function normalizeRun(raw) {
  const nativeDefects = referenceIds(raw.defect);
  const linkedDefects = String(raw.linked_defects ?? '')
    .split(/[,;\s]+/)
    .filter((id) => /^\d+$/.test(id));
  const suiteId = String(raw.test_suite?.id ?? '');
  const suiteRunId = String(raw.parent_suite?.id ?? '');
  let ownership = 'Partial native suite ownership';
  if (suiteId && suiteRunId) ownership = 'Native suite and suite-run references';
  if (!suiteId && !suiteRunId) ownership = 'No native suite ownership; plan unresolved';
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    testId: String(raw.test?.id ?? ''),
    suiteId,
    suiteRunId,
    ownership,
    status: referenceName(raw.status),
    nativeStatus: referenceName(raw.native_status),
    releaseId: String(raw.release?.id ?? ''),
    release: referenceName(raw.release),
    runTeamId: String(raw.run_team_000_udf?.id ?? ''),
    runTeam: referenceName(raw.run_team_000_udf),
    started: raw.started ?? '',
    finished: raw.finished_udf ?? '',
    created: raw.creation_time ?? '',
    modified: raw.last_modified ?? '',
    defectIds: Array.from(new Set([...nativeDefects, ...linkedDefects])),
    nativeDefectIds: nativeDefects,
    linkedDefectIds: Array.from(new Set(linkedDefects)),
    coverageIds: referenceIds(raw.covered_content),
  };
}

export function normalizeWorkItem(raw) {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    subtype: raw.subtype ?? '',
    parentId: String(raw.parent?.id ?? ''),
    parentSubtype: raw.parent?.subtype ?? '',
    parentName: raw.parent?.name ?? '',
    release: referenceName(raw.release),
    roleEvidence: /test.?events?/i.test(raw.name ?? '')
      ? 'Name hint only; not a distinct API type'
      : 'No business-role inference',
  };
}

function normalizeTest(raw) {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    subtype: raw.subtype ?? '',
    phase: referenceName(raw.phase),
    coverageIds: referenceIds(raw.covered_content),
    areaIds: referenceIds(raw.product_areas),
    areaNames: references(raw.product_areas).map(referenceName),
    membershipIds: referenceIds(raw.link_to_test_suite),
    modified: raw.last_modified ?? '',
  };
}

function normalizeSuiteRun(raw) {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    subtype: raw.subtype ?? '',
    suiteId: String(raw.test?.id ?? ''),
    status: referenceName(raw.status),
    nativeStatus: referenceName(raw.native_status),
    release: referenceName(raw.release),
    started: raw.started ?? '',
    finished: raw.finished_udf ?? '',
  };
}

function normalizeDefect(raw) {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    phase: referenceName(raw.phase),
    severity: referenceName(raw.severity),
    detectedIn: referenceName(raw.detected_in_release),
    parentId: String(raw.parent?.id ?? ''),
    requirementIds: referenceIds(raw.requirements),
    requirementNames: references(raw.requirements).map(referenceName),
    areaIds: referenceIds(raw.product_areas),
    areaNames: references(raw.product_areas).map(referenceName),
    modified: raw.last_modified ?? '',
  };
}

function escapedJson(value) {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function* records(filePath) {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const normalized = new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      callback(
        null,
        chunk
          .toString()
          .replace(
            /[\u0085\u2028\u2029]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
          ),
      );
    },
  });
  input.on('error', (error) => normalized.destroy(error));
  for await (const line of createInterface({
    input: input.pipe(normalized),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      throw new Error(`Invalid extraction record in ${path.basename(filePath)}`);
    }
  }
}

async function exists(filePath) {
  try {
    await readFile(filePath, { encoding: 'utf8', flag: 'r' });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function idExpression(ids) {
  return ids
    .map((id) => {
      if (!/^\d+$/.test(id)) throw new Error('Invalid numeric entity reference.');
      return `'${id}'`;
    })
    .join(',');
}

class ReadOnlyApi {
  constructor(cookie) {
    this.cookie = cookie;
    this.requests = 0;
  }

  async page(endpoint, fields, query, limit = 1000) {
    const url = new URL(`${apiBase}/${endpoint}`);
    url.search = new URLSearchParams({
      fields,
      query: `"(${query})"`,
      order_by: 'id',
      limit: String(limit),
    });
    this.requests += 1;
    const response = await fetch(url, {
      headers: { Cookie: this.cookie, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`GET ${endpoint}: HTTP_${response.status}; extraction is incomplete.`);
    if (!(response.headers.get('content-type') ?? '').includes('json'))
      throw new Error('Authentication is required; extraction is incomplete.');
    const payload = await response.json();
    if (!Array.isArray(payload.data))
      throw new Error(`GET ${endpoint}: invalid collection response.`);
    return payload;
  }
}

async function writeJson(filePath, value) {
  const temporary = `${filePath}.partial`;
  await writeFile(temporary, escapedJson(value));
  await rename(temporary, filePath);
}

async function entityMap(api, directory, label, endpoint, ids, fields, normalize, resume) {
  const requested = Array.from(ids)
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
  const signature = createHash('sha256')
    .update(`${fields}\n${requested.join(',')}`)
    .digest('hex');
  const file = path.join(directory, `${label}.ndjson`);
  const marker = `${file}.complete.json`;
  const result = new Map();
  if (resume && (await exists(marker))) {
    const completion = JSON.parse(await readFile(marker, 'utf8'));
    if (isReusableCache(completion, signature, api.generationId)) {
      for await (const item of records(file)) result.set(item.id, item);
      if (result.size !== completion.returned)
        throw new Error(`Cached ${label} count is inconsistent.`);
      console.log(`Reused ${label}: ${result.size}/${requested.length} requested IDs`);
      return result;
    }
  }
  const temporary = `${file}.partial`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    for (let offset = 0; offset < requested.length; offset += 100) {
      const batch = requested.slice(offset, offset + 100);
      const payload = await api.page(endpoint, fields, `id IN ${idExpression(batch)}`);
      if (payload.total_count > payload.data.length)
        throw new Error(`${label} entity batch was truncated.`);
      const normalized = payload.data.map(normalize);
      for (const item of normalized) {
        if (!batch.includes(item.id)) throw new Error(`${label} returned an unrequested ID.`);
        result.set(item.id, item);
      }
      if (normalized.length) await handle.writeFile(`${normalized.map(escapedJson).join('\n')}\n`);
      if (offset % 1000 === 0 || offset + 100 >= requested.length)
        console.log(
          `${label}: ${Math.min(offset + 100, requested.length)}/${requested.length} IDs checked`,
        );
    }
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  await writeJson(marker, {
    schemaVersion: 2,
    generationId: api.generationId,
    signature,
    requested: requested.length,
    returned: result.size,
    completedAt: new Date().toISOString(),
  });
  return result;
}

function addIds(target, values) {
  for (const value of values) if (value) target.add(String(value));
}

function ancestry(id, workItems) {
  const result = [];
  const visited = new Set();
  let current = id;
  while (current && !visited.has(current)) {
    visited.add(current);
    const item = workItems.get(current);
    if (!item) {
      result.push({ id: current, name: '[unavailable]', subtype: 'unavailable' });
      break;
    }
    result.push(item);
    if (item.parentSubtype === 'work_item_root') break;
    current = item.parentId;
  }
  return result;
}

async function extract(api, directory, resume) {
  const runFile = path.join(directory, 'manual-runs.ndjson');
  const marker = `${runFile}.complete.json`;
  const state = {
    runFile,
    generationId: randomUUID(),
    testIds: new Set(),
    suiteIds: new Set(),
    suiteRunIds: new Set(),
    defectIds: new Set(),
    workItemIds: new Set(),
    requestedWorkItemIds: new Set(),
    membershipIds: new Set(),
    runCount: 0,
    firstRunId: '',
    lastRunId: '',
    releaseCounts: new Map(),
    statuses: new Map(),
    nativeOwnership: 0,
    partialOwnership: 0,
    timestampErrors: 0,
    startedAt: new Date().toISOString(),
    apiReportedTotal: null,
  };
  function collect(run) {
    if (run.runTeamId !== teamId)
      throw new Error('A run outside the selected DTSV team was returned.');
    state.runCount += 1;
    if (!state.firstRunId) state.firstRunId = run.id;
    if (state.lastRunId && BigInt(run.id) <= BigInt(state.lastRunId))
      throw new Error('Run IDs are duplicated or not monotonically increasing.');
    state.lastRunId = run.id;
    addIds(state.testIds, [run.testId]);
    addIds(state.suiteIds, [run.suiteId]);
    addIds(state.suiteRunIds, [run.suiteRunId]);
    addIds(state.defectIds, run.defectIds);
    addIds(state.workItemIds, run.coverageIds);
    state.releaseCounts.set(
      run.release || '[no release]',
      (state.releaseCounts.get(run.release || '[no release]') ?? 0) + 1,
    );
    const status = run.nativeStatus || run.status || '[unknown]';
    state.statuses.set(status, (state.statuses.get(status) ?? 0) + 1);
    if (run.suiteId && run.suiteRunId) state.nativeOwnership += 1;
    else if (run.suiteId || run.suiteRunId) state.partialOwnership += 1;
    if (run.started && run.finished && Date.parse(run.finished) < Date.parse(run.started))
      state.timestampErrors += 1;
  }
  const completion =
    resume && (await exists(marker)) ? JSON.parse(await readFile(marker, 'utf8')) : null;
  if (
    completion?.schemaVersion === 2 &&
    completion.generationId &&
    completion.endedWithEmptyKeysetPage === true
  ) {
    if (completion.teamId !== teamId || completion.workspace !== workspace)
      throw new Error('Cached run extraction has a different scope.');
    state.generationId = completion.generationId;
    state.startedAt = completion.startedAt;
    state.apiReportedTotal = completion.apiReportedTotal;
    for await (const run of records(runFile)) collect(run);
    if (state.runCount !== completion.runCount || state.lastRunId !== completion.lastRunId)
      throw new Error('Cached run extraction failed completeness checks.');
    console.log(`Reused complete all-release DTSV extraction: ${state.runCount} MRs`);
  } else {
    const temporary = `${runFile}.partial`;
    const handle = await open(temporary, 'w', 0o600);
    try {
      let cursor = '';
      for (;;) {
        const query = `run_team_000_udf={id='${teamId}'}` + (cursor ? `;id>'${cursor}'` : '');
        const payload = await api.page(
          'manual_runs',
          'id,name,test{id},test_suite{id},parent_suite{id},status{name},native_status{name},release{id,name},defect{id},linked_defects,covered_content{id},started,finished_udf,creation_time,last_modified,run_team_000_udf{id,name}',
          query,
        );
        if (state.apiReportedTotal === null) state.apiReportedTotal = payload.total_count;
        if (!payload.data.length) break;
        const rows = payload.data.map(normalizeRun);
        for (const run of rows) collect(run);
        await handle.writeFile(`${rows.map(escapedJson).join('\n')}\n`);
        cursor = state.lastRunId;
        if (state.runCount % 5000 === 0 || rows.length < 1000)
          console.log(
            `DTSV all-release MRs: ${state.runCount}; last ID ${cursor}; reported totals are not used as stop criteria`,
          );
      }
    } finally {
      await handle.close();
    }
    await rename(temporary, runFile);
    await writeJson(marker, {
      schemaVersion: 2,
      generationId: state.generationId,
      workspace,
      teamId,
      startedAt: state.startedAt,
      runCount: state.runCount,
      lastRunId: state.lastRunId,
      apiReportedTotal: state.apiReportedTotal,
      endedWithEmptyKeysetPage: true,
    });
  }
  api.generationId = state.generationId;
  const testFields =
    'id,name,subtype,phase{name},covered_content{id},product_areas{id,name},last_modified';
  state.suiteRuns = await entityMap(
    api,
    directory,
    'suite-runs',
    'runs',
    state.suiteRunIds,
    'id,name,subtype,test{id},status{name},native_status{name},release{name},started,finished_udf',
    normalizeSuiteRun,
    resume,
  );
  for (const run of state.suiteRuns.values()) addIds(state.suiteIds, [run.suiteId]);
  state.suites = await entityMap(
    api,
    directory,
    'suites',
    'test_suites',
    state.suiteIds,
    `${testFields},link_to_test_suite{id}`,
    normalizeTest,
    resume,
  );
  const membershipIds = new Set();
  state.membershipIds = membershipIds;
  for (const suite of state.suites.values()) {
    addIds(membershipIds, suite.membershipIds);
    addIds(state.workItemIds, suite.coverageIds);
  }
  state.memberships = await entityMap(
    api,
    directory,
    'suite-memberships',
    'test_suite_link_to_tests',
    membershipIds,
    'id,test{id},test_suite{id}',
    (raw) => ({
      id: String(raw.id),
      testId: String(raw.test?.id ?? ''),
      suiteId: String(raw.test_suite?.id ?? ''),
      subtype: raw.subtype ?? '',
    }),
    resume,
  );
  const executedTestCount = state.testIds.size;
  for (const member of state.memberships.values()) addIds(state.testIds, [member.testId]);
  state.executedTestCount = executedTestCount;
  state.tests = await entityMap(
    api,
    directory,
    'tests',
    'tests',
    state.testIds,
    testFields,
    normalizeTest,
    resume,
  );
  for (const testcase of state.tests.values()) addIds(state.workItemIds, testcase.coverageIds);
  state.defects = await entityMap(
    api,
    directory,
    'defects',
    'defects',
    state.defectIds,
    'id,name,phase{name},severity{name},detected_in_release{name},parent{id},requirements{id,name},product_areas{id,name},last_modified',
    normalizeDefect,
    resume,
  );
  state.workItems = new Map();
  let frontier = new Set(state.workItemIds);
  const unavailableWorkItems = new Set();
  for (let depth = 0; frontier.size && depth < 16; depth += 1) {
    addIds(state.requestedWorkItemIds, frontier);
    const items = await entityMap(
      api,
      directory,
      `work-items-${depth}`,
      'work_items',
      frontier,
      'id,name,subtype,parent{id,name,subtype},release{name}',
      normalizeWorkItem,
      resume,
    );
    for (const id of frontier) if (!items.has(id)) unavailableWorkItems.add(id);
    for (const [id, item] of items) state.workItems.set(id, item);
    const next = new Set();
    for (const item of items.values()) {
      if (
        item.parentId &&
        item.parentSubtype !== 'work_item_root' &&
        !state.workItems.has(item.parentId)
      )
        next.add(item.parentId);
    }
    frontier = next;
  }
  state.unresolvedAncestorFrontier = Array.from(new Set([...frontier, ...unavailableWorkItems]));
  state.finishedAt = new Date().toISOString();
  return state;
}

function safeCell(value) {
  const text = typeof value === 'string' ? value : null;
  if (text && text.length > 30000)
    return `${text.slice(0, 29880)} [display shortened; see normalized extraction / relation sheets]`;
  return value ?? '';
}

function workItemLink(id) {
  return `${baseUrl}/ui/entity-navigation?p=${workspace}&entityType=work_item&id=${id}`;
}
function testLink(id) {
  return `${baseUrl}/ui/entity-navigation?p=${workspace}&entityType=test&id=${id}`;
}

function tableWriter(workbook, name, headers, counts) {
  let sheet;
  let part = 0;
  let rows = 0;
  function nextSheet() {
    if (sheet) {
      sheet.autoFilter = `A1:${columnName(headers.length)}${rows + 1}`;
      sheet.commit();
    }
    part += 1;
    rows = 0;
    sheet = workbook.addWorksheet(`${name} ${part}`, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = headers.map((header) => ({
      header,
      width: /Name|Coverage|Path|Missing|Ownership|Notes/.test(header) ? 58 : 23,
    }));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244A64' } };
    sheet.getRow(1).commit();
    counts[sheet.name] = 0;
  }
  nextSheet();
  return {
    add(values) {
      if (rows >= 50000) nextSheet();
      const row = sheet.addRow(values.map(safeCell));
      row.alignment = { vertical: 'top', wrapText: true };
      row.commit();
      rows += 1;
      counts[sheet.name] += 1;
    },
    close() {
      sheet.autoFilter = `A1:${columnName(headers.length)}${rows + 1}`;
      sheet.commit();
    },
  };
}

function columnName(count) {
  let name = '';
  let remaining = count;
  while (remaining > 0) {
    remaining -= 1;
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

export function missingReferences(state) {
  const rows = [];
  for (const [kind, ids, entities] of [
    ['Test', state.testIds, state.tests],
    ['Test Suite', state.suiteIds, state.suites],
    ['Suite Run', state.suiteRunIds, state.suiteRuns],
    ['Suite membership', state.membershipIds ?? new Set(), state.memberships ?? new Map()],
    ['Defect', state.defectIds, state.defects],
    ['Work item', state.requestedWorkItemIds ?? state.workItemIds, state.workItems],
  ]) {
    for (const id of ids)
      if (!entities.has(id))
        rows.push([
          kind,
          id,
          'Referenced but not returned by the current API; missing/deleted/inaccessible is not distinguished.',
        ]);
  }
  return rows;
}

async function exportWorkbook(state, directory, ExcelJS, requestCount) {
  const output = path.join(directory, 'DTSV_China - End-to-end traceability.xlsx');
  const temporary = `${output}.partial`;
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: temporary,
    useStyles: true,
    useSharedStrings: false,
  });
  const counts = {};
  const missing = missingReferences(state);
  const summary = tableWriter(workbook, 'Scope', ['Item', 'Value / Notes'], counts);
  const summaryRows = [
    ['Workspace', workspace],
    ['Team', `${teamName} (${teamId})`],
    [
      'Run scope',
      'All accessible historical manual_runs with run_team_000_udf.id=59139; no release or date filter. Includes planned/unexecuted MR records.',
    ],
    [
      'Scope boundary',
      'MTs have no direct team field. Includes tests referenced by these MRs and contained tests from their referenced suites. Does not claim all other unexecuted DTSV-owned tests or every DTSV plan.',
    ],
    ['Extraction started UTC', state.startedAt],
    ['Extraction finished UTC', state.finishedAt],
    [
      'All MR pages exhausted',
      'Yes: stable ID keyset pagination ended with an empty page; API total_count was not a stopping condition.',
    ],
    ['First API-reported total', state.apiReportedTotal],
    ['Actual distinct MRs', state.runCount],
    ['MT IDs referenced by MRs', state.executedTestCount],
    ['MT definitions returned', state.tests.size],
    ['Test Suite definitions returned', state.suites.size],
    ['Suite Run entities returned', state.suiteRuns.size],
    ['Distinct linked defect IDs', state.defectIds.size],
    ['Defect records returned', state.defects.size],
    ['MRs with both native ownership refs', state.nativeOwnership],
    ['MRs with partial native ownership', state.partialOwnership],
    [
      'MRs without native suite ownership',
      state.runCount - state.nativeOwnership - state.partialOwnership,
    ],
    ['Missing referenced entities', missing.length],
    ['Unresolved ancestor frontier', state.unresolvedAncestorFrontier.join(', ') || 'None'],
    ['Finished before started', state.timestampErrors],
    ['Requests in this run', requestCount],
    [
      'Non-atomic extraction',
      'GETs occurred over the extraction window. Current definitions/coverage are not a historical snapshot of what every run originally covered.',
    ],
    [
      'Traceability layout',
      'Trace rows are one MR each, never a Cartesian expansion of all coverage/defect paths. Follow IDs into MT Coverage, Suite Coverage, Work Items, Suites, Suite Runs, Memberships, and Defects.',
    ],
    [
      'Coverage is not plan ownership',
      'MR coverage and MT coverage are preserved separately. A Story in coverage is not assigned as the unique execution plan. Only native suite/suite-run refs establish that execution context.',
    ],
    [
      'Defect deduplication',
      'Native defect references and linked_defects are unioned by ID. One defect can occur on many MRs; defect state is separate from execution result.',
    ],
    [
      'Links',
      'One clickable MT link per trace row; work-item/MT/defect sheets use known entity-navigation formats. URLs are constructed from API IDs, not browser-validated individually. Sheets split after 50000 rows.',
    ],
    [
      'Long display text',
      'Cells over 30000 characters have a marked shortened display. Complete normalized source records remain in extraction files; MT/Suite relations also have separate rows.',
    ],
    [
      'Data quality',
      'Missing native references are retained, not filled from names. Never infer a unique TestEvent solely from work-item names or reusable coverage.',
    ],
  ];
  for (const row of summaryRows) summary.add(row);
  summary.close();
  const trace = tableWriter(
    workbook,
    'Trace',
    [
      'MR ID',
      'MR Name',
      'Release',
      'Team',
      'MT ID',
      'MT Name',
      'MT Phase',
      'Test Suite ID',
      'Test Suite Name',
      'Suite Run ID',
      'Suite Run Name',
      'Suite Run Release',
      'Status (system)',
      'Status (native)',
      'Started UTC',
      'Finished UTC',
      'Timestamp Check',
      'Distinct Defect IDs',
      'Defect Phases',
      'Native Execution Ownership',
      'MT Coverage IDs',
      'Suite Coverage IDs',
      'Covered Epic IDs',
      'Covered Feature IDs',
      'Covered Story IDs',
      'MR Backlog Coverage IDs',
      'Missing References',
      'MT Link',
      'API Last Modified',
    ],
    counts,
  );
  for await (const run of records(state.runFile)) {
    const testcase = state.tests.get(run.testId);
    const suite = state.suites.get(run.suiteId);
    const suiteRun = state.suiteRuns.get(run.suiteRunId);
    const ancestors = new Map();
    for (const id of testcase?.coverageIds ?? [])
      for (const item of ancestry(id, state.workItems)) ancestors.set(item.id, item);
    const idsOf = (type) =>
      Array.from(ancestors.values())
        .filter((item) => item.subtype === type)
        .map((item) => item.id)
        .join(', ');
    const unresolved = [
      !testcase && run.testId ? `MT ${run.testId}` : '',
      !suite && run.suiteId ? `Suite ${run.suiteId}` : '',
      !suiteRun && run.suiteRunId ? `Suite Run ${run.suiteRunId}` : '',
      ...run.defectIds.filter((id) => !state.defects.has(id)).map((id) => `Defect ${id}`),
    ].filter(Boolean);
    const timeInvalid =
      run.started && run.finished && Date.parse(run.finished) < Date.parse(run.started);
    trace.add([
      run.id,
      run.name,
      run.release,
      run.runTeam,
      run.testId,
      testcase?.name ?? '',
      testcase?.phase ?? '',
      run.suiteId,
      suite?.name ?? '',
      run.suiteRunId,
      suiteRun?.name ?? '',
      suiteRun?.release ?? '',
      run.status,
      run.nativeStatus,
      run.started,
      run.finished,
      timeInvalid ? 'Finished before started' : '',
      run.defectIds.join(', '),
      run.defectIds
        .map((id) => `${id}: ${state.defects.get(id)?.phase ?? '[unavailable]'}`)
        .join('; '),
      run.ownership,
      testcase?.coverageIds.join(', ') ?? '',
      suite?.coverageIds.join(', ') ?? '',
      idsOf('epic'),
      idsOf('feature'),
      idsOf('story'),
      run.coverageIds.join(', '),
      unresolved.join('; '),
      run.testId ? { text: testLink(run.testId), hyperlink: testLink(run.testId) } : '',
      run.modified,
    ]);
  }
  trace.close();
  const tests = tableWriter(
    workbook,
    'Tests',
    [
      'MT ID',
      'Name',
      'Subtype',
      'Phase',
      'FiF IDs',
      'FiF Names',
      'Covered WorkItem IDs',
      'Last Modified UTC',
      'MT Link',
    ],
    counts,
  );
  const coverage = tableWriter(
    workbook,
    'MT Coverage',
    [
      'MT ID',
      'MT Name',
      'Covered ID',
      'Covered Name',
      'Covered Type',
      'Parent ID',
      'Ancestor IDs',
      'Ancestor Names',
      'Evidence',
      'Ownership Warning',
    ],
    counts,
  );
  for (const item of state.tests.values()) {
    tests.add([
      item.id,
      item.name,
      item.subtype,
      item.phase,
      item.areaIds.join(', '),
      item.areaNames.join('; '),
      item.coverageIds.join(', '),
      item.modified,
      { text: testLink(item.id), hyperlink: testLink(item.id) },
    ]);
    for (const id of item.coverageIds) {
      const chain = ancestry(id, state.workItems);
      const direct = chain[0];
      coverage.add([
        item.id,
        item.name,
        id,
        direct?.name ?? '',
        direct?.subtype ?? '',
        direct?.parentId ?? '',
        chain.map((node) => node.id).join(' -> '),
        chain.map((node) => node.name).join(' -> '),
        'tests.covered_content + work_items.parent',
        'Reusable coverage, not unique execution ownership',
      ]);
    }
  }
  tests.close();
  coverage.close();
  const suites = tableWriter(
    workbook,
    'Suites',
    ['Suite ID', 'Name', 'Phase', 'Covered IDs', 'Membership IDs'],
    counts,
  );
  const suiteCoverage = tableWriter(
    workbook,
    'Suite Coverage',
    [
      'Suite ID',
      'Suite Name',
      'Covered ID',
      'Covered Name',
      'Covered Type',
      'Ancestor IDs',
      'Evidence',
    ],
    counts,
  );
  for (const item of state.suites.values()) {
    suites.add([
      item.id,
      item.name,
      item.phase,
      item.coverageIds.join(', '),
      item.membershipIds.join(', '),
    ]);
    for (const id of item.coverageIds) {
      const chain = ancestry(id, state.workItems);
      suiteCoverage.add([
        item.id,
        item.name,
        id,
        chain[0]?.name ?? '',
        chain[0]?.subtype ?? '',
        chain.map((node) => node.id).join(' -> '),
        'test_suites.covered_content',
      ]);
    }
  }
  suites.close();
  suiteCoverage.close();
  const memberships = tableWriter(
    workbook,
    'Memberships',
    ['Membership ID', 'Suite ID', 'MT ID', 'Subtype', 'Evidence'],
    counts,
  );
  for (const item of state.memberships.values())
    memberships.add([item.id, item.suiteId, item.testId, item.subtype, 'test_suite_link_to_tests']);
  memberships.close();
  const suiteRuns = tableWriter(
    workbook,
    'Suite Runs',
    [
      'Suite Run ID',
      'Name',
      'Subtype',
      'Test Suite ID',
      'Status (system)',
      'Status (native)',
      'Release',
      'Started UTC',
      'Finished UTC',
    ],
    counts,
  );
  for (const item of state.suiteRuns.values())
    suiteRuns.add([
      item.id,
      item.name,
      item.subtype,
      item.suiteId,
      item.status,
      item.nativeStatus,
      item.release,
      item.started,
      item.finished,
    ]);
  suiteRuns.close();
  const workItems = tableWriter(
    workbook,
    'Work Items',
    [
      'ID',
      'Name',
      'Subtype',
      'Parent ID',
      'Parent Name',
      'Parent Type',
      'Release',
      'Business Role Evidence',
      'Link',
    ],
    counts,
  );
  for (const item of state.workItems.values())
    workItems.add([
      item.id,
      item.name,
      item.subtype,
      item.parentId,
      item.parentName,
      item.parentSubtype,
      item.release,
      item.roleEvidence,
      { text: workItemLink(item.id), hyperlink: workItemLink(item.id) },
    ]);
  workItems.close();
  const defects = tableWriter(
    workbook,
    'Defects',
    [
      'Defect ID',
      'Name',
      'Phase',
      'Severity',
      'Detected In Release',
      'Parent ID',
      'Requirement Document IDs',
      'Requirement Document Names',
      'FiF IDs',
      'FiF Names',
      'Last Modified UTC',
      'WorkItem Link',
    ],
    counts,
  );
  for (const item of state.defects.values())
    defects.add([
      item.id,
      item.name,
      item.phase,
      item.severity,
      item.detectedIn,
      item.parentId,
      item.requirementIds.join(', '),
      item.requirementNames.join('; '),
      item.areaIds.join(', '),
      item.areaNames.join('; '),
      item.modified,
      { text: workItemLink(item.id), hyperlink: workItemLink(item.id) },
    ]);
  defects.close();
  const gaps = tableWriter(
    workbook,
    'Missing Entities',
    ['Entity Type', 'Referenced ID', 'Notes'],
    counts,
  );
  for (const row of missing) gaps.add(row);
  gaps.close();
  const releases = tableWriter(
    workbook,
    'Release Counts',
    ['Release', 'Distinct MR Records'],
    counts,
  );
  for (const [release, count] of state.releaseCounts) releases.add([release, count]);
  releases.close();
  await workbook.commit();
  await rename(temporary, output);
  const manifest = {
    workspace,
    teamId,
    teamName,
    scope:
      'All accessible historical DTSV_China MRs and their referenced entities; no release/date filter',
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    apiRequests: requestCount,
    apiReportedTotal: state.apiReportedTotal,
    distinctRuns: state.runCount,
    executedScopeTestIds: state.executedTestCount,
    testsReturned: state.tests.size,
    suitesReturned: state.suites.size,
    suiteRunsReturned: state.suiteRuns.size,
    linkedDefectIds: state.defectIds.size,
    defectsReturned: state.defects.size,
    workItemsReturned: state.workItems.size,
    nativeOwnershipRuns: state.nativeOwnership,
    partialOwnershipRuns: state.partialOwnership,
    noNativeOwnershipRuns: state.runCount - state.nativeOwnership - state.partialOwnership,
    timestampErrors: state.timestampErrors,
    missingEntities: missing.length,
    unresolvedAncestorFrontier: state.unresolvedAncestorFrontier,
    endedWithEmptyKeysetPage: true,
    sheets: counts,
    releases: Object.fromEntries(state.releaseCounts),
    statuses: Object.fromEntries(state.statuses),
    output,
  };
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2)
    args.set(argv[index].replace(/^--/, ''), argv[index + 1]);
  const root = path.resolve(args.get('vizion-root') ?? '../vizion-lab');
  const directory = path.resolve(args.get('output-dir') ?? 'artifacts/dtsv-traceability-20261028');
  await mkdir(directory, { recursive: true });
  const cookie = (
    await readFile(process.env.VIZION_OCTANE_COOKIE_FILE ?? path.join(root, 'cookie.txt'), 'utf8')
  )
    .replace(/^\uFEFF/, '')
    .trim();
  if (!cookie || /\r|\n/.test(cookie)) throw new Error('A valid Octane session is required.');
  const api = new ReadOnlyApi(cookie);
  const ExcelJS = require(require.resolve('exceljs', { paths: [root] }));
  const state = await extract(api, directory, args.get('resume') === '1');
  await exportWorkbook(state, directory, ExcelJS, api.requests);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
