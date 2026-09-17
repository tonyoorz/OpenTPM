/**
 * export.ts 测试 —— 真实文件系统,不 mock fs(CLAUDE.md 测试规范)。
 * 用 os.tmpdir() 下随机子目录作导出目录,测完清理。
 *
 * 运行:npx jest(需先 npm run build 生成 dist/)
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const { toCsv, writeExport } = require('../dist/export.js');

describe('toCsv', () => {
  it('空行数据只返回表头', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });

  it('普通数据正确序列化', () => {
    const rows = [{ a: '1', b: '2' }, { a: '3', b: '4' }];
    expect(toCsv(['a', 'b'], rows)).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('含逗号的字段用双引号包裹', () => {
    const rows = [{ name: '缺陷,测试' }];
    expect(toCsv(['name'], rows)).toBe('name\r\n"缺陷,测试"');
  });

  it('含引号的字段转义为两个双引号', () => {
    const rows = [{ name: '说"你好"' }];
    expect(toCsv(['name'], rows)).toBe('name\r\n"说""你好"""');
  });

  it('含换行的字段用双引号包裹', () => {
    const rows = [{ name: '第一行\n第二行' }];
    expect(toCsv(['name'], rows)).toBe('name\r\n"第一行\n第二行"');
  });

  it('中文字段正确序列化', () => {
    const rows = [{ defect_id: 'D001', name: '制动系统异常', severity: 'High' }];
    expect(toCsv(['defect_id', 'name', 'severity'], rows))
      .toBe('defect_id,name,severity\r\nD001,制动系统异常,High');
  });

  it('null 和 undefined 转为空字符串', () => {
    const rows = [{ a: null, b: undefined, c: 'x' }];
    expect(toCsv(['a', 'b', 'c'], rows)).toBe('a,b,c\r\n,,x');
  });

  it('数字和布尔值通过 JSON.stringify 转换', () => {
    const rows = [{ count: 42, active: true }];
    expect(toCsv(['count', 'active'], rows)).toBe('count,active\r\n42,true');
  });
});

describe('writeExport', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vizion-export-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写文件到导出目录并返回路径和 URL', () => {
    const csv = 'a,b\r\n1,2';
    const result = writeExport(tmpDir, 'test-file', csv, 1, 'http://localhost:3080/exports');
    expect(result.rowCount).toBe(1);
    expect(result.downloadUrl).toBe('http://localhost:3080/exports/test-file.csv');
    expect(fs.existsSync(result.path)).toBe(true);
    const content = fs.readFileSync(result.path, 'utf8');
    expect(content).toBe(`﻿${csv}`);
  });

  it('写入的文件带 UTF-8 BOM 头,Excel 打开中文不乱码', () => {
    const csv = toCsv(['缺陷'], [{ '缺陷': '制动异常' }]);
    const result = writeExport(tmpDir, 'bom-test', csv, 1, 'http://x/exports');
    const buf = fs.readFileSync(result.path);
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it('baseUrl 尾部斜杠被正确处理', () => {
    const result = writeExport(tmpDir, 'test', 'a\r\n1', 1, 'http://10.165.22.10:3080/exports/');
    expect(result.downloadUrl).toBe('http://10.165.22.10:3080/exports/test.csv');
  });

  it('文件名 sanitize 非法字符替换为下划线', () => {
    const result = writeExport(tmpDir, 'defects high!!', 'a\r\n1', 1, 'http://x/exports');
    expect(path.basename(result.path)).toBe('defects_high__.csv');
    expect(result.downloadUrl).toBe('http://x/exports/defects_high__.csv');
  });

  it('纯非法字符文件名替换为下划线', () => {
    const result = writeExport(tmpDir, '!!!', 'a\r\n1', 1, 'http://x/exports');
    expect(path.basename(result.path)).toBe('___.csv');
  });

  it('空字符串文件名回退为 export', () => {
    const result = writeExport(tmpDir, '', 'a\r\n1', 1, 'http://x/exports');
    expect(path.basename(result.path)).toBe('export.csv');
  });

  it('路径穿越攻击被阻止', () => {
    const result = writeExport(tmpDir, '../../../etc/passwd', 'a\r\n1', 1, 'http://x/exports');
    expect(result.path.startsWith(tmpDir)).toBe(true);
    expect(path.basename(result.path)).toBe('passwd.csv');
  });

  it('导出目录不存在时自动创建', () => {
    const newDir = path.join(tmpDir, 'sub', 'dir');
    const result = writeExport(newDir, 'test', 'a\r\n1', 1, 'http://x/exports');
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('含 .csv 后缀的文件名保留点号', () => {
    const result = writeExport(tmpDir, 'test.csv', 'a\r\n1', 1, 'http://x/exports');
    expect(path.basename(result.path)).toBe('test.csv.csv');
  });
});
