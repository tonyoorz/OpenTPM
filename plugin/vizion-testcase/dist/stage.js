"use strict";
/**
 * 测试用例草稿暂存区 — 进程内 Map 存储。
 *
 * 解决 LLM 批量生成测试用例时 output token 截断问题：
 * LLM 每生成一条用例就调用 stageDraft 暂存，最后由 commitStagedDrafts
 * 统一组装 CSV，避免一次性输出全量数据。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSV_COLUMNS = void 0;
exports.stageDraft = stageDraft;
exports.stageDraftBatch = stageDraftBatch;
exports.getStagedDrafts = getStagedDrafts;
exports.clearStagedDrafts = clearStagedDrafts;
exports.getStagedCount = getStagedCount;
const CSV_COLUMNS = [
    'test_id', 'name', 'description', 'severity', 'software_version',
    'assigned_ecu', 'lead_model', 'preconditions', 'procedure_steps',
    'expected_result', 'pass_criteria', 'fail_criteria',
];
exports.CSV_COLUMNS = CSV_COLUMNS;
const store = new Map();
function stageDraft(draft) {
    store.set(draft.draft_id, draft);
    return { stagedCount: store.size, draftId: draft.draft_id };
}
function stageDraftBatch(drafts) {
    for (const draft of drafts) {
        store.set(draft.draft_id, draft);
    }
    return { stagedCount: store.size, addedCount: drafts.length };
}
function getStagedDrafts() {
    return Array.from(store.values());
}
function clearStagedDrafts() {
    store.clear();
}
function getStagedCount() {
    return store.size;
}
