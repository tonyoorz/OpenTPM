/**
 * Pattern discovery — 缺陷模式聚类。
 *
 * 重写自 vizion-lab/backend/analytics/testcase_pattern_discovery.py。
 * 纯算法逻辑：证据筛选 → 上下文分桶 → 嵌入聚类 → anchor 兼容性检查。
 */
import { createHash } from 'node:crypto';
import { embed, cosineSimilarity } from './embedding.js';
import type { DefectPattern, PatternDiscoveryResult, PatternMember } from './types.js';

export const DEFAULT_SIMILARITY_THRESHOLD = 0.84;
export const PATTERN_DISCOVERY_POLICY_VERSION = '2026-09-03.1';
const MIN_REPRODUCTION_EVIDENCE_CHARS = 40;
const UNKNOWN_CONTEXT_THRESHOLD_INCREMENT = 0.05;
const EMBEDDING_DESCRIPTION_MAX_CHARS = 2400;
const EMBEDDING_COMMENTS_MAX_CHARS = 1200;
const MAX_AUTOMATIC_PATTERN_MEMBERS = 20;

const FUNCTIONAL_ANCHOR_STOPWORDS = new Set([
  'a', 'an', 'and', 'app', 'application', 'are', 'as', 'at', 'be', 'been', 'before',
  'but', 'by', 'can', 'cannot', 'case', 'content', 'could', 'defect', 'did', 'display',
  'do', 'does', 'during', 'empty', 'error', 'fail', 'failed', 'failure', 'feature', 'for',
  'from', 'function', 'has', 'have', 'in', 'interface', 'into', 'is', 'issue', 'it', 'its',
  'lost', 'missing', 'no', 'not', 'of', 'on', 'or', 'page', 'problem', 'rse', 'rsu', 'screen',
  'setting', 'settings', 'show', 'showing', 'shown', 'shows', 'system', 'test', 'that', 'the',
  'there', 'this', 'timeout', 'to', 'under', 'unable', 'unexpected', 'vehicle', 'was', 'when',
  'where', 'while', 'will', 'with', 'without', 'would', 'wrong',
]);

const FUNCTIONAL_ANCHOR_PATTERN = /\b(?:0x[0-9a-f]+|[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)\b/gi;
const CJK_SEQUENCE_PATTERN = /[㐀-鿿]+/g;

function cleanText(value: unknown): string {
  const unescaped = String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return unescaped.replace(/\s+/g, ' ').trim();
}

function normalizeContextValue(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function displayValue(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

interface ContextKey {
  project: string;
  ecu: string;
  model: string;
}

function contextKey(record: Record<string, unknown>): ContextKey {
  return {
    project: normalizeContextValue(record['project']) || 'unknown-project',
    ecu: normalizeContextValue(record['assigned_ecu']) || 'unknown-ecu',
    model: normalizeContextValue(record['lead_model']) || 'unknown-model',
  };
}

function requiresManualReview(key: ContextKey): boolean {
  return key.project.startsWith('unknown-') || key.ecu.startsWith('unknown-') || key.model.startsWith('unknown-');
}

function rawFunctionalAnchorTokens(value: unknown): Set<string> {
  const text = cleanText(value).toLowerCase();
  const tokens = new Set<string>();
  for (const match of text.matchAll(FUNCTIONAL_ANCHOR_PATTERN)) {
    const token = match[0];
    if (FUNCTIONAL_ANCHOR_STOPWORDS.has(token)) continue;
    tokens.add(token);
    if (token.includes('-') || token.includes('_')) {
      for (const part of token.split(/[-_]/)) {
        if (part.length >= 3 && !FUNCTIONAL_ANCHOR_STOPWORDS.has(part)) tokens.add(part);
      }
    }
  }
  for (const match of text.matchAll(CJK_SEQUENCE_PATTERN)) {
    const seq = match[0];
    for (let i = 0; i < Math.max(seq.length - 1, 0); i++) {
      tokens.add(seq.slice(i, i + 2));
    }
  }
  return tokens;
}

function functionalAnchorTokens(record: Record<string, unknown>): Set<string> {
  const contextTokens = new Set<string>();
  for (const field of ['project', 'assigned_ecu', 'lead_model']) {
    for (const t of rawFunctionalAnchorTokens(record[field])) contextTokens.add(t);
  }
  const nameTokens = rawFunctionalAnchorTokens(record['name']);
  return new Set([...nameTokens].filter((t) => !contextTokens.has(t)));
}

function anchorsAreCompatible(left: Set<string>, right: Set<string>): boolean {
  const shared = [...left].filter((t) => right.has(t));
  if (shared.length >= 2) return true;
  return shared.some(
    (token) =>
      token.startsWith('0x') ||
      token.includes('-') ||
      token.includes('_') ||
      (token.length >= 5 && /[a-zA-Z]/.test(token) && /\d/.test(token)),
  );
}

function evidenceText(record: Record<string, unknown>): { text: string; reproductionEvidence: string; descriptionPreview: string } {
  const title = cleanText(record['name']);
  const description = cleanText(record['description']);
  const comments = cleanText(record['comments']);
  const reproductionEvidence = [description, comments].filter(Boolean).join(' ');
  const text = [title, title, description.slice(0, EMBEDDING_DESCRIPTION_MAX_CHARS), comments.slice(0, EMBEDDING_COMMENTS_MAX_CHARS)]
    .filter(Boolean)
    .join(' ');
  return { text, reproductionEvidence, descriptionPreview: description.slice(0, 500) };
}

function memberPayload(record: Record<string, unknown>, similarity: number): PatternMember {
  return {
    defectId: String(record['defect_id'] ?? record['defectId'] ?? ''),
    name: String(record['name'] ?? ''),
    project: displayValue(record['project']),
    assignedEcu: displayValue(record['assigned_ecu']),
    leadModel: displayValue(record['lead_model']),
    softwareVersion: displayValue(record['software_version']),
    detectedInRelease: displayValue(record['detected_in_release']),
    similarityToRepresentative: Math.round(similarity * 1000) / 1000,
  };
}

function patternId(context: ContextKey, memberIds: string[]): string {
  const value = [...Object.values(context), ...memberIds].join('|');
  const hash = createHash('sha256').update(value, 'utf-8').digest('hex').slice(0, 12);
  return `pattern-${hash}`;
}

function uniqueValues(records: Record<string, unknown>[], field: string): string[] {
  const values = new Set<string>();
  for (const record of records) {
    const val = displayValue(record[field]);
    if (val) values.add(val);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

function normalizeEmbeddings(embeddings: Float64Array[], expectedRows: number): Float64Array[] {
  if (embeddings.length !== expectedRows || embeddings.length === 0) {
    throw new Error('embedding encoder returned an invalid matrix');
  }
  return embeddings.map((vec) => {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    const eps = 1e-12;
    const result = new Float64Array(vec.length);
    for (let i = 0; i < vec.length; i++) result[i] = vec[i] / Math.max(norm, eps);
    return result;
  });
}

interface EligibleRecord {
  defect_id: string;
  name: string;
  project: string | null;
  assigned_ecu: string | null;
  lead_model: string | null;
  software_version: string | null;
  detected_in_release: string | null;
  evidence_text: string;
  description_preview: string;
  functional_anchors: Set<string>;
  source_index: number;
  [key: string]: unknown;
}

function clusterBucket(
  records: EligibleRecord[],
  embeddings: Float64Array[],
  indices: number[],
  threshold: number,
): number[][] {
  const remaining = new Set(indices);
  const clusters: number[][] = [];

  const matchingMembers = (repIdx: number, candidates: number[]): number[] => {
    const repEmb = embeddings[repIdx]!;
    return candidates.filter((candidate) => {
      const score = cosineSimilarity(repEmb, embeddings[candidate]!);
      return score >= threshold && (
        candidate === repIdx ||
        anchorsAreCompatible(records[repIdx]!.functional_anchors, records[candidate]!.functional_anchors)
      );
    });
  };

  while (remaining.size > 0) {
    const candidates = Array.from(remaining).sort((a, b) => a - b);
    let best: { memberCount: number; avgSim: number; sourceOrder: number; index: number } | undefined;

    for (const index of candidates) {
      const members = matchingMembers(index, candidates);
      const memberSet = new Set(members);
      const repEmb = embeddings[index]!;
      const sims = candidates.map((c) => memberSet.has(c) ? cosineSimilarity(repEmb, embeddings[c]!) : 0);
      const avgSim = sims.reduce((a, b) => a + b, 0) / Math.max(members.length, 1);
      const candidate = { memberCount: members.length, avgSim, sourceOrder: -records[index]!.source_index, index };
      if (!best ||
        candidate.memberCount > best.memberCount ||
        (candidate.memberCount === best.memberCount && candidate.avgSim > best.avgSim) ||
        (candidate.memberCount === best.memberCount && candidate.avgSim === best.avgSim && candidate.sourceOrder > best.sourceOrder)) {
        best = candidate;
      }
    }

    const repIdx = best!.index;
    const members = matchingMembers(repIdx, candidates);
    const memberSet = new Set(members);
    const sortedMembers = [repIdx, ...members.filter((m) => m !== repIdx).sort((a, b) => records[a]!.source_index - records[b]!.source_index)];
    clusters.push(sortedMembers);
    for (const m of memberSet) remaining.delete(m);
  }

  return clusters;
}

/** 缺陷模式聚类发现。 */
export async function discoverDefectPatterns(
  defects: Record<string, unknown>[],
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
): Promise<PatternDiscoveryResult> {
  if (!(similarityThreshold > 0 && similarityThreshold <= 1)) {
    throw new Error('similarity_threshold must be between 0 and 1');
  }

  const eligible: EligibleRecord[] = [];
  const needsEvidence: { defectId: string; name: string; reason: string }[] = [];
  const seenIds = new Set<string>();

  for (const [sourceIndex, source] of defects.entries()) {
    const defectId = String(source['defect_id'] ?? source['defectId'] ?? '').trim().replace(/^[Dd]-?/, '').trim();
    const name = cleanText(source['name']);
    if (!defectId || !/^\d+$/.test(defectId)) {
      needsEvidence.push({ defectId: '', name, reason: 'invalid_defect_id' });
      continue;
    }
    if (seenIds.has(defectId)) continue;
    seenIds.add(defectId);

    const { text, reproductionEvidence, descriptionPreview } = evidenceText(source);
    if (reproductionEvidence.length < MIN_REPRODUCTION_EVIDENCE_CHARS) {
      needsEvidence.push({ defectId: defectId, name, reason: 'missing_reproduction_evidence' });
      continue;
    }

    eligible.push({
      defect_id: defectId,
      name,
      project: displayValue(source['project']),
      assigned_ecu: displayValue(source['assigned_ecu']),
      lead_model: displayValue(source['lead_model']),
      software_version: displayValue(source['software_version']),
      detected_in_release: displayValue(source['detected_in_release']),
      evidence_text: text,
      description_preview: descriptionPreview,
      functional_anchors: functionalAnchorTokens(source),
      source_index: sourceIndex,
    });
  }

  const patterns: DefectPattern[] = [];

  if (eligible.length > 0) {
    const rawEmbeddings = await embed(eligible.map((r) => r.evidence_text));
    const embeddings = normalizeEmbeddings(rawEmbeddings, eligible.length);

    const buckets = new Map<string, number[]>();
    for (let i = 0; i < eligible.length; i++) {
      const key = contextKey(eligible[i]!);
      const keyStr = `${key.project}|${key.ecu}|${key.model}`;
      const arr = buckets.get(keyStr) ?? [];
      arr.push(i);
      buckets.set(keyStr, arr);
    }

    for (const [keyStr, indices] of buckets) {
      const [proj, ecu, model] = keyStr.split('|');
      const ctxKey: ContextKey = { project: proj!, ecu: ecu!, model: model! };
      const manualReview = requiresManualReview(ctxKey);
      const bucketThreshold = Math.min(1.0, similarityThreshold + (manualReview ? UNKNOWN_CONTEXT_THRESHOLD_INCREMENT : 0));

      for (const memberIndices of clusterBucket(eligible, embeddings, indices, bucketThreshold)) {
        const repIdx = memberIndices[0]!;
        const representative = eligible[repIdx]!;
        const members = memberIndices.map((i) => eligible[i]!);
        const repEmb = embeddings[repIdx]!;
        const similarities = memberIndices.map((i) => cosineSimilarity(repEmb, embeddings[i]!));
        const memberIds = members.map((m) => m.defect_id);
        const commonAnchorTerms = members.length > 0
          ? Array.from(members.reduce((acc, m) => new Set([...acc].filter((t) => m.functional_anchors.has(t))), members[0]!.functional_anchors)).sort()
          : [];

        patterns.push({
          patternId: patternId(ctxKey, memberIds),
          confidence: Math.round((similarities.reduce((a, b) => a + b, 0) / similarities.length) * 1000) / 1000,
          requiresManualReview: manualReview || members.length > MAX_AUTOMATIC_PATTERN_MEMBERS || !members.every((m) => m.functional_anchors.size > 0),
          context: {
            project: displayValue(representative.project),
            assignedEcu: displayValue(representative.assigned_ecu),
            leadModel: displayValue(representative.lead_model),
          },
          representative: memberPayload(representative, 1.0),
          members: members.map((m, i) => memberPayload(m, similarities[i]!)),
          parameterMatrix: {
            softwareVersions: uniqueValues(members, 'software_version'),
            detectedInReleases: uniqueValues(members, 'detected_in_release'),
          },
          commonAnchorTerms,
          evidencePreview: representative.description_preview,
        });
      }
    }
  }

  patterns.sort((a, b) => b.members.length - a.members.length || a.representative.defectId.localeCompare(b.representative.defectId));
  const singletonCount = patterns.filter((p) => p.members.length === 1).length;
  const eligibleCount = eligible.length;

  return {
    similarityThreshold,
    patterns,
    needsEvidence,
    summary: {
      source_count: defects.length,
      eligible_count: eligibleCount,
      needs_evidence_count: needsEvidence.length,
      pattern_count: patterns.length,
      clustered_member_count: patterns.reduce((sum, p) => sum + p.members.length, 0),
      singleton_pattern_count: singletonCount,
      estimated_llm_generations_avoided: Math.max(eligibleCount - patterns.length, 0),
    },
  };
}
