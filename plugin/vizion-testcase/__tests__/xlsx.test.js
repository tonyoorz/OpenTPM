const ExcelJS = require('exceljs');
const {
  draftsToXlsx,
  genericToXlsx,
  writeXlsxExport,
} = require('../dist/xlsx.js');
const {
  stageDraft,
  clearStagedDrafts,
  getStagedDrafts,
} = require('../dist/stage.js');

function makeDraft(overrides = {}) {
  return {
    draft_id: 'TC-001',
    name: 'Test case 1',
    description: 'Description 1',
    severity: 'High',
    software_version: 'HU_3.5.2',
    assigned_ecu: 'HU-Entertainment',
    lead_model: 'G38',
    preconditions: 'Vehicle stationary',
    procedure_steps: 'Step 1|Step 2|Step 3',
    expected_result: 'Expected result',
    pass_criteria: 'All steps pass',
    fail_criteria: 'Any step fails',
    ...overrides,
  };
}

async function loadWb(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe('draftsToXlsx', () => {
  beforeEach(() => clearStagedDrafts());

  test('generates a valid xlsx Buffer', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
  });

  test('creates two sheets: Test Cases + Data Dictionary', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    expect(wb.worksheets).toHaveLength(2);
    expect(wb.worksheets[0].name).toBe('Test Cases');
    expect(wb.worksheets[1].name).toBe('Data Dictionary');
  });

  test('header row has dark blue fill and white bold font', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    const ws = wb.getWorksheet('Test Cases');
    const headerCell = ws.getCell('A1');
    expect(headerCell.fill.type).toBe('pattern');
    expect(headerCell.fill.fgColor.argb).toBe('FF2F5496');
    expect(headerCell.font.bold).toBe(true);
    expect(headerCell.font.color.argb).toBe('FFFFFFFF');
  });

  test('data row fill matches severity (High = gold)', async () => {
    stageDraft(makeDraft({ draft_id: 'TC-001', severity: 'High' }));
    stageDraft(makeDraft({ draft_id: 'TC-002', severity: 'Medium' }));
    stageDraft(makeDraft({ draft_id: 'TC-003', severity: 'Low' }));
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    const ws = wb.getWorksheet('Test Cases');

    const severityCol = 4; // test_id, name, description, severity
    expect(ws.getCell(2, severityCol).fill.fgColor.argb).toBe('FFFFD966');
    expect(ws.getCell(3, severityCol).fill.fgColor.argb).toBe('FFFFF2CC');
    expect(ws.getCell(4, severityCol).fill.fgColor.argb).toBe('FFD9D9D9');
  });

  test('first row is frozen', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    const ws = wb.getWorksheet('Test Cases');
    expect(ws.views[0].state).toBe('frozen');
    expect(ws.views[0].ySplit).toBe(1);
  });

  test('auto filter is enabled', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    const ws = wb.getWorksheet('Test Cases');
    expect(ws.autoFilter).toBeTruthy();
  });

  test('header uses Chinese labels', async () => {
    stageDraft(makeDraft());
    const buffer = await draftsToXlsx(getStagedDrafts());
    const wb = await loadWb(buffer);
    const ws = wb.getWorksheet('Test Cases');
    expect(ws.getCell('A1').value).toBe('用例ID');
    expect(ws.getCell('D1').value).toBe('严重等级');
  });
});

describe('genericToXlsx', () => {
  test('generates xlsx with custom columns', async () => {
    const columns = ['id', 'name', 'severity'];
    const rows = [
      { id: '1', name: 'First', severity: 'High' },
      { id: '2', name: 'Second', severity: 'Low' },
    ];
    const buffer = await genericToXlsx(columns, rows, { severityKey: 'severity' });
    const wb = await loadWb(buffer);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('id');
    expect(ws.getCell(2, 1).value).toBe('1');
    expect(ws.getCell(2, 3).fill.fgColor.argb).toBe('FFFFD966');
    expect(ws.getCell(3, 3).fill.fgColor.argb).toBe('FFD9D9D9');
  });

  test('no severity highlight when severityKey not provided', async () => {
    const columns = ['id', 'name'];
    const rows = [{ id: '1', name: 'First' }];
    const buffer = await genericToXlsx(columns, rows);
    const wb = await loadWb(buffer);
    const ws = wb.worksheets[0];
    const fill = ws.getCell(2, 1).fill;
    expect(fill.fgColor?.argb).not.toBe('FFFFD966');
    expect(fill.fgColor?.argb).not.toBe('FFFFF2CC');
    expect(fill.fgColor?.argb).not.toBe('FFD9D9D9');
  });

  test('custom sheet name', async () => {
    const buffer = await genericToXlsx(['a'], [{ a: '1' }], { sheetName: 'My Sheet' });
    const wb = await loadWb(buffer);
    expect(wb.worksheets[0].name).toBe('My Sheet');
  });
});

describe('writeXlsxExport', () => {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const tmpDir = path.join(os.tmpdir(), 'vizion-testcase-xlsx-test');

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('writes file and returns result', async () => {
    const buffer = await genericToXlsx(['col'], [{ col: 'val' }]);
    const result = writeXlsxExport(tmpDir, 'test_export', buffer, 1, 'http://localhost:3080/exports');
    expect(result.path.endsWith('test_export.xlsx')).toBe(true);
    expect(result.downloadUrl).toBe('http://localhost:3080/exports/test_export.xlsx');
    expect(result.rowCount).toBe(1);
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test('sanitizes filename', async () => {
    const buffer = await genericToXlsx(['col'], [{ col: 'val' }]);
    const result = writeXlsxExport(tmpDir, 'test-export<>file', buffer, 1, 'http://localhost:3080/exports');
    expect(result.path).toMatch(/test-export__file\.xlsx$/);
  });
});
