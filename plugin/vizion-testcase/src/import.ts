import ExcelJS from 'exceljs';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PoolClient } from 'pg';

export type AnalysisSourceKind = 'ticket' | 'llm_analysis';

export interface AnalysisWorkbookRow {
  sourceSheet: string;
  sourceRow: number;
  ticketId: string;
  canonicalTicketId: string;
  data: Record<string, string>;
}

export interface TicketAnalysisRecord {
  ticketId: string;
  canonicalTicketId: string;
  description: string;
  llmSummary: string;
  functionName: string;
  assignedEcu: string;
  softwareVersion: string;
  project: string;
  tproject: string;
  riskLevel: string;
  riskScore: string;
  qgateSeverity: string;
  closureDisposition: string;
  closureReason: string;
  data: Record<string, string>;
}

type ExcelJsLoadInput = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];

function cellValue(cell: ExcelJS.Cell): string {
  if (cell.value === null || cell.value === undefined) return '';
  if (cell.value instanceof Date) return cell.value.toISOString();
  if (typeof cell.value === 'object') return cell.text;
  return String(cell.value);
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTicketIdHeader(value: string): boolean {
  const header = normalizedHeader(value);
  return header.includes('ticket') || header.includes('defect') || header.includes('issue') || header.includes('bug');
}

export function canonicalTicketId(value: string): string {
  return value.trim().replace(/^d\s*-?\s*/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function headersFor(sheet: ExcelJS.Worksheet): { rowNumber: number; headers: string[] } | undefined {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const headers: string[] = [];
    for (let column = 1; column <= sheet.columnCount; column++) {
      headers.push(cellValue(row.getCell(column)).trim());
    }
    if (headers.some(Boolean)) return { rowNumber, headers };
  }
  return undefined;
}

function ticketIdFor(headers: string[], data: Record<string, string>): string {
  for (const header of headers) {
    if (!isTicketIdHeader(header)) continue;
    const ticketId = data[header] ?? '';
    if (ticketId.trim()) return ticketId;
  }
  return '';
}

function firstValue(data: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const value = data[name];
    if (value?.trim()) return value;
  }
  return '';
}

export function toTicketAnalysisRecord(row: AnalysisWorkbookRow): TicketAnalysisRecord {
  return {
    ticketId: row.ticketId,
    canonicalTicketId: row.canonicalTicketId,
    description: firstValue(row.data, ['Description', '描述', '原文内容']),
    llmSummary: firstValue(row.data, ['LLM 处理摘要', 'LLM Analysis', 'LLM Summary']),
    functionName: firstValue(row.data, ['功能', 'Function']),
    assignedEcu: firstValue(row.data, ['Assigned ECU', 'ECU']),
    softwareVersion: firstValue(row.data, ['Software Version', '软件版本']),
    project: firstValue(row.data, ['原始项目（project）', 'Project']),
    tproject: firstValue(row.data, ['最终项目（tproject）', 'TProject']),
    riskLevel: firstValue(row.data, ['风险层级', 'Risk Level']),
    riskScore: firstValue(row.data, ['风险分', 'Risk Score']),
    qgateSeverity: firstValue(row.data, ['QGate 严重', 'QGate Severity']),
    closureDisposition: firstValue(row.data, ['关闭处置', 'Closure Disposition']),
    closureReason: firstValue(row.data, ['关闭原因', 'Closure Reason']),
    data: row.data,
  };
}

export async function readAnalysisWorkbook(buffer: Buffer): Promise<AnalysisWorkbookRow[]> {
  const workbook = new ExcelJS.Workbook();
  const input = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ExcelJsLoadInput;
  await workbook.xlsx.load(input);
  const result: AnalysisWorkbookRow[] = [];

  for (const sheet of workbook.worksheets) {
    const headerDefinition = headersFor(sheet);
    if (!headerDefinition) continue;
    const { rowNumber: headerRow, headers } = headerDefinition;

    for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const data: Record<string, string> = {};
      for (let column = 0; column < headers.length; column++) {
        const header = headers[column];
        if (!header) continue;
        data[header] = cellValue(row.getCell(column + 1));
      }
      if (!Object.values(data).some((value) => value.trim())) continue;
      const ticketId = ticketIdFor(headers, data);
      result.push({
        sourceSheet: sheet.name,
        sourceRow: rowNumber,
        ticketId,
        canonicalTicketId: canonicalTicketId(ticketId),
        data,
      });
    }
  }

  return result;
}

export async function createAnalysisSchema(client: PoolClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS defect_analysis`);
  await client.query(`CREATE TABLE IF NOT EXISTS defect_analysis.workbook_rows (
    id BIGSERIAL PRIMARY KEY,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('ticket', 'llm_analysis')),
    source_file TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    ticket_id TEXT NOT NULL DEFAULT '',
    canonical_ticket_id TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_kind, source_file, source_sheet, source_row)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS workbook_rows_ticket_id_idx
    ON defect_analysis.workbook_rows (canonical_ticket_id)
    WHERE canonical_ticket_id <> ''`);
  await client.query(`CREATE TABLE IF NOT EXISTS defect_analysis.ticket_analyses (
    canonical_ticket_id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    llm_summary TEXT NOT NULL DEFAULT '',
    function_name TEXT NOT NULL DEFAULT '',
    assigned_ecu TEXT NOT NULL DEFAULT '',
    software_version TEXT NOT NULL DEFAULT '',
    project TEXT NOT NULL DEFAULT '',
    tproject TEXT NOT NULL DEFAULT '',
    risk_level TEXT NOT NULL DEFAULT '',
    risk_score TEXT NOT NULL DEFAULT '',
    qgate_severity TEXT NOT NULL DEFAULT '',
    closure_disposition TEXT NOT NULL DEFAULT '',
    closure_reason TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL,
    source_file TEXT NOT NULL,
    source_sheet TEXT NOT NULL,
    source_row INTEGER NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS ticket_analyses_risk_level_idx
    ON defect_analysis.ticket_analyses (risk_level)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ticket_analyses_assigned_ecu_idx
    ON defect_analysis.ticket_analyses (assigned_ecu)`);
}

export interface ImportResult {
  sourceFile: string;
  rowsRead: number;
  rowsImported: number;
  rowsWithoutTicketId: number;
}

const IMPORT_BATCH_SIZE = 500;

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += IMPORT_BATCH_SIZE) {
    result.push(items.slice(index, index + IMPORT_BATCH_SIZE));
  }
  return result;
}

async function upsertWorkbookRows(
  client: PoolClient,
  rows: AnalysisWorkbookRow[],
  sourceKind: AnalysisSourceKind,
  sourceFile: string,
): Promise<void> {
  for (const batch of batches(rows)) {
    await client.query(`INSERT INTO defect_analysis.workbook_rows (
      source_kind, source_file, source_sheet, source_row, ticket_id, canonical_ticket_id, data
    ) SELECT $1, $2, source_sheet, source_row, ticket_id, canonical_ticket_id, data
    FROM jsonb_to_recordset($3::jsonb) AS source_rows(
      source_sheet TEXT, source_row INTEGER, ticket_id TEXT, canonical_ticket_id TEXT, data JSONB
    ) ON CONFLICT (source_kind, source_file, source_sheet, source_row)
    DO UPDATE SET ticket_id = EXCLUDED.ticket_id,
      canonical_ticket_id = EXCLUDED.canonical_ticket_id,
      data = EXCLUDED.data,
      imported_at = NOW()`, [
      sourceKind,
      sourceFile,
      JSON.stringify(batch.map((row) => ({
        source_sheet: row.sourceSheet,
        source_row: row.sourceRow,
        ticket_id: row.ticketId,
        canonical_ticket_id: row.canonicalTicketId,
        data: row.data,
      }))),
    ]);
  }
}

async function upsertTicketAnalyses(
  client: PoolClient,
  rows: AnalysisWorkbookRow[],
  sourceFile: string,
): Promise<void> {
  for (const batch of batches(rows)) {
    const records = new Map<string, TicketAnalysisRecord & Pick<AnalysisWorkbookRow, 'sourceSheet' | 'sourceRow'>>();
    for (const row of batch) {
      if (!row.canonicalTicketId) continue;
      records.set(row.canonicalTicketId, {
        ...toTicketAnalysisRecord(row),
        sourceSheet: row.sourceSheet,
        sourceRow: row.sourceRow,
      });
    }
    if (records.size === 0) continue;
    await client.query(`INSERT INTO defect_analysis.ticket_analyses (
      canonical_ticket_id, ticket_id, description, llm_summary, function_name, assigned_ecu,
      software_version, project, tproject, risk_level, risk_score, qgate_severity,
      closure_disposition, closure_reason, data, source_file, source_sheet, source_row
    ) SELECT canonical_ticket_id, ticket_id, description, llm_summary, function_name, assigned_ecu,
      software_version, project, tproject, risk_level, risk_score, qgate_severity,
      closure_disposition, closure_reason, data, $1, source_sheet, source_row
    FROM jsonb_to_recordset($2::jsonb) AS analysis_rows(
      canonical_ticket_id TEXT, ticket_id TEXT, description TEXT, llm_summary TEXT,
      function_name TEXT, assigned_ecu TEXT, software_version TEXT, project TEXT, tproject TEXT,
      risk_level TEXT, risk_score TEXT, qgate_severity TEXT, closure_disposition TEXT,
      closure_reason TEXT, data JSONB, source_sheet TEXT, source_row INTEGER
    ) ON CONFLICT (canonical_ticket_id)
    DO UPDATE SET ticket_id = EXCLUDED.ticket_id,
      description = COALESCE(NULLIF(EXCLUDED.description, ''), defect_analysis.ticket_analyses.description),
      llm_summary = COALESCE(NULLIF(EXCLUDED.llm_summary, ''), defect_analysis.ticket_analyses.llm_summary),
      function_name = COALESCE(NULLIF(EXCLUDED.function_name, ''), defect_analysis.ticket_analyses.function_name),
      assigned_ecu = COALESCE(NULLIF(EXCLUDED.assigned_ecu, ''), defect_analysis.ticket_analyses.assigned_ecu),
      software_version = COALESCE(NULLIF(EXCLUDED.software_version, ''), defect_analysis.ticket_analyses.software_version),
      project = COALESCE(NULLIF(EXCLUDED.project, ''), defect_analysis.ticket_analyses.project),
      tproject = COALESCE(NULLIF(EXCLUDED.tproject, ''), defect_analysis.ticket_analyses.tproject),
      risk_level = COALESCE(NULLIF(EXCLUDED.risk_level, ''), defect_analysis.ticket_analyses.risk_level),
      risk_score = COALESCE(NULLIF(EXCLUDED.risk_score, ''), defect_analysis.ticket_analyses.risk_score),
      qgate_severity = COALESCE(NULLIF(EXCLUDED.qgate_severity, ''), defect_analysis.ticket_analyses.qgate_severity),
      closure_disposition = COALESCE(NULLIF(EXCLUDED.closure_disposition, ''), defect_analysis.ticket_analyses.closure_disposition),
      closure_reason = COALESCE(NULLIF(EXCLUDED.closure_reason, ''), defect_analysis.ticket_analyses.closure_reason),
      data = EXCLUDED.data,
      source_file = EXCLUDED.source_file,
      source_sheet = EXCLUDED.source_sheet,
      source_row = EXCLUDED.source_row,
      imported_at = NOW()`, [
      sourceFile,
      JSON.stringify([...records.values()].map((record) => ({
        canonical_ticket_id: record.canonicalTicketId,
        ticket_id: record.ticketId,
        description: record.description,
        llm_summary: record.llmSummary,
        function_name: record.functionName,
        assigned_ecu: record.assignedEcu,
        software_version: record.softwareVersion,
        project: record.project,
        tproject: record.tproject,
        risk_level: record.riskLevel,
        risk_score: record.riskScore,
        qgate_severity: record.qgateSeverity,
        closure_disposition: record.closureDisposition,
        closure_reason: record.closureReason,
        data: record.data,
        source_sheet: record.sourceSheet,
        source_row: record.sourceRow,
      }))),
    ]);
  }
}

export async function importAnalysisWorkbook(
  filePath: string,
  sourceKind: AnalysisSourceKind,
  connectionString = process.env['PG_CONNECTION_STRING'],
): Promise<ImportResult> {
  if (!connectionString) throw new Error('Missing PG_CONNECTION_STRING');
  const rows = await readAnalysisWorkbook(await readFile(filePath));
  const pool = new pg.Pool({ connectionString, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await createAnalysisSchema(client);
    const sourceFile = basename(filePath);
    await upsertWorkbookRows(client, rows, sourceKind, sourceFile);
    await upsertTicketAnalyses(client, rows, sourceFile);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  return {
    sourceFile: basename(filePath),
    rowsRead: rows.length,
    rowsImported: rows.length,
    rowsWithoutTicketId: rows.filter((row) => !row.canonicalTicketId).length,
  };
}