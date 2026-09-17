/**
 * CSV 序列化 + 文件导出。
 *
 * 从 plugin/vizion-defects/src/export.ts 复制，RFC 4180 兼容。
 * 用于导出测试用例草稿（不写 Octane — 安全的离线审查路径）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { type StagedDraft, CSV_COLUMNS } from './stage.js';

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(escapeField).join(',');
  if (rows.length === 0) return header;
  const body = rows
    .map((row) => columns.map((col) => escapeField(row[col])).join(','))
    .join('\r\n');
  return `${header}\r\n${body}`;
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return base.length > 0 ? base : 'export';
}

export interface ExportResult {
  path: string;
  downloadUrl: string;
  rowCount: number;
}

export function writeExport(
  exportDir: string,
  filename: string,
  csv: string,
  rowCount: number,
  baseUrl: string,
): ExportResult {
  const safeName = sanitizeFilename(filename);
  const fullDir = resolve(exportDir);
  mkdirSync(fullDir, { recursive: true });
  const fullPath = join(fullDir, `${safeName}.csv`);
  writeFileSync(fullPath, `﻿${csv}`, 'utf8');
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const downloadUrl = `${trimmedBase}/${safeName}.csv`;
  return { path: fullPath, downloadUrl, rowCount };
}

const DRAFT_COLUMN_MAP: Record<string, keyof StagedDraft> = {
  test_id: 'draft_id',
  name: 'name',
  description: 'description',
  severity: 'severity',
  software_version: 'software_version',
  assigned_ecu: 'assigned_ecu',
  lead_model: 'lead_model',
  preconditions: 'preconditions',
  procedure_steps: 'procedure_steps',
  expected_result: 'expected_result',
  pass_criteria: 'pass_criteria',
  fail_criteria: 'fail_criteria',
};

export function draftsToCsv(drafts: StagedDraft[]): string {
  const columns = [...CSV_COLUMNS];
  const rows = drafts.map((draft) => {
    const row: Record<string, unknown> = {};
    for (const col of columns) {
      const field = DRAFT_COLUMN_MAP[col] ?? col;
      row[col] = draft[field] ?? '';
    }
    return row;
  });
  return toCsv(columns, rows);
}
