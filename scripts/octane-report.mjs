import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { Transform } from 'node:stream';
import path from 'node:path';
import XLSX from 'xlsx';
import { load } from 'cheerio';

const require = createRequire(import.meta.url);
const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index].replace(/^--/, ''), process.argv[index + 1]);
}
const vizionRoot = path.resolve(argumentsByName.get('vizion-root') ?? '../vizion-lab');
const outputDirectory = path.resolve(
  argumentsByName.get('output-dir') ?? 'artifacts/octane-execution-20261027',
);
const sourceArtifact = argumentsByName.get('source-artifact');
const detailedReport = argumentsByName.get('live-details') === '1';
const parentWorkbook = argumentsByName.get('parent-links');
if (!sourceArtifact && !parentWorkbook)
  throw new Error('--source-artifact or --parent-links is required');
const ExcelJS = require(require.resolve('exceljs', { paths: [vizionRoot] }));
const baseUrl = 'https://octane-prod.bmwgroup.net';
const project = `${process.env.VIZION_OCTANE_SHARED_SPACE_ID ?? '1002'}/${process.env.VIZION_OCTANE_WORKSPACE_ID ?? '2001'}`;
const sourceSheetName = 'TA Req Breakdown CN';

function references(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return value?.id ? [value] : [];
}

function normalize(value) {
  return String(value)
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/^FL\s+/i, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function testLink(id) {
  return `${baseUrl}/ui/entity-navigation?p=${project}&entityType=test&id=${encodeURIComponent(id)}`;
}

function descriptionText(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const parsed = load(value);
  parsed('script,style,noscript').remove();
  parsed('br').replaceWith('\n');
  parsed('p,div,li,tr,h1,h2,h3,h4').append('\n');
  return parsed
    .root()
    .text()
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function escapeJsonLineSeparators(value) {
  return value.replace(
    /[\u0085\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function workItemChain(item, api) {
  const chain = [];
  const visited = new Set();
  let current = item;
  while (current?.id && !visited.has(String(current.id))) {
    const id = String(current.id);
    visited.add(id);
    const known = api.workItems.get(id);
    chain.push({ ...current, ...known, id });
    const parent = known?.parent ?? current.parent;
    current = parent ? (api.workItems.get(String(parent.id)) ?? parent) : null;
  }
  return chain;
}

function liveAreaCandidates(label, data, api) {
  const candidates = new Set(data.labels.get(normalize(label)) ?? []);
  for (const [id, area] of api.verifiedAreas) {
    if (normalize(area.name) === normalize(label)) candidates.add(id);
  }
  return Array.from(candidates).filter((id) => api.byArea.has(id));
}

async function saveApiSnapshot(api, sourceHash) {
  await mkdir(outputDirectory, { recursive: true });
  const destination = path.join(outputDirectory, 'octane-api-snapshot.ndjson');
  const temporary = `${destination}.partial`;
  const handle = await open(temporary, 'w', 0o600);
  let buffer = [];
  async function append(record) {
    buffer.push(escapeJsonLineSeparators(JSON.stringify(record)));
    if (buffer.length < 200) return;
    await handle.write(`${buffer.join('\n')}\n`);
    buffer = [];
  }
  try {
    await append({
      type: 'metadata',
      version: 1,
      project,
      sourceHash,
      reason: api.reason,
      startedAt: api.startedAt,
      fetchedAt: api.fetchedAt,
      requests: api.requests,
      verifiedRoots: Array.from(api.verifiedRoots),
    });
    for (const [id, value] of api.workItems) await append({ type: 'work_item', id, value });
    for (const [id, value] of api.verifiedAreas) await append({ type: 'area', id, value });
    for (const [id, value] of api.byRoot)
      await append({ type: 'root_membership', id, value: Array.from(value) });
    for (const [id, value] of api.byArea)
      await append({ type: 'area_membership', id, value: Array.from(value) });
    for (const [id, value] of api.tests) await append({ type: 'test', id, value });
    if (buffer.length) await handle.write(`${buffer.join('\n')}\n`);
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  console.log('Read-only API extraction snapshot saved; no authentication headers are included.');
}

async function readApiSnapshot(sourceHash) {
  const result = {
    status: 'available',
    tests: new Map(),
    byRoot: new Map(),
    byArea: new Map(),
    workItems: new Map(),
    verifiedAreas: new Map(),
    verifiedRoots: new Set(),
    requests: 0,
    cacheReused: true,
  };
  const input = createReadStream(path.join(outputDirectory, 'octane-api-snapshot.ndjson'), {
    encoding: 'utf8',
  });
  const normalized = new Transform({
    decodeStrings: false,
    transform(chunk, _encoding, callback) {
      callback(null, escapeJsonLineSeparators(chunk.toString()));
    },
  });
  input.on('error', (error) => normalized.destroy(error));
  const lines = createInterface({ input: input.pipe(normalized), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('Saved API extraction contains an invalid JSON record.');
    }
    if (record.type === 'metadata') {
      if (record.version !== 1 || record.project !== project || record.sourceHash !== sourceHash) {
        throw new Error('API snapshot does not match the source workbook and Octane workspace.');
      }
      result.startedAt = record.startedAt;
      result.fetchedAt = record.fetchedAt;
      result.reason = `Rebuilt from the saved API extraction (${record.requests} original GET requests); current rebuild performs no API calls.`;
      result.verifiedRoots = new Set(record.verifiedRoots);
      continue;
    }
    const destinations = {
      work_item: result.workItems,
      area: result.verifiedAreas,
      test: result.tests,
    };
    if (destinations[record.type]) destinations[record.type].set(record.id, record.value);
    if (record.type === 'root_membership') result.byRoot.set(record.id, new Set(record.value));
    if (record.type === 'area_membership') result.byArea.set(record.id, new Set(record.value));
  }
  if (!result.fetchedAt) throw new Error('API snapshot metadata is missing.');
  return result;
}

function mergedValue(sheet, column, row) {
  const position = XLSX.utils.decode_cell(`${column}${row}`);
  const merge = (sheet['!merges'] ?? []).find(
    (range) =>
      range.s.r <= position.r &&
      range.e.r >= position.r &&
      range.s.c <= position.c &&
      range.e.c >= position.c,
  );
  return sheet[merge ? XLSX.utils.encode_cell(merge.s) : `${column}${row}`]?.v ?? null;
}

function buildGroups(sheet) {
  const sharedRanges = (sheet['!merges'] ?? []).filter(
    (range) =>
      range.s.c === range.e.c &&
      [7, 8].includes(range.s.c) &&
      range.s.r >= 2 &&
      range.e.r <= 218 &&
      range.s.r < range.e.r,
  );
  const groups = [];
  for (let row = 3; row <= 219; row += 1) {
    const shared = sharedRanges.find((range) => range.s.r <= row - 1 && range.e.r >= row - 1);
    const firstRow = shared ? shared.s.r + 1 : row;
    let group = groups.find((entry) => entry.firstRow === firstRow);
    if (!group) {
      group = { firstRow, rows: [], labels: new Set(), rootIds: new Set() };
      groups.push(group);
    }
    group.rows.push(row);
    const label = mergedValue(sheet, 'E', row);
    if (label) group.labels.add(String(label));
    const linkText = mergedValue(sheet, 'I', row);
    for (const match of String(linkText ?? '').matchAll(/\b(?:Epic|Feature|Story)\s+(\d+)\b/gi)) {
      group.rootIds.add(match[1]);
    }
  }
  return groups;
}

function loadDatabase(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tests = new Map();
  const areas = new Map();
  const labels = new Map();
  try {
    const summary = database
      .prepare(
        'SELECT COUNT(*) AS records, MIN(fetched_at) AS firstFetched, MAX(fetched_at) AS lastFetched, MIN(year) AS firstYear, MAX(year) AS lastYear FROM octane_manual_runs',
      )
      .get();
    const rows = database.prepare(`
      SELECT mr_id, test_id, test_name, status, native_status, started, finished,
        json_extract(raw_json, '$.test.product_areas') AS testAreas,
        json_extract(raw_json, '$.product_areas') AS runAreas
      FROM octane_manual_runs WHERE test_id IS NOT NULL AND test_id <> ''
    `);
    let executedRecords = 0;
    let plannedRecords = 0;
    for (const row of rows.iterate()) {
      const id = String(row.test_id);
      if (!tests.has(id))
        tests.set(id, {
          id,
          name: row.test_name ?? '',
          subtype: 'test_manual',
          areaIds: new Set(),
          areaNames: new Set(),
          runIds: new Set(),
          plannedIds: new Set(),
        });
      const testcase = tests.get(id);
      const state = String(row.native_status || row.status || '').toLowerCase();
      const planned = [
        'planned',
        'not run',
        'not_run',
        'not completed',
        'not_completed',
        'new',
      ].includes(state);
      const executed = !planned && Boolean(row.started || row.finished);
      if (executed) {
        testcase.runIds.add(String(row.mr_id));
        executedRecords += 1;
      } else {
        testcase.plannedIds.add(String(row.mr_id));
        plannedRecords += 1;
      }
      const rawAreas = references(JSON.parse(row.testAreas || row.runAreas || 'null'));
      for (const area of rawAreas) {
        if (!area.id || !area.name) continue;
        const areaId = String(area.id);
        testcase.areaIds.add(areaId);
        testcase.areaNames.add(area.name);
        if (!areas.has(areaId))
          areas.set(areaId, { id: areaId, names: new Set(), testIds: new Set() });
        areas.get(areaId).names.add(area.name);
        areas.get(areaId).testIds.add(id);
        const label = normalize(area.name);
        if (!labels.has(label)) labels.set(label, new Set());
        labels.get(label).add(areaId);
      }
    }
    return { tests, areas, labels, summary: { ...summary, executedRecords, plannedRecords } };
  } finally {
    database.close();
  }
}

async function readCoverage(rootIds, requestedAreaIds = [], requestedLabels = new Set()) {
  const result = {
    status: 'unavailable',
    reason: '',
    tests: new Map(),
    byRoot: new Map(),
    verifiedRoots: new Set(),
    verifiedAreas: new Map(),
    byArea: new Map(),
    workItems: new Map(),
    startedAt: new Date().toISOString(),
    fetchedAt: '',
    requests: 0,
  };
  try {
    const cookiePath = process.env.VIZION_OCTANE_COOKIE_FILE ?? path.join(vizionRoot, 'cookie.txt');
    const cookie = (await readFile(cookiePath, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!cookie || /\r|\n/.test(cookie))
      throw Object.assign(new Error(), { code: 'COOKIE_UNAVAILABLE' });
    const [sharedSpace, workspace] = project.split('/');
    const apiBase = `${baseUrl}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;
    async function fetchRows(endpoint, fields, query) {
      const rows = [];
      let total = null;
      do {
        result.requests += 1;
        if (result.requests > (detailedReport ? 300 : 150))
          throw Object.assign(new Error(), { code: 'READ_BUDGET_EXCEEDED' });
        const url = new URL(`${apiBase}/${endpoint}`);
        url.search = new URLSearchParams({
          fields,
          query: `"(${query})"`,
          limit: '500',
          offset: String(rows.length),
        });
        const response = await fetch(url, {
          headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          redirect: 'manual',
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw Object.assign(new Error(), { code: `HTTP_${response.status}` });
        if (!(response.headers.get('content-type') ?? '').includes('json')) {
          throw Object.assign(new Error(), { code: 'AUTHENTICATION_REDIRECT' });
        }
        const payload = await response.json();
        const batch = payload.data ?? [];
        total = Number.isFinite(payload.total_count) ? payload.total_count : null;
        if (!batch.length) {
          if (total !== null && rows.length < total)
            throw Object.assign(new Error(), { code: 'INCOMPLETE_PAGE' });
          break;
        }
        rows.push(...batch);
        if (rows.length > (detailedReport ? 50000 : 20000))
          throw Object.assign(new Error(), { code: 'ROW_BUDGET_EXCEEDED' });
        if (detailedReport)
          console.log(`Octane GET ${endpoint}: ${rows.length}/${total ?? '?'} rows`);
        if (total === null && batch.length < 500) break;
      } while (total === null || rows.length < total);
      return rows;
    }
    const idClause = (ids) => ids.map((id) => `'${id}'`).join(',');
    const workItems = result.workItems;
    const roots = await fetchRows(
      'work_items',
      'id,name,subtype,parent{id,name},path',
      `id IN ${idClause(rootIds)}`,
    );
    for (const root of roots) {
      workItems.set(String(root.id), root);
      result.verifiedRoots.add(String(root.id));
      result.byRoot.set(String(root.id), new Set());
    }
    let frontier = roots.map((root) => String(root.id));
    const visited = new Set(frontier);
    for (let depth = 0; frontier.length && depth < 8; depth += 1) {
      const next = [];
      for (let offset = 0; offset < frontier.length; offset += 75) {
        const children = await fetchRows(
          'work_items',
          'id,name,subtype,parent{id,name},path',
          `parent={id IN ${idClause(frontier.slice(offset, offset + 75))}};subtype IN 'feature','story'`,
        );
        for (const child of children) {
          const id = String(child.id);
          workItems.set(id, child);
          if (visited.has(id)) continue;
          visited.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }
    if (frontier.length) throw Object.assign(new Error(), { code: 'INCOMPLETE_HIERARCHY' });
    const testcaseFields = [
      'id,name,subtype,product_areas{id,name},covered_content{id,name,subtype,parent{id,name}}',
      detailedReport
        ? 'description,phase{id,name},owner{full_name,name},creation_time,last_modified'
        : '',
    ]
      .filter(Boolean)
      .join(',');
    function registerTest(testcase) {
      const id = String(testcase.id);
      const covered = references(testcase.covered_content);
      if (Number(testcase.covered_content?.total_count ?? covered.length) > covered.length) {
        throw Object.assign(new Error(), { code: 'INCOMPLETE_TEST_COVERAGE_REFERENCE' });
      }
      result.tests.set(id, testcase);
      for (const item of covered) {
        let current = String(item.id);
        const ancestors = new Set();
        while (current && !ancestors.has(current)) {
          ancestors.add(current);
          result.byRoot.get(current)?.add(id);
          current = String(workItems.get(current)?.parent?.id ?? '');
        }
      }
      for (const area of references(testcase.product_areas))
        result.byArea.get(String(area.id))?.add(id);
    }
    const allIds = Array.from(workItems.keys());
    for (let offset = 0; offset < allIds.length; offset += 75) {
      const tests = await fetchRows(
        'tests',
        testcaseFields,
        `covered_content={id IN ${idClause(allIds.slice(offset, offset + 75))}}`,
      );
      for (const testcase of tests) registerTest(testcase);
    }
    if (detailedReport) {
      const areaIds = new Set(requestedAreaIds);
      for (const testcase of result.tests.values()) {
        for (const area of references(testcase.product_areas)) {
          if (requestedLabels.has(normalize(area.name ?? ''))) areaIds.add(String(area.id));
        }
      }
      const requestedIds = Array.from(areaIds);
      for (let offset = 0; offset < requestedIds.length; offset += 75) {
        const areas = await fetchRows(
          'product_areas',
          'id,name',
          `id IN ${idClause(requestedIds.slice(offset, offset + 75))}`,
        );
        for (const area of areas) {
          result.verifiedAreas.set(String(area.id), area);
          result.byArea.set(String(area.id), new Set());
        }
      }
      const verifiedIds = Array.from(result.verifiedAreas.keys());
      for (let offset = 0; offset < verifiedIds.length; offset += 50) {
        const tests = await fetchRows(
          'tests',
          testcaseFields,
          `product_areas={id IN ${idClause(verifiedIds.slice(offset, offset + 50))}}`,
        );
        for (const testcase of tests) registerTest(testcase);
      }
    }
    result.status = 'available';
    result.fetchedAt = new Date().toISOString();
    result.reason =
      'GET-only coverage lookup completed; execution counts remain the local database snapshot.';
  } catch (error) {
    result.reason = String(error.code ?? error.cause?.code ?? error.name ?? 'REQUEST_FAILED');
    result.tests.clear();
    result.byRoot.clear();
    result.verifiedRoots.clear();
    result.byArea.clear();
    result.verifiedAreas.clear();
    result.workItems.clear();
  }
  return result;
}

function resolveGroups(groups, data, api) {
  for (const [id, testcase] of api.tests) {
    if (!data.tests.has(id))
      data.tests.set(id, {
        id,
        name: testcase.name ?? '',
        subtype: testcase.subtype ?? '',
        areaIds: new Set(),
        areaNames: new Set(),
        runIds: new Set(),
        plannedIds: new Set(),
      });
    const target = data.tests.get(id);
    target.apiVerified = true;
    if (detailedReport) {
      target.historicalAreaIds = new Set(target.areaIds);
      target.areaIds.clear();
      target.areaNames.clear();
      target.name = testcase.name ?? target.name;
      target.subtype = testcase.subtype ?? target.subtype;
      const description = descriptionText(testcase.description);
      target.description = Buffer.from(description.slice(0, 30000), 'utf8').toString('utf8');
      target.descriptionTruncated = description.length > 30000;
      target.summary = target.description
        ? target.description.slice(0, 600)
        : `Title only; Octane description absent: ${target.name}`;
      delete testcase.description;
      target.phase = testcase.phase?.name ?? testcase.phase?.id ?? 'Not set in Octane';
      target.owner = testcase.owner?.full_name ?? testcase.owner?.name ?? 'Not set in Octane';
      target.created = testcase.creation_time ?? '';
      target.modified = testcase.last_modified ?? '';
      target.coveredItems = references(testcase.covered_content);
      target.fetchedAt = api.fetchedAt;
    }
    for (const area of references(testcase.product_areas)) {
      target.areaIds.add(String(area.id));
      target.areaNames.add(area.name ?? '');
    }
  }
  for (const group of groups) {
    group.testIds = new Set();
    group.areaIds = new Set();
    group.runIds = new Set();
    group.plannedIds = new Set();
    group.expectedAreaIds = new Set();
    let liveAreasResolved = detailedReport && group.labels.size > 0;
    for (const label of group.labels) {
      const candidates = liveAreaCandidates(label, data, api);
      if (candidates.length !== 1) {
        liveAreasResolved = false;
        continue;
      }
      group.expectedAreaIds.add(candidates[0]);
    }
    const rootsVerified =
      group.rootIds.size > 0 && Array.from(group.rootIds).every((id) => api.verifiedRoots.has(id));
    if (api.status === 'available' && rootsVerified) {
      group.method = 'API coverage';
      for (const id of group.rootIds) {
        for (const testId of api.byRoot.get(id)) group.testIds.add(testId);
      }
      group.areaIds = new Set(group.expectedAreaIds);
    } else if (api.status === 'available' && liveAreasResolved) {
      group.method = 'API FiF membership';
      group.areaIds = new Set(group.expectedAreaIds);
      for (const id of group.areaIds) {
        for (const testId of api.byArea.get(id)) group.testIds.add(testId);
      }
    } else {
      let resolved = group.labels.size > 0;
      for (const label of group.labels) {
        const candidates = data.labels.get(normalize(label));
        if (candidates?.size !== 1) {
          resolved = false;
          continue;
        }
        group.areaIds.add(Array.from(candidates)[0]);
      }
      group.method = resolved ? 'DB historical FiF' : 'Unavailable';
      if (resolved) {
        for (const areaId of group.areaIds) {
          for (const id of data.areas.get(areaId).testIds) group.testIds.add(id);
        }
      }
    }
    for (const id of group.testIds) {
      for (const runId of data.tests.get(id).runIds) group.runIds.add(runId);
      for (const runId of data.tests.get(id).plannedIds) group.plannedIds.add(runId);
    }
    group.isLive = group.method.startsWith('API ');
    group.fiFMatchingTests =
      group.expectedAreaIds.size > 0
        ? Array.from(group.testIds).filter((id) =>
            Array.from(data.tests.get(id).areaIds).some((areaId) =>
              group.expectedAreaIds.has(areaId),
            ),
          ).length
        : null;
    group.mappingReview = 'Unavailable: current function/category membership is not verified.';
    if (group.method === 'API FiF membership')
      group.mappingReview =
        'Current FiF membership verified by stable product_area ID; not an Epic/Feature scope.';
    if (group.method === 'API coverage') {
      group.mappingReview = liveAreasResolved
        ? `Verified work-item scope; ${group.fiFMatchingTests}/${group.testIds.size} tests share the expected FiF IDs. Check scope if these differ.`
        : 'Work-item coverage verified; the Excel FiF/category label is not resolved to unique current FiF IDs.';
    }
  }
}

function addLiveDetails(sheet, sourceSheet, groups, data, api, testRows) {
  const populatedColumns = Object.entries(sourceSheet)
    .filter(
      ([reference, cell]) => !reference.startsWith('!') && cell.v !== undefined && cell.v !== '',
    )
    .map(([reference]) => XLSX.utils.decode_cell(reference).c);
  const firstColumn = Math.max(...populatedColumns) + 3;
  const headers = [
    'Octane TCs (live)',
    'Delta vs Excel',
    'Octane testcase links',
    'Octane summary',
    'Mapping basis',
    'Mapping evidence',
    'Octane fetched (UTC)',
    'FiF matching TCs (live)',
    'Mapping review',
  ];
  const widths = [20, 18, 35, 90, 28, 75, 28, 24, 95];
  sheet.mergeCells(1, firstColumn, 1, firstColumn + headers.length - 1);
  sheet.getCell(1, firstColumn).value = 'Octane live testcase information';
  headers.forEach((header, index) => {
    const cell = sheet.getCell(2, firstColumn + index);
    cell.value = header;
    cell.style = structuredClone(sheet.getCell('J2').style);
    sheet.getColumn(firstColumn + index).width = widths[index];
  });
  sheet.autoFilter = `A2:${XLSX.utils.encode_col(firstColumn + headers.length - 2)}219`;
  sheet.views = [{ state: 'frozen', xSplit: 5, ySplit: 2 }];
  for (const group of groups) {
    const original = mergedValue(sourceSheet, 'H', group.firstRow);
    const ids = Array.from(group.testIds).sort(
      (left, right) => testRows.get(left) - testRows.get(right),
    );
    const examples = ids.slice(0, 3).map((id) => {
      const testcase = data.tests.get(id);
      return `#${id} ${testcase.name}: ${(testcase.summary ?? '').slice(0, 180)}`;
    });
    const phases = new Map();
    for (const id of ids) {
      const phase = data.tests.get(id).phase ?? 'Unavailable';
      phases.set(phase, (phases.get(phase) ?? 0) + 1);
    }
    const phaseSummary = Array.from(phases, ([phase, count]) => `${phase}: ${count}`).join('; ');
    const evidence =
      group.method === 'API coverage'
        ? `covered_content to original work items and descendants: ${Array.from(group.rootIds).join(', ')}`
        : `product_areas stable IDs: ${Array.from(group.areaIds).join(', ')}`;
    const values = [
      group.isLive ? ids.length : 'N/A',
      group.isLive && typeof original === 'number' ? ids.length - original : 'N/A',
      group.isLive
        ? `${ids.length} live cases - see Test cases and Coverage links`
        : 'Unavailable as a complete live scope',
      group.isLive
        ? `${phaseSummary}\nExamples (not risk-ranked):\n${examples.join('\n')}`
        : 'Unavailable as a complete live scope',
      group.method,
      group.isLive ? evidence : group.mappingReview,
      group.isLive ? api.fetchedAt : 'N/A',
      group.isLive && group.fiFMatchingTests !== null ? group.fiFMatchingTests : 'N/A',
      group.mappingReview,
    ];
    values.forEach((value, index) => {
      const column = firstColumn + index;
      if (group.rows.length > 1)
        sheet.mergeCells(group.firstRow, column, group.rows.at(-1), column);
      const cell = sheet.getCell(group.firstRow, column);
      cell.value = value;
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.note =
        'Current API testcase scope. Original Excel counts and local-snapshot MR counts are separate. See Mapping audit and Coverage links for evidence.';
    });
    if (group.isLive && ids.length > 0) {
      const cell = sheet.getCell(group.firstRow, firstColumn + 2);
      cell.value = { text: values[2], hyperlink: `#'Test cases'!A${testRows.get(ids[0])}` };
      cell.font = { color: { argb: 'FF0563C1' }, underline: true };
    }
  }
}

function* testcaseRows(orderedTests, data, membership, api) {
  for (const id of orderedTests) {
    const testcase = data.tests.get(id);
    const groupsForTest = membership.get(id);
    const sourceRows = groupsForTest.flatMap((group) => group.rows).join(', ');
    const chains = (testcase.coveredItems ?? []).map((item) => workItemChain(item, api));
    const values = [
      id,
      testcase.name,
      testcase.subtype,
      Array.from(testcase.areaIds).join(', '),
      Array.from(testcase.areaNames).join(' / '),
      sourceRows,
      testcase.runIds.size,
      testcase.plannedIds.size,
      { text: testLink(id), hyperlink: testLink(id) },
      testcase.apiVerified ? 'API test ID verified' : 'Test ID observed in DB; link constructed',
    ];
    if (detailedReport)
      values.push(
        testcase.summary ?? `Historical title only; no live description: ${testcase.name}`,
        testcase.description ?? '',
        testcase.phase ?? 'Unavailable (DB snapshot only)',
        testcase.owner ?? '',
        testcase.created ?? '',
        testcase.modified ?? '',
        (testcase.coveredItems ?? [])
          .map((item) => `${item.subtype ?? 'work_item'} ${item.id}: ${item.name ?? ''}`)
          .join('\n')
          .slice(0, 30000),
        chains
          .map((chain) => chain.map((item) => `${item.id}: ${item.name ?? ''}`).join(' -> '))
          .join('\n')
          .slice(0, 30000),
        testcase.fetchedAt ?? '',
        testcase.apiVerified ? 'Octane API' : 'Historical DB snapshot',
        Array.from(testcase.historicalAreaIds ?? testcase.areaIds).join(', '),
        testcase.descriptionTruncated ? 'Yes (30000 characters)' : 'No',
      );
    yield values;
  }
}

function* coverageRows(orderedTests, data, membership, api) {
  for (const id of orderedTests) {
    const testcase = data.tests.get(id);
    if (!testcase.apiVerified) continue;
    const groupsForTest = membership.get(id);
    const sourceRows = groupsForTest.flatMap((group) => group.rows).join(', ');
    const chains = (testcase.coveredItems ?? []).map((item) => workItemChain(item, api));
    for (const chain of chains) {
      const item = chain[0];
      const roots = chain.filter((node) => api.verifiedRoots.has(node.id)).map((node) => node.id);
      const matchingRows = groupsForTest
        .filter((group) => roots.some((root) => group.rootIds.has(root)))
        .flatMap((group) => group.rows);
      if (!matchingRows.length) continue;
      const relatedLink = `${baseUrl}/ui/entity-navigation?p=${project}&entityType=work_item&id=${encodeURIComponent(item.id)}`;
      yield [
        id,
        testLink(id),
        'covered_content',
        item.id,
        item.name ?? '',
        item.subtype ?? 'work_item',
        { text: relatedLink, hyperlink: relatedLink },
        chain[1]?.id ?? '',
        chain[1]?.name ?? '',
        chain.map((node) => `${node.id}: ${node.name ?? ''}`).join(' -> '),
        roots.join(', '),
        matchingRows.join(', '),
        sourceRows,
        'Octane API',
        api.fetchedAt,
      ];
    }
    for (const area of references(api.tests.get(id)?.product_areas)) {
      const matchingRows = groupsForTest
        .filter((group) => group.expectedAreaIds.has(String(area.id)))
        .flatMap((group) => group.rows);
      if (!matchingRows.length) continue;
      yield [
        id,
        testLink(id),
        'product_areas',
        String(area.id),
        area.name ?? '',
        'product_area',
        '',
        '',
        '',
        '',
        '',
        matchingRows.join(', '),
        sourceRows,
        'Octane API',
        api.fetchedAt,
      ];
    }
  }
}

function shiftRange(reference) {
  const range = XLSX.utils.decode_range(reference);
  if (range.s.c >= 9) range.s.c += 1;
  if (range.e.c >= 9) range.e.c += 1;
  return XLSX.utils.encode_range(range);
}

function addTable(workbook, name, headers, rows, widths) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = headers.map((header, index) => ({
    header,
    key: header,
    width: widths[index] ?? 22,
  }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF244A64' } };
  sheet.getRow(1).commit();
  let count = 0;
  for (const values of rows) {
    const row = sheet.addRow(values);
    row.alignment = { vertical: 'top', wrapText: true };
    row.commit();
    count += 1;
  }
  sheet.autoFilter = `A1:${XLSX.utils.encode_col(headers.length - 1)}${count + 1}`;
  sheet.commit();
  return count;
}

function copyTemplateSheet(source, output) {
  const target = output.addWorksheet(source.name, {
    views: source.views,
    state: source.state,
    properties: source.properties,
    pageSetup: source.pageSetup,
    headerFooter: source.headerFooter,
  });
  target.columns = source.columns.map((column) => ({
    width: column.width,
    hidden: column.hidden,
    outlineLevel: column.outlineLevel,
    style: structuredClone(column.style),
  }));
  target.autoFilter = source.autoFilter;
  source.eachRow({ includeEmpty: true }, (row, index) => {
    const destination = target.getRow(index);
    destination.height = row.height;
    destination.hidden = row.hidden;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      if (cell.type === ExcelJS.ValueType.Merge) return;
      const copied = destination.getCell(column);
      copied.value = structuredClone(cell.value);
      copied.style = structuredClone(cell.style);
      if (cell.note) copied.note = structuredClone(cell.note);
    });
  });
  for (const range of source.model.merges) target.mergeCells(range);
  for (let row = 1; row <= source.rowCount; row += 1) target.getRow(row).commit();
  target.commit();
}

async function generate(sourceBytes, sourceMetadata, sourceSheet, groups, data, api) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sourceBytes);
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (cell.value?.formula || cell.value?.sharedFormula)
          cell.value = cell.value.result ?? null;
      }),
    ),
  );
  const sheet = workbook.getWorksheet(sourceSheetName);
  const merges = [...sheet.model.merges];
  for (const range of merges) sheet.unMergeCells(range);
  sheet.spliceColumns(10, 0, []);
  for (const range of merges) sheet.mergeCells(shiftRange(range));
  sheet.autoFilter = shiftRange(sourceSheet['!autofilter']?.ref ?? 'A2:M219');
  sheet.getColumn(10).width = 18;
  sheet.getCell('J2').value = 'mr runs';
  sheet.getCell('J2').style = structuredClone(sheet.getCell('I2').style);
  sheet.getCell('J2').note =
    'Unique actual mr_id records in the local snapshot; Planned records excluded. * = historical FiF scope, not verified Epic/Feature coverage. N/A = unavailable mapping.';

  const membership = new Map();
  for (const group of groups) {
    for (const id of group.testIds) {
      if (!membership.has(id)) membership.set(id, []);
      membership.get(id).push(group);
    }
  }
  const orderedTests = Array.from(membership.keys()).sort((left, right) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
  const testRows = new Map(orderedTests.map((id, index) => [id, index + 2]));
  const auditRows = [];
  for (const group of groups) {
    const unavailable = group.method === 'Unavailable';
    const historical = group.method === 'DB historical FiF';
    const resolvedColor = historical ? 'FFFFF2CC' : 'FFE2F0D9';
    const resolvedStatus = historical
      ? 'Historical scope only *'
      : 'Coverage verified; MR count is local';
    const note = `${group.method}. ${historical ? 'Historical FiF membership; original Epic/Feature scope is unverified. ' : ''}MRs match by test_id, are deduplicated by mr_id, and exclude Planned. Database last fetched: ${data.summary.lastFetched}. Shared rows: ${group.rows.join(', ')}.`;
    if (group.rows.length > 1) sheet.mergeCells(`J${group.rows[0]}:J${group.rows.at(-1)}`);
    const cell = sheet.getCell(`J${group.firstRow}`);
    cell.value = unavailable ? 'N/A' : group.runIds.size;
    cell.numFmt = historical ? '#,##0" *"' : '#,##0';
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: unavailable ? 'FFF0F0F0' : resolvedColor },
    };
    cell.note = unavailable
      ? 'Mapping unavailable. No count is asserted; this is not zero execution.'
      : note;
    const total = sheet.getCell(`H${group.firstRow}`);
    const totalIsEmpty = total.value === null || total.value === undefined || total.value === '';
    const currentScopeNote =
      group.method === 'API FiF membership'
        ? 'Current API product_areas membership for verified FiF IDs; not an Epic/Feature coverage scope.'
        : 'Current API covered_content test inventory, including descendant Feature/Story items.';
    if (totalIsEmpty && !unavailable) {
      total.value = group.testIds.size;
      total.numFmt = historical ? '#,##0" *"' : '#,##0';
      total.note = historical
        ? 'Observed test IDs in historical execution records, not an all-tests coverage inventory.'
        : currentScopeNote;
    }
    const link = sheet.getCell(`I${group.firstRow}`);
    if (!link.value && group.testIds.size) {
      const firstId = Array.from(group.testIds).sort(
        (left, right) => testRows.get(left) - testRows.get(right),
      )[0];
      link.value = {
        text: `${group.testIds.size} test links - see Test cases`,
        hyperlink: `#'Test cases'!A${testRows.get(firstId)}`,
      };
      link.note =
        'The Test cases sheet contains the individual Octane links; Original rows identifies all matches for this row.';
    }
    auditRows.push([
      group.rows.join(', '),
      Array.from(group.labels).join(' / '),
      group.method,
      Array.from(group.areaIds).join(', '),
      Array.from(group.rootIds).join(', '),
      mergedValue(sourceSheet, 'H', group.firstRow),
      unavailable ? null : group.testIds.size,
      unavailable ? null : group.runIds.size,
      unavailable ? null : group.plannedIds.size,
      group.isLive
        ? 'GET-verified coverage; UI links constructed from IDs'
        : 'Existing DB test IDs; UI links constructed from IDs',
      unavailable ? 'Unavailable - not zero' : resolvedStatus,
      note,
    ]);
  }
  if (detailedReport) addLiveDetails(sheet, sourceSheet, groups, data, api, testRows);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'source.xlsx'), sourceBytes);
  const outputPath = path.join(outputDirectory, 'AI requirement - Execution review.xlsx');
  const temporaryOutput = `${outputPath}.partial`;
  const output = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: temporaryOutput,
    useStyles: true,
    useSharedStrings: false,
  });
  output.views = [{ activeTab: 1 }];
  for (const source of workbook.worksheets) copyTemplateSheet(source, output);
  const caseHeaders = [
    'Test ID',
    'Test name',
    'Subtype',
    'FiF IDs',
    'FiF names',
    'Original rows',
    'mr runs',
    'Planned MRs excluded',
    'Octane test link',
    'Link evidence',
  ];
  const caseWidths = [16, 85, 20, 20, 65, 24, 16, 22, 65, 40];
  if (detailedReport) {
    caseHeaders.push(
      'Test summary',
      'Octane description (text)',
      'Test phase',
      'Owner',
      'Created (UTC)',
      'Last modified (UTC)',
      'Covered work items',
      'Coverage chains',
      'API fetched (UTC)',
      'Metadata source',
      'Historical FiF IDs',
      'Description truncated',
    );
    caseWidths.push(95, 95, 30, 30, 30, 30, 95, 95, 30, 30, 30, 30);
  }
  addTable(
    output,
    'Test cases',
    caseHeaders,
    testcaseRows(orderedTests, data, membership, api),
    caseWidths,
  );
  addTable(
    output,
    'Mapping audit',
    [
      'Original rows',
      'Function / category',
      'Count scope',
      'FiF IDs',
      'Requested Epic/Feature IDs',
      'Original TCs overall',
      'Mapped test cases',
      'mr runs',
      'Planned MRs excluded',
      'Octane link source',
      'Status',
      'Notes',
    ],
    auditRows,
    [18, 60, 25, 20, 25, 28, 20, 16, 23, 55, 42, 100],
  );
  const coverageEdges = detailedReport
    ? addTable(
        output,
        'Coverage links',
        [
          'Test ID',
          'Test link',
          'Relation',
          'Related ID',
          'Related name',
          'Related type',
          'Related link',
          'Parent ID',
          'Parent name',
          'Available parent chain',
          'Requested root IDs',
          'Matching source rows',
          'All testcase source rows',
          'Evidence source',
          'API fetched (UTC)',
        ],
        coverageRows(orderedTests, data, membership, api),
        [16, 65, 24, 18, 80, 20, 65, 18, 70, 120, 25, 30, 30, 22, 28],
      )
    : 0;
  const summaryRows = [
    [
      'Source',
      'Independent copy of AI requirement - Spreadsheet.xlsx; the SharePoint source is never written.',
    ],
    ['Generated UTC', new Date().toISOString()],
    ['Source SHA256', createHash('sha256').update(sourceBytes).digest('hex')],
    ['Source ETag', sourceMetadata.etag ?? 'Unavailable'],
    [
      'Database scope',
      `Historical records for ${data.summary.firstYear}-${data.summary.lastYear}; latest fetched ${data.summary.lastFetched}. Not a complete live Octane execution inventory.`,
    ],
    [
      'mr runs',
      'COUNT(DISTINCT mr_id) for matched test_id values, with evidence of started/finished and excluding Planned/unexecuted states. Blocked attempts count as execution.',
    ],
    [
      'Available MR records',
      `${data.summary.records}; actual ${data.summary.executedRecords}; excluded ${data.summary.plannedRecords}.`,
    ],
    [
      '* marker',
      'Historical FiF scope from test.product_areas stable IDs. Original Epic/Feature coverage is unverified for these rows; do not compare this scope directly with original TCs overall.',
    ],
    [
      'Blank TCs overall',
      'Filled from API coverage when verified; otherwise an observed historical test count marked *. Existing populated values are preserved.',
    ],
    [
      'Unavailable mappings',
      'N/A means unavailable mapping, not zero execution. Defect Category alone does not identify a complete test-case scope.',
    ],
    [
      'Zero',
      'No matching actual MR in this local snapshot; does not assert no execution exists in live Octane.',
    ],
    [
      'Duplicates and totals',
      'Shared source rows have merged MR counts. Do not sum row counts: the same test and MR may belong to multiple FiFs or overlapping Epic/Feature scopes.',
    ],
    [
      'API availability',
      `${api.status}; ${api.reason}; GET requests: ${api.requests}. No POST, PUT, PATCH, DELETE, login, or database refresh is performed.`,
    ],
    [
      'Links',
      'Existing links are preserved. Individual test navigation URLs are constructed from observed or API-verified IDs, not browser-checked individually. Filter Test cases by Original rows to see a function scope.',
    ],
    [
      'Source formulas',
      'The report is a static snapshot; original cached formula results are preserved as values to avoid invalid references after inserting a column.',
    ],
  ];
  if (detailedReport)
    summaryRows.push(
      [
        'Live testcase scope',
        'Octane TCs (live) includes all current test subtypes and phases in the verified work-item subtree or verified FiF ID membership. No project, market, status, or release filters are inferred from the Excel label.',
      ],
      [
        'Live extraction window',
        `${api.startedAt} through ${api.fetchedAt}. Queries are paginated GETs; this is not an atomic server snapshot.`,
      ],
      [
        'Descriptions and summaries',
        'Descriptions are parsed from the real API HTML as plain text. Summaries are the first 600 characters; missing descriptions are explicitly marked as title-only. Full cell text is limited to 30000 characters and truncation is flagged.',
      ],
      [
        'Native mapping evidence',
        'Coverage links records actual covered_content and product_areas references establishing source-row mappings. Repeated test URLs are plain text to stay below the Excel hyperlink limit; Test cases contains the clickable testcase links. Unrelated work-item edges are omitted from this sheet but remain in each testcase metadata. Parent chains contain only available API ancestors.',
      ],
      [
        'FiF matching counts',
        'A work-item subtree can cover several FiFs. FiF matching TCs (live) is the subset sharing uniquely resolved expected FiF IDs. Coverage does not establish business approval of a category/function label.',
      ],
      [
        'Actual run warning',
        'mr runs is still the historical local DB snapshot, not current live Octane execution totals. Live testcase count and local run count have different extraction dates.',
      ],
    );
  if (api.cacheReused)
    summaryRows.push([
      'API snapshot rebuild',
      'This workbook reuses the saved authenticated API extraction at the stated extraction time. No fresh API calls were made during this rebuild.',
    ]);
  addTable(output, 'Report notes', ['Item', 'Definition / evidence'], summaryRows, [30, 130]);
  await output.commit();
  await rename(temporaryOutput, outputPath);
  console.log(
    JSON.stringify(
      {
        outputPath,
        sourceHash: summaryRows[2][1],
        api: { status: api.status, reason: api.reason, requests: api.requests },
        groups: groups.length,
        apiGroups: groups.filter((group) => group.method === 'API coverage').length,
        historicalFiFGroups: groups.filter((group) => group.method === 'DB historical FiF').length,
        liveFiFGroups: groups.filter((group) => group.method === 'API FiF membership').length,
        unavailableGroups: groups.filter((group) => group.method === 'Unavailable').length,
        testCases: orderedTests.length,
        apiVerifiedTestCases: orderedTests.filter((id) => data.tests.get(id).apiVerified).length,
        coverageEdges,
        database: data.summary,
      },
      null,
      2,
    ),
  );
}

async function repairWorkbookLinks(filePath) {
  const resolvedPath = path.resolve(filePath);
  const originalBytes = await readFile(resolvedPath);
  const originalHash = createHash('sha256').update(originalBytes).digest('hex');
  const source = XLSX.read(originalBytes, { type: 'buffer', cellHTML: false });
  const sourceSheet = source.Sheets[sourceSheetName];
  if (!sourceSheet) throw new Error('The edited TA worksheet is unavailable.');
  const groups = buildGroups(sourceSheet);
  const seedPath = path.join(path.dirname(resolvedPath), 'octane-api-snapshot.ndjson');
  const handle = await open(seedPath, 'r');
  const buffer = Buffer.alloc(512 * 1024);
  let seedAreas;
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    seedAreas = buffer
      .toString('utf8', 0, bytesRead)
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.startsWith('{"type":"area",'))
      .map((line) => JSON.parse(line).value);
  } finally {
    await handle.close();
  }
  const cookieFile = process.env.VIZION_OCTANE_COOKIE_FILE ?? path.join(vizionRoot, 'cookie.txt');
  const cookie = (await readFile(cookieFile, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!cookie || /\r|\n/.test(cookie)) throw new Error('A valid Octane session is required.');
  const [sharedSpace, workspace] = project.split('/');
  const apiBase = `${baseUrl}/api/shared_spaces/${sharedSpace}/workspaces/${workspace}`;
  let requests = 0;
  async function fetchPage(endpoint, fields, query, limit = 500) {
    requests += 1;
    if (requests > 180)
      throw new Error('Parent-link lookup exceeded its read-only request budget.');
    const url = new URL(`${apiBase}/${endpoint}`);
    url.search = new URLSearchParams({ fields, query: `"(${query})"`, limit: String(limit) });
    const response = await fetch(url, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(`Octane ${endpoint} lookup returned HTTP ${response.status}.`);
    if (!(response.headers.get('content-type') ?? '').includes('json'))
      throw new Error('Octane authentication is required.');
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error('Octane collection response is incomplete.');
    return payload;
  }
  const idsClause = (ids) =>
    ids
      .map((id) => {
        if (!/^\d+$/.test(id)) throw new Error('Invalid collection identifier.');
        return `'${id}'`;
      })
      .join(',');
  async function fetchEntities(endpoint, ids, fields) {
    const entities = new Map();
    for (let offset = 0; offset < ids.length; offset += 75) {
      const payload = await fetchPage(
        endpoint,
        fields,
        `id IN ${idsClause(ids.slice(offset, offset + 75))}`,
      );
      if (payload.total_count > payload.data.length)
        throw new Error('Entity lookup was unexpectedly truncated.');
      for (const entity of payload.data) entities.set(String(entity.id), entity);
    }
    return entities;
  }
  const rootIds = Array.from(new Set(groups.flatMap((group) => Array.from(group.rootIds))));
  const workItems = await fetchEntities(
    'work_items',
    rootIds,
    'id,name,subtype,parent{id,name,subtype}',
  );
  const areas = await fetchEntities(
    'product_areas',
    seedAreas.map((area) => String(area.id)),
    'id,name',
  );
  const areasByLabel = new Map();
  for (const area of areas.values()) {
    const label = normalize(area.name);
    if (!areasByLabel.has(label)) areasByLabel.set(label, []);
    areasByLabel.get(label).push(area);
  }
  const multiRoots = groups
    .filter((group) => group.rootIds.size > 1)
    .flatMap((group) => Array.from(group.rootIds));
  let frontier = multiRoots;
  for (let depth = 0; frontier.length && depth < 8; depth += 1) {
    const parents = Array.from(
      new Set(
        frontier
          .map((id) => String(workItems.get(id)?.parent?.id ?? ''))
          .filter((id) => /^\d+$/.test(id) && id !== '0' && !workItems.has(id)),
      ),
    );
    if (!parents.length) break;
    const fetched = await fetchEntities(
      'work_items',
      parents,
      'id,name,subtype,parent{id,name,subtype}',
    );
    for (const [id, entity] of fetched) workItems.set(id, entity);
    frontier = Array.from(fetched.keys());
  }
  const decisions = groups.map((group) => {
    const roots = Array.from(group.rootIds);
    const count = mergedValue(sourceSheet, 'O', group.firstRow);
    if (roots.length && roots.every((id) => workItems.has(id))) {
      const chains = roots.map((id) => workItemChain(workItems.get(id), { workItems }));
      const common = chains[0].find((item) =>
        chains.every((chain) => chain.some((node) => node.id === item.id)),
      );
      if (common)
        return {
          rows: group.rows,
          entityType: 'work_item',
          entity: common,
          count,
          roots,
          broader: roots.length > 1 && !roots.includes(common.id),
          scope: 'Original work-item scope',
        };
    }
    const candidates = Array.from(group.labels).flatMap(
      (label) => areasByLabel.get(normalize(label)) ?? [],
    );
    const unique = new Map(candidates.map((area) => [String(area.id), area]));
    if (unique.size === 1)
      return {
        rows: group.rows,
        entityType: 'product_area',
        entity: unique.values().next().value,
        count,
        roots,
        broader: false,
        scope: 'Current FiF collection',
      };
    return { rows: group.rows, count, roots, scope: 'No verified single collection', entity: null };
  });
  const areaCounts = new Map();
  const areaIds = Array.from(
    new Set(
      decisions
        .filter((decision) => decision.entityType === 'product_area')
        .map((decision) => String(decision.entity.id)),
    ),
  );
  let nextArea = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, areaIds.length) }, async () => {
      while (nextArea < areaIds.length) {
        const id = areaIds[nextArea];
        nextArea += 1;
        const payload = await fetchPage('tests', 'id', `product_areas={id='${id}'}`, 1);
        if (!Number.isFinite(payload.total_count))
          throw new Error('Current FiF testcase count is unavailable.');
        areaCounts.set(id, payload.total_count);
        if (areaCounts.size % 20 === 0)
          console.log(`API-verified FiF collections: ${areaCounts.size}/${areaIds.length}`);
      }
    }),
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(originalBytes);
  const sheet = workbook.getWorksheet(sourceSheetName);
  const verifiedAt = new Date().toISOString();
  const evidence = [];
  function applyLink(cell, decision) {
    if (!decision.entity) {
      cell.value = 'N/A - no verified Octane collection';
      cell.note =
        'No unique API-verified upstream collection was found. This is not a single-testcase link or an Excel worksheet link.';
      return;
    }
    const id = String(decision.entity.id);
    const title =
      decision.entityType === 'product_area' ? 'FiF' : (decision.entity.subtype ?? 'Work item');
    const target = `${baseUrl}/ui/entity-navigation?p=${project}&entityType=${decision.entityType}&id=${id}`;
    const label = `${title} ${id} - ${decision.entity.name} | Tests`;
    cell.value = { text: label, hyperlink: target };
    cell.alignment = { vertical: 'top', wrapText: true };
    cell.font = { ...cell.font, color: { argb: 'FF0563C1' }, underline: true };
    const currentCount = areaCounts.get(id);
    const scopeNote = decision.broader
      ? `This is the shared ancestor of work items ${decision.roots.join(', ')}. Its Tests page can include additional cases beyond this merged row.`
      : 'Open the upstream entity and select its Tests tab to view the testcase collection.';
    cell.note = `${decision.scope}. ${scopeNote} API verified ${verifiedAt}. Original row testcase count is preserved: ${decision.count}. ${currentCount === undefined ? '' : `Current direct FiF membership: ${currentCount} tests.`}`;
  }
  for (const decision of decisions) {
    const row = decision.rows[0];
    applyLink(sheet.getCell(`Q${row}`), decision);
    for (const sourceRow of decision.rows) {
      const cell = sheet.getCell(`I${sourceRow}`);
      if (cell.hyperlink?.startsWith('#')) applyLink(cell, decision);
    }
    evidence.push({
      rows: decision.rows,
      scope: decision.scope,
      entityType: decision.entityType ?? null,
      entityId: decision.entity ? String(decision.entity.id) : null,
      entityName: decision.entity?.name ?? null,
      sourceCaseCount: decision.count,
      currentFiFCaseCount: decision.entity
        ? (areaCounts.get(String(decision.entity.id)) ?? null)
        : null,
      broaderThanOriginal: decision.broader ?? false,
      originalWorkItemIds: decision.roots,
      verifiedAt,
    });
  }
  const currentHash = createHash('sha256')
    .update(await readFile(resolvedPath))
    .digest('hex');
  if (currentHash !== originalHash)
    throw new Error('The user workbook changed during lookup; no edits were saved.');
  async function preserveInput(candidate) {
    try {
      await copyFile(resolvedPath, candidate, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const savedHash = createHash('sha256')
      .update(await readFile(candidate))
      .digest('hex');
    return savedHash === originalHash;
  }
  let backupPath = resolvedPath.replace(/\.xlsx$/i, '.before-parent-links.xlsx');
  if (!(await preserveInput(backupPath))) {
    backupPath = resolvedPath.replace(
      /\.xlsx$/i,
      `.before-parent-links-${originalHash.slice(0, 12)}.xlsx`,
    );
    if (!(await preserveInput(backupPath)))
      throw new Error('A verified input backup could not be preserved.');
  }
  const temporary = resolvedPath.replace(/\.xlsx$/i, '.parent-links.partial.xlsx');
  await workbook.xlsx.writeFile(temporary);
  const beforeCommitHash = createHash('sha256')
    .update(await readFile(resolvedPath))
    .digest('hex');
  if (beforeCommitHash !== originalHash)
    throw new Error('The user workbook changed during output; no replacement was made.');
  await rename(temporary, resolvedPath);
  await writeFile(
    resolvedPath.replace(/\.xlsx$/i, '.parent-links.json'),
    JSON.stringify(
      {
        sourceHash: originalHash,
        backupPath,
        beforeCommitHash,
        verifiedAt,
        requests,
        source: 'Octane API',
        decisions: evidence,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        editedWorkbook: resolvedPath,
        backupPath,
        sheets: workbook.worksheets.map((entry) => entry.name),
        workItemCollections: decisions.filter((decision) => decision.entityType === 'work_item')
          .length,
        fiFCollections: decisions.filter((decision) => decision.entityType === 'product_area')
          .length,
        unresolved: decisions.filter((decision) => !decision.entity).length,
        broaderSharedAncestors: decisions.filter((decision) => decision.broader).length,
        apiRequests: requests,
      },
      null,
      2,
    ),
  );
}

if (parentWorkbook) {
  await repairWorkbookLinks(parentWorkbook);
} else {
  const artifactText = (await readFile(sourceArtifact, 'utf8')).replace(/^\uFEFF/, '').trim();
  let sourceMetadata;
  for (const candidate of [
    artifactText,
    artifactText.replace(/^Result:\s*/, '').split(/\r?\n/)[0],
  ]) {
    try {
      sourceMetadata = JSON.parse(candidate);
      break;
    } catch {
      continue;
    }
  }
  if (!sourceMetadata?.workbookBase64)
    throw new Error('Workbook response missing from --source-artifact');
  const sourceBytes = Buffer.from(sourceMetadata.workbookBase64, 'base64');
  const source = XLSX.read(sourceBytes, { type: 'buffer', cellHTML: false });
  const sourceSheet = source.Sheets[sourceSheetName];
  if (!sourceSheet) throw new Error('Expected source worksheet is unavailable');
  const groups = buildGroups(sourceSheet);
  const data = loadDatabase(path.join(vizionRoot, 'database', 'source', 'qgate_raw.db'));
  console.log(
    `Read-only DB snapshot loaded: ${data.tests.size} test IDs. Checking Octane GET access.`,
  );
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const api =
    argumentsByName.get('reuse-snapshot') === '1'
      ? await readApiSnapshot(sourceHash)
      : await readCoverage(
          Array.from(new Set(groups.flatMap((group) => Array.from(group.rootIds)))),
          Array.from(
            new Set(
              groups.flatMap((group) =>
                Array.from(group.labels).flatMap((label) =>
                  Array.from(data.labels.get(normalize(label)) ?? []),
                ),
              ),
            ),
          ),
          new Set(groups.flatMap((group) => Array.from(group.labels, normalize))),
        );
  console.log(`Octane API: ${api.status}; ${api.reason}`);
  if (detailedReport && api.status !== 'available')
    throw new Error(`Live testcase data unavailable: ${api.reason}`);
  if (detailedReport && !api.cacheReused) await saveApiSnapshot(api, sourceHash);
  resolveGroups(groups, data, api);
  console.log(
    `Resolved testcase metadata; heap usage ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB. Streaming workbook output.`,
  );
  await generate(sourceBytes, sourceMetadata, sourceSheet, groups, data, api);
}
