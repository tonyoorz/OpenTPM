"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCsv = toCsv;
exports.writeExport = writeExport;
exports.draftsToCsv = draftsToCsv;
/**
 * CSV 序列化 + 文件导出。
 *
 * 从 plugin/vizion-defects/src/export.ts 复制，RFC 4180 兼容。
 * 用于导出测试用例草稿（不写 Octane — 安全的离线审查路径）。
 */
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const stage_js_1 = require("./stage.js");
function escapeField(value) {
    if (value === null || value === undefined)
        return '';
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}
function toCsv(columns, rows) {
    const header = columns.map(escapeField).join(',');
    if (rows.length === 0)
        return header;
    const body = rows
        .map((row) => columns.map((col) => escapeField(row[col])).join(','))
        .join('\r\n');
    return `${header}\r\n${body}`;
}
function sanitizeFilename(filename) {
    const base = (0, node_path_1.basename)(filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
    return base.length > 0 ? base : 'export';
}
function writeExport(exportDir, filename, csv, rowCount, baseUrl) {
    const safeName = sanitizeFilename(filename);
    const fullDir = (0, node_path_1.resolve)(exportDir);
    (0, node_fs_1.mkdirSync)(fullDir, { recursive: true });
    const fullPath = (0, node_path_1.join)(fullDir, `${safeName}.csv`);
    (0, node_fs_1.writeFileSync)(fullPath, `﻿${csv}`, 'utf8');
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    const downloadUrl = `${trimmedBase}/${safeName}.csv`;
    return { path: fullPath, downloadUrl, rowCount };
}
const DRAFT_COLUMN_MAP = {
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
function draftsToCsv(drafts) {
    const columns = [...stage_js_1.CSV_COLUMNS];
    const rows = drafts.map((draft) => {
        const row = {};
        for (const col of columns) {
            const field = DRAFT_COLUMN_MAP[col] ?? col;
            row[col] = draft[field] ?? '';
        }
        return row;
    });
    return toCsv(columns, rows);
}
