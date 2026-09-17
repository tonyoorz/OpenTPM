/**
 * CSV 序列化 + 文件导出。
 *
 * 把 query_defects 已查到的结构化结果(QueryResult.columns/rows)落盘成 CSV 文件,
 * 返回本地路径 + HTTP 下载 URL。agent 在对话里只给摘要 + 下载链接,
 * 避免把几百行数据塞进单条回复被 max_tokens 截断。
 *
 * RFC 4180 兼容:字段含逗号/引号/换行时用双引号包裹,内部引号转义为两个双引号。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

/** CSV 字段转义:含逗号/引号/换行/CRLF 时整体用双引号包裹,内部 " 转义为 ""。 */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** 将列名 + 行数据序列化为 RFC 4180 兼容的 CSV 文本。纯函数,无副作用。 */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map(escapeField).join(',');
  if (rows.length === 0) {
    return header;
  }
  const body = rows
    .map((row) => columns.map((col) => escapeField(row[col])).join(','))
    .join('\r\n');
  return `${header}\r\n${body}`;
}

/** 文件名 sanitize:只保留字母数字下划线连字符和点,防路径穿越。 */
function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return base.length > 0 ? base : 'export';
}

export interface ExportResult {
  /** 本地绝对路径 */
  path: string;
  /** HTTP 下载 URL */
  downloadUrl: string;
  /** 写入的行数(不含表头) */
  rowCount: number;
}

/** 把 CSV 文本写到导出目录,返回本地路径 + 下载 URL。同步写。 */
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
