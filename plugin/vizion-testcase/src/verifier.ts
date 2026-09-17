/**
 * 测试用例质检 — LLM-as-judge 的程序化替代。
 *
 * 重写自 vizion-lab/backend/analytics/test_case_verifier.py。
 * 5 项纯文本启发式检查，无需 LLM：
 * 1. failure_mode_coverage — steps 是否引用缺陷名关键词
 * 2. step_reproducibility — action steps ≥ 3
 * 3. format_compliance — steps 含 [PreCon] 和 ? 前缀
 * 4. checkpoint_quantification — checkpoints 含数值/阈值
 * 5. defect_traceability — description 引用缺陷 ID
 */
import type { VerificationCriterion, VerificationResult } from './types.js';

const SKIP_WORDS = new Set([
  'test', 'case', 'issue', 'defect', 'the', 'a', 'an', 'is', 'not', 'for', 'of', 'in',
]);

function checkFormatCompliance(stepsText: string): VerificationCriterion {
  const hasPrecon = stepsText.includes('[PreCon]');
  const hasCheckpoint = stepsText.includes('?');
  const hasLines = stepsText.trim().length > 0;
  if (hasPrecon && hasCheckpoint && hasLines) {
    return { name: 'format_compliance', passed: true, evidence: 'steps use [PreCon] and ? prefixes correctly' };
  }
  const missing: string[] = [];
  if (!hasPrecon) missing.push('[PreCon] prefix');
  if (!hasCheckpoint) missing.push('? checkpoint prefix');
  if (!hasLines) missing.push('non-empty content');
  return { name: 'format_compliance', passed: false, evidence: `missing: ${missing.join(', ')}` };
}

function checkDefectTraceability(descriptionHtml: string, defectId: string): VerificationCriterion {
  if (defectId && descriptionHtml.includes(defectId)) {
    return { name: 'defect_traceability', passed: true, evidence: `description references defect ${defectId}` };
  }
  return { name: 'defect_traceability', passed: false, evidence: `defect ID ${defectId} not found in description` };
}

function checkCheckpointQuantification(stepsText: string): VerificationCriterion {
  const checkpointLines = stepsText.split('\n').filter((line) => line.includes('?'));
  if (checkpointLines.length === 0) {
    return { name: 'checkpoint_quantification', passed: false, evidence: 'no checkpoint lines (?) found' };
  }
  const quantifiedPattern = /\d|%|<=|>=|<|>|threshold|within|below|above|not exceed/i;
  const quantified = checkpointLines.filter((line) => quantifiedPattern.test(line)).length;
  const ratio = quantified / checkpointLines.length;
  if (ratio >= 0.5) {
    return {
      name: 'checkpoint_quantification',
      passed: true,
      evidence: `${quantified}/${checkpointLines.length} checkpoints have specific values/thresholds`,
    };
  }
  return {
    name: 'checkpoint_quantification',
    passed: false,
    evidence: `only ${quantified}/${checkpointLines.length} checkpoints have specific values — add thresholds`,
  };
}

function checkStepReproducibility(stepsText: string): VerificationCriterion {
  const lines = stepsText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.startsWith('-'));
  const actionLines = lines.filter((l) => !l.startsWith('- [PreCon]') && !l.startsWith('- ?'));
  if (actionLines.length >= 3) {
    return { name: 'step_reproducibility', passed: true, evidence: `${actionLines.length} action steps — sufficient for reproducibility` };
  }
  return { name: 'step_reproducibility', passed: false, evidence: `only ${actionLines.length} action steps — need more concrete execution steps` };
}

function checkFailureModeCoverage(defect: { name?: unknown }, stepsText: string): VerificationCriterion {
  const defectName = String(defect?.name ?? '');
  const tokens = defectName.toLowerCase().match(/[a-zA-Z]{3,}/g) ?? [];
  const keyTerms = tokens.filter((t) => !SKIP_WORDS.has(t)).slice(0, 5);
  if (keyTerms.length === 0) {
    return { name: 'failure_mode_coverage', passed: true, evidence: 'no extractable key terms from defect name — skipping' };
  }
  const stepsLower = stepsText.toLowerCase();
  const covered = keyTerms.filter((t) => stepsLower.includes(t));
  if (covered.length >= Math.max(1, Math.floor(keyTerms.length / 2))) {
    return {
      name: 'failure_mode_coverage',
      passed: true,
      evidence: `steps cover ${covered.length}/${keyTerms.length} key terms from defect: [${covered.join(', ')}]`,
    };
  }
  const missing = keyTerms.filter((t) => !covered.includes(t));
  return {
    name: 'failure_mode_coverage',
    passed: false,
    evidence: `steps only cover ${covered.length}/${keyTerms.length} key terms — missing: [${missing.join(', ')}]`,
  };
}

interface DefectInfo {
  defect_id?: unknown;
  name?: unknown;
}

/** 运行全部 5 项验证检查。 */
export function verifyTestCase(params: {
  defect: DefectInfo;
  descriptionHtml: string;
  stepsText: string;
}): VerificationResult {
  const { defect, descriptionHtml, stepsText } = params;
  const defectId = String(defect?.defect_id ?? '');

  const criteria: VerificationCriterion[] = [
    checkFailureModeCoverage(defect, stepsText),
    checkStepReproducibility(stepsText),
    checkFormatCompliance(stepsText),
    checkCheckpointQuantification(stepsText),
    checkDefectTraceability(descriptionHtml, defectId),
  ];

  const failed = criteria.filter((c) => !c.passed);
  const passCount = criteria.length - failed.length;
  if (failed.length === 0) {
    return { passed: true, criteria, feedback: '', pass_count: passCount, total_count: criteria.length };
  }

  const feedbackParts = failed.map((c) => `- ${c.name}: ${c.evidence}`);
  const feedback = 'Regeneration needed — the following criteria failed:\n' + feedbackParts.join('\n');
  return { passed: false, criteria, feedback, pass_count: passCount, total_count: criteria.length };
}
