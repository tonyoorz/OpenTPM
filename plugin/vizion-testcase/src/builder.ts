/**
 * 测试用例内容生成器 — HTML description + 纯文本 steps script。
 *
 * 重写自 vizion-lab/backend/analytics/test_case_builder.py。
 * description 遵循 workspace 2001 约定：单个 <html><body> 块，按序排列
 * Objective / Reference / Preconditions / baseline-regression 表 / procedure / expected / pass-fail。
 * steps 是纯文本，每行一条，前缀标注类型：[PreCon] / 无 / ?。
 */

const OCTANE_WORK_ITEM_URL =
  'https://octane-prod.bmwgroup.net/ui/?p=1002/2001#/entity-navigation?entityType=work_item&id={defectId}';

function text(value: unknown, maxChars = 0): string {
  let result = String(value ?? '').trim();
  if (maxChars && result.length > maxChars) {
    result = result.slice(0, maxChars - 3).trimEnd() + '...';
  }
  return result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function para(textContent: string): string {
  return `<p>${textContent}</p>`;
}

function row(cells: string[]): string {
  return '<tr>' + cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('') + '</tr>';
}

function headerRow(cells: string[]): string {
  return '<tr>' + cells.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
}

function table(header: string[], rows: string[][]): string {
  const parts = [
    '<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">',
    headerRow(header),
    ...rows.map(row),
    '</table>',
  ];
  return parts.join('');
}

interface DefectLike {
  defect_id?: unknown;
  name?: unknown;
  severity?: unknown;
  software_version?: unknown;
  assigned_ecu?: unknown;
  lead_model?: unknown;
}

export interface BuildDescriptionParams {
  defect: DefectLike;
  procedureSteps: string[];
  expected: string[];
  preconditions?: string[];
  passCriteria?: string;
  failCriteria?: string;
  baselineTable?: string[][];
  regressionTable?: string[][];
  extraNotes?: string;
}

/** 渲染 test_manual 的 HTML description。 */
export function buildTestCaseDescription(params: BuildDescriptionParams): string {
  const { defect, procedureSteps, expected, preconditions, passCriteria, failCriteria, baselineTable, regressionTable, extraNotes } = params;
  const defectId = text(defect.defect_id);
  const defectName = text(defect.name, 180);
  const severity = text(defect.severity);
  const sw = text(defect.software_version);
  const ecu = text(defect.assigned_ecu);
  const model = text(defect.lead_model);

  const parts: string[] = ['<html><body>'];

  parts.push(
    para(
      `<b>Objective:</b> Regression test derived from defect D${defectId}`
      + (severity ? ` (${severity})` : '')
      + `. ${escapeHtml(defectName)}.`,
    ),
  );
  parts.push('<p>&nbsp;</p>');

  const refLines = [
    `- Defect: <a href="${OCTANE_WORK_ITEM_URL.replace('{defectId}', defectId)}">D${defectId} - ${escapeHtml(defectName)}</a>`,
  ];
  if (sw) refLines.push(`- Software under test: ${escapeHtml(sw)}`);
  if (ecu) refLines.push(`- ECU: ${escapeHtml(ecu)}`);
  if (model) refLines.push(`- Test vehicle: ${escapeHtml(model)}`);
  parts.push(para('<b>Reference:</b>'));
  parts.push(...refLines.map(para));
  parts.push('<p>&nbsp;</p>');

  if (preconditions?.length) {
    parts.push(para('<b>Preconditions:</b>'));
    parts.push(...preconditions.map((line) => para(`- ${escapeHtml(line)}`)));
    parts.push('<p>&nbsp;</p>');
  }

  if (baselineTable?.length) {
    parts.push(para('<b>Baseline reference:</b>'));
    parts.push(table(baselineTable[0]!, baselineTable.slice(1)));
    parts.push('<p>&nbsp;</p>');
  }
  if (regressionTable?.length) {
    parts.push(para('<b>Regression observed:</b>'));
    parts.push(table(regressionTable[0]!, regressionTable.slice(1)));
    parts.push('<p>&nbsp;</p>');
  }

  parts.push(para('<b>procedure:</b>'));
  procedureSteps.forEach((step, index) => {
    parts.push(para(`${index + 1}. ${escapeHtml(step)}`));
  });
  parts.push('<p>&nbsp;</p>');

  parts.push(para('<b>expected:</b>'));
  parts.push(...expected.map((line) => para(`- ${escapeHtml(line)}`)));
  parts.push('<p>&nbsp;</p>');

  if (passCriteria) parts.push(para(`<b>Pass criteria:</b> ${escapeHtml(passCriteria)}`));
  if (failCriteria) parts.push(para(`<b>Fail criteria:</b> ${escapeHtml(failCriteria)}`));
  if (extraNotes) {
    parts.push('<p>&nbsp;</p>');
    parts.push(para(escapeHtml(extraNotes)));
  }

  parts.push('</body></html>');
  return parts.join('');
}

export interface BuildStepsParams {
  preconditions?: string[];
  steps?: string[];
  checkpoints?: string[];
}

/** 渲染纯文本 steps script（写入 /tests/{id}/script）。 */
export function buildTestStepsScript(params: BuildStepsParams): string {
  const { preconditions = [], steps = [], checkpoints = [] } = params;
  const lines: string[] = [];
  for (const pre of preconditions) lines.push(`- [PreCon] ${pre}`);
  for (const step of steps) lines.push(`- ${step}`);
  for (const checkpoint of checkpoints) lines.push(`- ? ${checkpoint}`);
  return lines.join('\n');
}

export const DEFAULT_SERVICEPACK_NODE_ID = 'd1598r3mjrp37by4yjvy1860k';
export const DEFAULT_TEST_PHASE_ID = 'phase.test_manual.new';
