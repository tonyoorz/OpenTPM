"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTestCase = verifyTestCase;
const SKIP_WORDS = new Set([
    'test', 'case', 'issue', 'defect', 'the', 'a', 'an', 'is', 'not', 'for', 'of', 'in',
]);
function checkFormatCompliance(stepsText) {
    const hasPrecon = stepsText.includes('[PreCon]');
    const hasCheckpoint = stepsText.includes('?');
    const hasLines = stepsText.trim().length > 0;
    if (hasPrecon && hasCheckpoint && hasLines) {
        return { name: 'format_compliance', passed: true, evidence: 'steps use [PreCon] and ? prefixes correctly' };
    }
    const missing = [];
    if (!hasPrecon)
        missing.push('[PreCon] prefix');
    if (!hasCheckpoint)
        missing.push('? checkpoint prefix');
    if (!hasLines)
        missing.push('non-empty content');
    return { name: 'format_compliance', passed: false, evidence: `missing: ${missing.join(', ')}` };
}
function checkDefectTraceability(descriptionHtml, defectId) {
    if (defectId && descriptionHtml.includes(defectId)) {
        return { name: 'defect_traceability', passed: true, evidence: `description references defect ${defectId}` };
    }
    return { name: 'defect_traceability', passed: false, evidence: `defect ID ${defectId} not found in description` };
}
function checkCheckpointQuantification(stepsText) {
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
function checkStepReproducibility(stepsText) {
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
function checkFailureModeCoverage(defect, stepsText) {
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
/** 运行全部 5 项验证检查。 */
function verifyTestCase(params) {
    const { defect, descriptionHtml, stepsText } = params;
    const defectId = String(defect?.defect_id ?? '');
    const criteria = [
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
