const ExcelJS = require('exceljs');

const {
  canonicalTicketId,
  readAnalysisWorkbook,
  toTicketAnalysisRecord,
} = require('../dist/import.js');

describe('canonicalTicketId', () => {
  test('normalizes optional D prefixes and separators for reliable joins', () => {
    expect(canonicalTicketId(' D-2804379 ')).toBe('2804379');
    expect(canonicalTicketId('2804379')).toBe('2804379');
    expect(canonicalTicketId('')).toBe('');
  });
});

describe('readAnalysisWorkbook', () => {
  test('preserves each source row with its sheet, row number, and original column values', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Analysis');
    sheet.addRow(['Ticket ID', 'LLM Analysis', 'Severity']);
    sheet.addRow(['D-2804379', 'Root cause: malformed payload', 'High']);

    const rows = await readAnalysisWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));

    expect(rows).toEqual([
      {
        sourceSheet: 'Analysis',
        sourceRow: 2,
        ticketId: 'D-2804379',
        canonicalTicketId: '2804379',
        data: {
          'Ticket ID': 'D-2804379',
          'LLM Analysis': 'Root cause: malformed payload',
          Severity: 'High',
        },
      },
    ]);
  });
});

describe('toTicketAnalysisRecord', () => {
  test('extracts searchable core fields from Phase analysis data while retaining the full source row', () => {
    const record = toTicketAnalysisRecord({
      sourceSheet: '05_全部明细',
      sourceRow: 2,
      ticketId: 'D-2804379',
      canonicalTicketId: '2804379',
      data: {
        'Ticket ID': 'D-2804379',
        功能: 'Navigation',
        'Assigned ECU': 'HU-HIGH',
        'Software Version': '24-07',
        'LLM 处理摘要': 'Route matching rejects an otherwise valid destination.',
        '风险层级': 'High',
        '关闭处置': 'Fix planned',
      },
    });

    expect(record).toEqual(expect.objectContaining({
      ticketId: 'D-2804379',
      canonicalTicketId: '2804379',
      description: '',
      llmSummary: 'Route matching rejects an otherwise valid destination.',
      functionName: 'Navigation',
      assignedEcu: 'HU-HIGH',
      softwareVersion: '24-07',
      riskLevel: 'High',
      closureDisposition: 'Fix planned',
    }));
    expect(record.data).toEqual(expect.objectContaining({ 'LLM 处理摘要': 'Route matching rejects an otherwise valid destination.' }));
  });
});