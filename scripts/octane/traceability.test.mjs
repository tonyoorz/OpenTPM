import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const implementation = await import('./traceability.mjs').catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});

function exporter() {
  assert.ok(implementation, 'implement the read-only DTSV traceability exporter');
  return implementation;
}

test('normalizes native single and multi-reference shapes', () => {
  const { references } = exporter();
  assert.deepEqual(references({ total_count: 1, data: [{ id: '1' }] }), [{ id: '1' }]);
  assert.deepEqual(references({ id: '2' }), [{ id: '2' }]);
  assert.deepEqual(references({}), []);
  assert.deepEqual(references(null), []);
});

test('preserves actual native ownership and separate execution statuses', () => {
  const { normalizeRun } = exporter();
  const run = normalizeRun({
    id: '101',
    test: { id: '201' },
    test_suite: { id: '301' },
    parent_suite: { id: '401' },
    status: { name: 'Requires Attention' },
    native_status: { name: 'Blocked' },
  });
  assert.equal(run.id, '101');
  assert.equal(run.testId, '201');
  assert.equal(run.suiteId, '301');
  assert.equal(run.suiteRunId, '401');
  assert.equal(run.status, 'Requires Attention');
  assert.equal(run.nativeStatus, 'Blocked');
  assert.equal(run.ownership, 'Native suite and suite-run references');
});

test('never substitutes backlog coverage for an execution plan', () => {
  const { normalizeRun } = exporter();
  const run = normalizeRun({
    id: '102',
    test: { id: '202' },
    covered_content: {
      data: [
        { id: '501', subtype: 'story' },
        { id: '502', subtype: 'story' },
      ],
    },
  });
  assert.equal(run.suiteId, '');
  assert.equal(run.suiteRunId, '');
  assert.equal(run.ownership, 'No native suite ownership; plan unresolved');
  assert.deepEqual(run.coverageIds, ['501', '502']);
});

test('deduplicates defects without losing either native defect source', () => {
  const { normalizeRun } = exporter();
  const run = normalizeRun({
    id: '1',
    defect: { data: [{ id: '901' }] },
    linked_defects: '901,902;902',
  });
  assert.deepEqual(run.defectIds, ['901', '902']);
});

test('normalizes a reference to a root without guessing business role', () => {
  const { normalizeWorkItem } = exporter();
  const item = normalizeWorkItem({
    id: '601',
    name: 'Synthetic_TestEvents',
    subtype: 'epic',
    parent: { id: '701', subtype: 'work_item_root' },
  });
  assert.equal(item.subtype, 'epic');
  assert.equal(item.parentId, '701');
  assert.equal(item.roleEvidence, 'Name hint only; not a distinct API type');
});

test('rejects truncated expanded reference collections', () => {
  const { references } = exporter();
  assert.throws(() => references({ total_count: 2, data: [{ id: '1' }] }), /truncat/i);
});

test('reports missing requested ancestors and suite-membership records', () => {
  const { missingReferences } = exporter();
  assert.equal(typeof missingReferences, 'function');
  const rows = missingReferences({
    testIds: new Set(),
    tests: new Map(),
    suiteIds: new Set(),
    suites: new Map(),
    suiteRunIds: new Set(),
    suiteRuns: new Map(),
    defectIds: new Set(),
    defects: new Map(),
    workItemIds: new Set(['10']),
    requestedWorkItemIds: new Set(['10', '20']),
    workItems: new Map([['10', { id: '10', parentId: '20' }]]),
    membershipIds: new Set(['30']),
    memberships: new Map(),
  });
  assert.ok(rows.some(([kind, id]) => kind === 'Work item' && id === '20'));
  assert.ok(rows.some(([kind, id]) => kind === 'Suite membership' && id === '30'));
});

test('does not reuse matching-ID caches from an older extraction generation', () => {
  const { isReusableCache } = exporter();
  assert.equal(typeof isReusableCache, 'function');
  assert.equal(
    isReusableCache({ schemaVersion: 2, signature: 'same', generationId: 'old' }, 'same', 'new'),
    false,
  );
  assert.equal(
    isReusableCache({ schemaVersion: 2, signature: 'same', generationId: 'new' }, 'same', 'new'),
    true,
  );
});

const exportDirectory = process.env.DTSV_TRACEABILITY_DIR;

test(
  'generated workbook exhaustively matches the extraction manifest',
  { skip: !exportDirectory },
  async () => {
    const directory = path.resolve(exportDirectory);
    const manifestPath = path.join(directory, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'finish the extraction and workbook before acceptance');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.teamId, '59139');
    assert.equal(manifest.workspace, '1002/2001');
    assert.equal(manifest.endedWithEmptyKeysetPage, true);
    const completion = JSON.parse(
      readFileSync(path.join(directory, 'manual-runs.ndjson.complete.json'), 'utf8'),
    );
    assert.equal(completion.schemaVersion, 2);
    assert.equal(completion.runCount, manifest.distinctRuns);
    const require = createRequire(import.meta.url);
    const root = process.env.VIZION_REPO_ROOT_OVERRIDE ?? path.resolve('../vizion-lab');
    const unzipper = require(require.resolve('unzipper', { paths: [root] }));
    const { SaxesParser } = require(require.resolve('saxes', { paths: [root] }));
    const { XMLParser } = require(require.resolve('fast-xml-parser'));
    const archive = await unzipper.Open.file(manifest.output);
    const xml = new XMLParser({ ignoreAttributes: false });
    const workbook = xml.parse(
      (await archive.files.find((entry) => entry.path === 'xl/workbook.xml').buffer()).toString(
        'utf8',
      ),
    );
    const relations = xml.parse(
      (
        await archive.files.find((entry) => entry.path === 'xl/_rels/workbook.xml.rels').buffer()
      ).toString('utf8'),
    );
    const targets = new Map(
      [relations.Relationships.Relationship]
        .flat()
        .map((entry) => [entry['@_Id'], entry['@_Target']]),
    );
    const sheets = [workbook.workbook.sheets.sheet].flat();
    assert.deepEqual(
      sheets.map((sheet) => sheet['@_name']),
      Object.keys(manifest.sheets),
    );
    const counts = {};
    const runIds = new Set();
    for (const sheet of sheets) {
      const name = sheet['@_name'];
      const target = targets.get(sheet['@_r:id']);
      const entry = archive.files.find(
        (item) => item.path === path.posix.normalize(`xl/${target}`),
      );
      assert.ok(entry, `actual worksheet XML for ${name}`);
      counts[name] = 0;
      let rowNumber = 0;
      let column = '';
      let text = '';
      let capture = false;
      let row = {};
      let hyperlinks = 0;
      const parser = new SaxesParser({ xmlns: false });
      parser.on('opentag', (tag) => {
        if (tag.name === 'row') {
          rowNumber = Number(tag.attributes.r);
          row = {};
        }
        if (tag.name === 'c') {
          column = String(tag.attributes.r ?? '').replace(/\d/g, '');
          text = '';
        }
        if (tag.name === 't' || tag.name === 'v')
          capture = name.startsWith('Trace ') && ['A', 'D', 'T'].includes(column);
        if (tag.name === 'hyperlink') hyperlinks += 1;
      });
      parser.on('text', (value) => {
        if (capture) text += value;
      });
      parser.on('closetag', (tag) => {
        if (tag.name === 't' || tag.name === 'v') capture = false;
        if (tag.name === 'c') row[column] = text;
        if (tag.name !== 'row' || rowNumber === 1) return;
        counts[name] += 1;
        if (!name.startsWith('Trace ')) return;
        const id = row.A;
        assert.ok(/^\d+$/.test(id));
        assert.ok(!runIds.has(id), `MR ${id} is duplicated`);
        assert.equal(row.D, 'DTSV_China');
        assert.ok(row.T, 'retain an explicit execution-ownership status');
        runIds.add(id);
      });
      for await (const chunk of entry.stream().setEncoding('utf8')) parser.write(chunk);
      parser.close();
      assert.ok(counts[name] <= 50000, `${name} row partition`);
      assert.ok(hyperlinks <= 65530, `${name} worksheet hyperlink limit`);
    }
    assert.deepEqual(counts, manifest.sheets);
    assert.equal(runIds.size, manifest.distinctRuns);
  },
);
