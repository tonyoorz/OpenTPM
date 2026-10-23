"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalTicketId = canonicalTicketId;
exports.toTicketAnalysisRecord = toTicketAnalysisRecord;
exports.readAnalysisWorkbook = readAnalysisWorkbook;
exports.createAnalysisSchema = createAnalysisSchema;
exports.importAnalysisWorkbook = importAnalysisWorkbook;
const exceljs_1 = __importDefault(require("exceljs"));
const pg_1 = __importDefault(require("pg"));
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
function cellValue(cell) {
    if (cell.value === null || cell.value === undefined)
        return '';
    if (cell.value instanceof Date)
        return cell.value.toISOString();
    if (typeof cell.value === 'object')
        return cell.text;
    return String(cell.value);
}
function normalizedHeader(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isTicketIdHeader(value) {
    const header = normalizedHeader(value);
    return header.includes('ticket') || header.includes('defect') || header.includes('issue') || header.includes('bug');
}
function canonicalTicketId(value) {
    return value.trim().replace(/^d\s*-?\s*/i, '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
function headersFor(sheet) {
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        const headers = [];
        for (let column = 1; column <= sheet.columnCount; column++) {
            headers.push(cellValue(row.getCell(column)).trim());
        }
        if (headers.some(Boolean))
            return { rowNumber, headers };
    }
    return undefined;
}
function ticketIdFor(headers, data) {
    for (const header of headers) {
        if (!isTicketIdHeader(header))
            continue;
        const ticketId = data[header] ?? '';
        if (ticketId.trim())
            return ticketId;
    }
    return '';
}
function firstValue(data, names) {
    for (const name of names) {
        const value = data[name];
        if (value?.trim())
            return value;
    }
    return '';
}
function toTicketAnalysisRecord(row) {
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
async function readAnalysisWorkbook(buffer) {
    const workbook = new exceljs_1.default.Workbook();
    const input = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    await workbook.xlsx.load(input);
    const result = [];
    for (const sheet of workbook.worksheets) {
        const headerDefinition = headersFor(sheet);
        if (!headerDefinition)
            continue;
        const { rowNumber: headerRow, headers } = headerDefinition;
        for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
            const row = sheet.getRow(rowNumber);
            const data = {};
            for (let column = 0; column < headers.length; column++) {
                const header = headers[column];
                if (!header)
                    continue;
                data[header] = cellValue(row.getCell(column + 1));
            }
            if (!Object.values(data).some((value) => value.trim()))
                continue;
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
async function createAnalysisSchema(client) {
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
const IMPORT_BATCH_SIZE = 500;
function batches(items) {
    const result = [];
    for (let index = 0; index < items.length; index += IMPORT_BATCH_SIZE) {
        result.push(items.slice(index, index + IMPORT_BATCH_SIZE));
    }
    return result;
}
async function upsertWorkbookRows(client, rows, sourceKind, sourceFile) {
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
async function upsertTicketAnalyses(client, rows, sourceFile) {
    for (const batch of batches(rows)) {
        const records = new Map();
        for (const row of batch) {
            if (!row.canonicalTicketId)
                continue;
            records.set(row.canonicalTicketId, {
                ...toTicketAnalysisRecord(row),
                sourceSheet: row.sourceSheet,
                sourceRow: row.sourceRow,
            });
        }
        if (records.size === 0)
            continue;
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
async function importAnalysisWorkbook(filePath, sourceKind, connectionString = process.env['PG_CONNECTION_STRING']) {
    if (!connectionString)
        throw new Error('Missing PG_CONNECTION_STRING');
    const rows = await readAnalysisWorkbook(await (0, promises_1.readFile)(filePath));
    const pool = new pg_1.default.Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await createAnalysisSchema(client);
        const sourceFile = (0, node_path_1.basename)(filePath);
        await upsertWorkbookRows(client, rows, sourceKind, sourceFile);
        await upsertTicketAnalyses(client, rows, sourceFile);
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
        await pool.end();
    }
    return {
        sourceFile: (0, node_path_1.basename)(filePath),
        rowsRead: rows.length,
        rowsImported: rows.length,
        rowsWithoutTicketId: rows.filter((row) => !row.canonicalTicketId).length,
    };
}
