/** 共享类型定义 — vizion-testcase MCP server 全模块复用。 */

/** Octane 缺陷记录（从本地 SQLite 读取的投影）。 */
export interface DefectRecord {
  defect_id: string;
  name: string;
  severity: string;
  software_version: string;
  assigned_ecu: string;
  lead_model: string;
  project: string;
  phase: string;
  description: string;
}

/** RAG 检索返回的相似测试用例。 */
export interface SimilarTestCase {
  test_id: string;
  name: string;
  score: number;
  team: string;
  release: string;
  subtype: string;
}

/** RAG 检索返回的相似缺陷。 */
export interface SimilarDefect {
  defect_id: string;
  name: string;
  score: number;
  project: string;
  tproject: string;
  problem_severity: string;
  team: string;
}

/** 测试用例质检单条检查结果。 */
export interface VerificationCriterion {
  name: string;
  passed: boolean;
  evidence: string;
}

/** 测试用例质检完整结果。 */
export interface VerificationResult {
  passed: boolean;
  criteria: VerificationCriterion[];
  feedback: string;
  pass_count: number;
  total_count: number;
}

/** 生成的测试用例草稿。 */
export interface TestCaseDraft {
  defectId: string;
  defectName: string;
  defectSeverity: string;
  defectSoftwareVersion: string;
  defectAssignedEcu: string;
  defectLeadModel: string;
  project: string;
  phase: string;
  name: string;
  descriptionHtml: string;
  stepsText: string;
  verification: {
    passed: boolean;
    criteria: VerificationCriterion[];
    feedback: string;
  };
  similarCases: { testId: string; name: string; score: number }[];
  generatedAt: string;
  error?: string;
}

/** Pattern discovery 中的一个缺陷成员。 */
export interface PatternMember {
  defectId: string;
  name: string;
  project: string | null;
  assignedEcu: string | null;
  leadModel: string | null;
  softwareVersion: string | null;
  detectedInRelease: string | null;
  similarityToRepresentative: number;
}

/** Pattern discovery 结果中的一个 pattern。 */
export interface DefectPattern {
  patternId: string;
  confidence: number;
  requiresManualReview: boolean;
  context: {
    project: string | null;
    assignedEcu: string | null;
    leadModel: string | null;
  };
  representative: PatternMember;
  members: PatternMember[];
  parameterMatrix: {
    softwareVersions: string[];
    detectedInReleases: string[];
  };
  commonAnchorTerms: string[];
  evidencePreview: string;
}

/** Pattern discovery 完整结果。 */
export interface PatternDiscoveryResult {
  similarityThreshold: number;
  patterns: DefectPattern[];
  needsEvidence: { defectId: string; name: string; reason: string }[];
  summary: {
    source_count: number;
    eligible_count: number;
    needs_evidence_count: number;
    pattern_count: number;
    clustered_member_count: number;
    singleton_pattern_count: number;
    estimated_llm_generations_avoided: number;
  };
}
