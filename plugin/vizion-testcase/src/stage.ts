/**
 * 测试用例草稿暂存区 — 进程内 Map 存储。
 *
 * 解决 LLM 批量生成测试用例时 output token 截断问题：
 * LLM 每生成一条用例就调用 stageDraft 暂存，最后由 commitStagedDrafts
 * 统一组装 CSV，避免一次性输出全量数据。
 */

const CSV_COLUMNS = [
  'test_id', 'name', 'description', 'severity', 'software_version',
  'assigned_ecu', 'lead_model', 'preconditions', 'procedure_steps',
  'expected_result', 'pass_criteria', 'fail_criteria',
] as const;

const store = new Map<string, StagedDraft>();

export interface StagedDraft {
  draft_id: string;
  name: string;
  description: string;
  severity: string;
  software_version: string;
  assigned_ecu: string;
  lead_model: string;
  preconditions: string;
  procedure_steps: string;
  expected_result: string;
  pass_criteria: string;
  fail_criteria: string;
}

export function stageDraft(draft: StagedDraft): { stagedCount: number; draftId: string } {
  store.set(draft.draft_id, draft);
  return { stagedCount: store.size, draftId: draft.draft_id };
}

export function stageDraftBatch(drafts: StagedDraft[]): { stagedCount: number; addedCount: number } {
  for (const draft of drafts) {
    store.set(draft.draft_id, draft);
  }
  return { stagedCount: store.size, addedCount: drafts.length };
}

export function getStagedDrafts(): StagedDraft[] {
  return Array.from(store.values());
}

export function clearStagedDrafts(): void {
  store.clear();
}

export function getStagedCount(): number {
  return store.size;
}

export { CSV_COLUMNS };
