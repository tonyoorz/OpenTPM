/**
 * 专业 Excel (.xlsx) 导出 — 仿 IDCEVO Phase09 模板样式。
 *
 * 样式规格 (从 IDCEVO_Phase09_Field_Escape_Scenario_Library_V2.xlsx 提取):
 * - 表头: 深蓝填充 #2F5496, 白色粗体 11pt, 自动换行, 顶部对齐, 细边框, 行高 60
 * - 数据行: 按 severity 条件高亮 (High=金 #FFD966, Medium=浅黄 #FFF2CC, Low=灰 #D9D9D9)
 * - 冻结首行 + 自动筛选 + 合理列宽
 */
import ExcelJS from 'exceljs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { type StagedDraft, CSV_COLUMNS } from './stage.js';

const HEADER_FILL: Partial<ExcelJS.Fill> = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF2F5496' },
};

const HEADER_FONT: Partial<ExcelJS.Font> = {
  bold: true,
  size: 11,
  color: { argb: 'FFFFFFFF' },
};

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' as const, color: { argb: 'FF000000' } },
  left: { style: 'thin' as const, color: { argb: 'FF000000' } },
  bottom: { style: 'thin' as const, color: { argb: 'FF000000' } },
  right: { style: 'thin' as const, color: { argb: 'FF000000' } },
};

const SEVERITY_FILLS: Record<string, Partial<ExcelJS.Fill>> = {
  High: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } },
  Critical: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } },
  Medium: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } },
  Low: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } },
};

const COLUMN_LABELS: Record<string, string> = {
  test_id: '用例ID',
  name: '用例名称',
  description: '描述',
  severity: '严重等级',
  software_version: '软件版本',
  assigned_ecu: 'ECU',
  lead_model: '车型',
  preconditions: '前置条件',
  procedure_steps: '操作步骤',
  expected_result: '预期结果',
  pass_criteria: '通过标准',
  fail_criteria: '失败标准',
};

const DATA_DICTIONARY: Array<{ field: string; level: string; definition: string; rule: string }> = [
  { field: '用例ID', level: 'Test Case', definition: '测试用例唯一标识', rule: '如 TC-RT-AI-001, 同一缺陷可生成多条用例' },
  { field: '用例名称', level: 'Test Case', definition: '用例简要名称', rule: '≤100字, 需包含测试目标摘要' },
  { field: '描述', level: 'Test Case', definition: '用例描述 (HTML)', rule: '包含目标/参考/前置/流程/预期/通过失败标准' },
  { field: '严重等级', level: 'Test Case', definition: '缺陷严重度', rule: 'Critical/High/Medium/Low' },
  { field: '软件版本', level: 'Test Case', definition: '被测软件版本', rule: '如 HU_3.5.2' },
  { field: 'ECU', level: 'Test Case', definition: '受影响的 ECU', rule: '如 HU-Entertainment' },
  { field: '车型', level: 'Test Case', definition: '主导车型', rule: '如 G38' },
  { field: '前置条件', level: 'Step', definition: '测试前置条件', rule: '车辆状态/软件/工具/基线数据' },
  { field: '操作步骤', level: 'Step', definition: '操作步骤 (| 分隔)', rule: '每步一个明确操作动作' },
  { field: '预期结果', level: 'Step', definition: '预期结果', rule: '可量化的期望输出' },
  { field: '通过标准', level: 'Verdict', definition: '通过判定标准', rule: '明确的通过条件' },
  { field: '失败标准', level: 'Verdict', definition: '失败判定标准', rule: '明确的失败条件' },
];

function applyHeaderStyle(cell: ExcelJS.Cell): void {
  cell.fill = HEADER_FILL as ExcelJS.Fill;
  cell.font = HEADER_FONT as ExcelJS.Font;
  cell.alignment = { vertical: 'top', wrapText: true } as ExcelJS.Alignment;
  cell.border = THIN_BORDER as ExcelJS.Borders;
}

function applyDataStyle(
  cell: ExcelJS.Cell,
  severity: string | undefined,
  isSeverityCell: boolean,
): void {
  if (isSeverityCell && severity) {
    const fill = SEVERITY_FILLS[severity];
    if (fill) {
      cell.fill = fill as ExcelJS.Fill;
    }
  }
  cell.border = THIN_BORDER as ExcelJS.Borders;
  cell.alignment = { vertical: 'top', wrapText: true } as ExcelJS.Alignment;
}

function estimateColumnWidth(values: string[], maxCap = 50): number {
  let maxLen = 0;
  for (const v of values) {
    if (!v) continue;
    let width = 0;
    for (const ch of v) {
      width += ch.charCodeAt(0) > 127 ? 2 : 1;
    }
    if (width > maxLen) maxLen = width;
  }
  return Math.min(Math.max(maxLen + 2, 8), maxCap);
}

function buildWorkbook(
  sheetName: string,
  columns: string[],
  rows: Record<string, unknown>[],
  options: { severityKey?: string; withDictionary?: boolean } = {},
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const { severityKey, withDictionary = false } = options;

  const ws = wb.addWorksheet(sheetName);
  const labels = columns.map((c) => COLUMN_LABELS[c] ?? c);
  const headerRow = ws.getRow(1);
  for (let i = 0; i < labels.length; i++) {
    headerRow.getCell(i + 1).value = labels[i];
    applyHeaderStyle(headerRow.getCell(i + 1));
  }
  headerRow.height = 60;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const dataRow = ws.getRow(r + 2);
    const severity = severityKey ? String(row[severityKey] ?? '') : undefined;
    for (let c = 0; c < columns.length; c++) {
      const cell = dataRow.getCell(c + 1);
      const raw = row[columns[c]];
      cell.value = raw === null || raw === undefined ? '' : String(raw);
      applyDataStyle(cell, severity, columns[c] === severityKey);
    }
  }

  for (let c = 0; c < columns.length; c++) {
    const colVals = rows.map((r) => String(r[columns[c]] ?? ''));
    colVals.unshift(labels[c]);
    ws.getColumn(c + 1).width = estimateColumnWidth(colVals);
  }

  if (rows.length > 0) {
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: columns.length },
    };
  }

  if (withDictionary) {
    const ds = wb.addWorksheet('Data Dictionary');
    const dictHeaders = ['字段', '层级', '定义', '允许值 / 规则'];
    const dictHeaderRow = ds.getRow(1);
    for (let i = 0; i < dictHeaders.length; i++) {
      const cell = dictHeaderRow.getCell(i + 1);
      cell.value = dictHeaders[i];
      applyHeaderStyle(cell);
    }
    dictHeaderRow.height = 30;
    for (let r = 0; r < DATA_DICTIONARY.length; r++) {
      const entry = DATA_DICTIONARY[r];
      const dataRow = ds.getRow(r + 2);
      dataRow.getCell(1).value = entry.field;
      dataRow.getCell(2).value = entry.level;
      dataRow.getCell(3).value = entry.definition;
      dataRow.getCell(4).value = entry.rule;
      for (let c = 1; c <= 4; c++) {
        const cell = dataRow.getCell(c);
        cell.border = THIN_BORDER as ExcelJS.Borders;
        cell.alignment = { vertical: 'top', wrapText: true } as ExcelJS.Alignment;
      }
    }
    ds.getColumn(1).width = 16;
    ds.getColumn(2).width = 12;
    ds.getColumn(3).width = 35;
    ds.getColumn(4).width = 50;
  }

  return wb;
}

export async function draftsToXlsx(drafts: StagedDraft[]): Promise<Buffer> {
  const columns = [...CSV_COLUMNS];
  const rows = drafts.map((draft) => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const field = col === 'test_id' ? 'draft_id' : col;
      row[col] = draft[field as keyof StagedDraft] ?? '';
    }
    return row;
  });
  const wb = buildWorkbook('Test Cases', columns, rows, {
    severityKey: 'severity',
    withDictionary: true,
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function genericToXlsx(
  columns: string[],
  rows: Record<string, unknown>[],
  options: { severityKey?: string; sheetName?: string } = {},
): Promise<Buffer> {
  const wb = buildWorkbook(
    options.sheetName ?? 'Export',
    columns,
    rows,
    { severityKey: options.severityKey },
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return base.length > 0 ? base : 'export';
}

export interface XlsxExportResult {
  path: string;
  downloadUrl: string;
  rowCount: number;
}

export function writeXlsxExport(
  exportDir: string,
  filename: string,
  buffer: Buffer,
  rowCount: number,
  baseUrl: string,
): XlsxExportResult {
  const safeName = sanitizeFilename(filename);
  const fullDir = resolve(exportDir);
  mkdirSync(fullDir, { recursive: true });
  const fullPath = join(fullDir, `${safeName}.xlsx`);
  writeFileSync(fullPath, buffer);
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const downloadUrl = `${trimmedBase}/${safeName}.xlsx`;
  return { path: fullPath, downloadUrl, rowCount };
}
