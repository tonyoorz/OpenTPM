const {
  stageDraft,
  getStagedDrafts,
  clearStagedDrafts,
  getStagedCount,
  CSV_COLUMNS,
} = require('../dist/stage.js');
const { draftsToCsv } = require('../dist/csv.js');

function makeDraft(overrides = {}) {
  return {
    draft_id: 'TC-001',
    name: 'Test case 1',
    description: 'Description 1',
    severity: 'High',
    software_version: 'HU_3.5.2',
    assigned_ecu: 'HU-Entertainment',
    lead_model: 'G38',
    preconditions: 'Vehicle stationary',
    procedure_steps: 'Step 1|Step 2|Step 3',
    expected_result: 'Expected result',
    pass_criteria: 'All steps pass',
    fail_criteria: 'Any step fails',
    ...overrides,
  };
}

describe('stageDraft', () => {
  beforeEach(() => clearStagedDrafts());

  test('stages a draft and returns count', () => {
    const result = stageDraft(makeDraft());
    expect(result.draftId).toBe('TC-001');
    expect(result.stagedCount).toBe(1);
  });

  test('stages multiple drafts with incrementing count', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001' }));
    const result = stageDraft(makeDraft({ draft_id: 'TC-002', name: 'Test case 2' }));
    expect(result.stagedCount).toBe(2);
    expect(getStagedCount()).toBe(2);
  });

  test('overwrites draft with same draft_id', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001', name: 'Original' }));
    stageDraft(makeDraft({ draft_id: 'TC-001', name: 'Updated' }));
    const drafts = getStagedDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].name).toBe('Updated');
  });
});

describe('getStagedDrafts', () => {
  beforeEach(() => clearStagedDrafts());

  test('returns empty array when nothing staged', () => {
    expect(getStagedDrafts()).toEqual([]);
  });

  test('returns all staged drafts in insertion order', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001' }));
    stageDraft(makeDraft({ draft_id: 'TC-002' }));
    stageDraft(makeDraft({ draft_id: 'TC-003' }));
    const drafts = getStagedDrafts();
    expect(drafts).toHaveLength(3);
    expect(drafts[0].draft_id).toBe('TC-001');
    expect(drafts[2].draft_id).toBe('TC-003');
  });
});

describe('clearStagedDrafts', () => {
  beforeEach(() => clearStagedDrafts());

  test('clears all staged drafts', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001' }));
    stageDraft(makeDraft({ draft_id: 'TC-002' }));
    expect(getStagedCount()).toBe(2);
    clearStagedDrafts();
    expect(getStagedCount()).toBe(0);
    expect(getStagedDrafts()).toEqual([]);
  });
});

describe('CSV_COLUMNS', () => {
  test('contains expected test case columns', () => {
    expect(CSV_COLUMNS).toContain('test_id');
    expect(CSV_COLUMNS).toContain('name');
    expect(CSV_COLUMNS).toContain('description');
    expect(CSV_COLUMNS).toContain('procedure_steps');
    expect(CSV_COLUMNS).toContain('expected_result');
    expect(CSV_COLUMNS).toContain('pass_criteria');
    expect(CSV_COLUMNS).toContain('fail_criteria');
  });

  test('has 12 columns', () => {
    expect(CSV_COLUMNS).toHaveLength(12);
  });
});

describe('draftsToCsv', () => {
  beforeEach(() => clearStagedDrafts());

  test('converts staged drafts to CSV with header', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001' }));
    stageDraft(makeDraft({ draft_id: 'TC-002', name: 'Test case 2' }));
    const drafts = getStagedDrafts();
    const csv = draftsToCsv(drafts);
    const lines = csv.split('\r\n');
    expect(lines[0]).toContain('test_id');
    expect(lines[0]).toContain('name');
    expect(lines[0]).toContain('procedure_steps');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('TC-001');
    expect(lines[2]).toContain('TC-002');
  });

  test('maps draft_id to test_id column', () => {
    stageDraft(makeDraft({ draft_id: 'TC-RT-AI-001' }));
    const csv = draftsToCsv(getStagedDrafts());
    expect(csv).toContain('TC-RT-AI-001');
  });

  test('handles empty drafts array', () => {
    const csv = draftsToCsv([]);
    expect(csv).toContain('test_id');
    expect(csv.split('\r\n')).toHaveLength(1);
  });

  test('escapes commas in field values', () => {
    stageDraft(makeDraft({ draft_id: 'TC-001', preconditions: 'Vehicle running, engine on' }));
    const csv = draftsToCsv(getStagedDrafts());
    expect(csv).toContain('"Vehicle running, engine on"');
  });
});
