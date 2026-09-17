---
name: create-octane-testcase
description: Generate a complete, structured test case (test_manual) in ALM Octane from a defect or ticket — read the defect, build a standard description + plain-text steps, create the test in Octane linked to a feature, and write the steps to the test's script resource. Use this whenever the user wants to create/write/generate/draft a test case from a defect or ticket, convert a bug into a test, "写测试用例", "创建testcase", "从缺陷生成测试", "把这个ticket转成测试用例", or regenerate test coverage from existing defects — even if they don't explicitly say "test case" but describe wanting to turn a defect's reproduction into a verifiable test.
metadata:
  version: 1.0.0
---

# Create Octane Test Case from a Defect

Turn an Octane defect's reproduction information into a rigorous, standardized `test_manual` test case — with a concise description, structured plain-text steps, and a link to its parent feature — following the same conventions as the hand-written test cases already in the workspace.

The repo is `C:\Users\q446328\Desktop\LibreChat`. This skill uses the `vizion-testcase` MCP server (plugin/vizion-testcase) which exposes tools for defect reading, RAG retrieval, verification, Octane writing, and pattern discovery. Octane workspace is **1002 / 2001** (shared space / workspace), team DTSV_China.

## The two halves of this skill

This skill splits cleanly into two halves, and that split matters:

1. **Generate content (offline, no Octane write).** Read the defect, produce a structured `description` (HTML overview) and a `steps` script (plain text). This half needs no Octane write permission and is safe to run, inspect, and iterate on. Treat it as a draft you show the user before anything is created.

2. **Write to Octane (real production write).** Create the `test_manual` entity + write its steps + link it to a feature. This touches production Octane, creates a real entity, and needs a privileged cookie. Always confirm with the user and show the preview before committing.

Keep this split. The content generation is where most of the quality lives; the write is a mechanical, confirmable last step.

## Workspace conventions (learned the hard way — these are NOT guesses)

These rules were empirically verified against production workspace 1002/2001 by creating real test cases. Violating any of them produces a 400/409 from Octane. Follow them exactly.

- **`test_manual` creation goes to `POST /tests`** with body `{"data":[{"type":"test","subtype":"test_manual",...}]}` + header `{"XSRF-HEADER": <XSRF_COOKIE value>}`. The `type` for the `/tests` collection is `"test"` (NOT `"work_item"`).
- **Reference fields need `type` + `id`, never `name`** when writing:
  - `phase`: by logical id, e.g. `{"type":"phase","id":"phase.test_manual.new"}`. The name `"New"` is ambiguous (shared across epic/feature/test phases) and will be rejected.
  - `owner`: workspace_user by id, e.g. `{"type":"workspace_user","id":"500026"}`. It is a **required** field for `test_manual` and does NOT default to the authenticated user — you must supply it.
  - `covered_content` (the feature link): `{"data":[{"type":"work_item","id":"<feature_id>"}]}`.
- **`servicepack_udf` is mandatory** ("Servicepack EE-System" UDF). Use list_node id `d1598r3mjrp37by4yjvy1860k` (SP2021) unless you have reason to pick another. Verify valid values via `GET /tests?fields=id,name,servicepack_udf` and sampling.
- **Test has NO `release` field** — sending one returns 400.
- **Test steps are NOT a field on the test entity** and there is NO `/test_steps` collection. Steps live in a **sub-resource** at `GET/PUT /tests/{id}/script`. The body for PUT is the bare object `{"script": "<text>"}` (do NOT wrap in `{"data":[...]}`).
- **Steps format is plain text**, one step per line, with kind prefixes (verified against hand-written test 1414874):
  - `- [PreCon] <text>` — precondition
  - `- <text>` — action step
  - `- ? <text>` — checkpoint / expected result
- **`description` holds the overview only** (objective, reference, preconditions summary, pass/fail criteria) — NOT the procedure steps. The procedure goes in the `script` sub-resource. Many hand-written cases (e.g. 1414874) leave `description` empty and put everything in the script; richer cases (e.g. 152393) keep a short overview in description. Either is valid; do not duplicate the procedure in both places.

## Permissions (a real constraint)

The default identity `q446328` lacks `create` AND `update` permission on `test_manual` (403). Writes only succeed with a **privileged account's cookie** (e.g. a workspace admin / role with test_manual create). Before the write step, verify the cookie is valid and belongs to a privileged account — `GET /tests?fields=id&limit=1` returning 200 confirms read, but you need create permission for the actual write. If you get 403, tell the user to load a privileged cookie and stop.

## The MCP tools you should use (vizion-testcase plugin)

Do not hand-roll HTTP. The `vizion-testcase` MCP server (at `plugin/vizion-testcase/`) exposes tools that encode every convention above:

**`read_defect`** — read a defect by ID (local SQLite first, fallback to Octane API). Returns `{defect_id, name, severity, software_version, assigned_ecu, lead_model, project, phase, description}`.

**`prepare_testcase`** — read defect + RAG retrieve similar test cases + return few-shot context. Returns `{defect_info, similar_cases[], few_shot_text}`.

**`verify_testcase`** — run 5 quality checks (failure-mode coverage, step reproducibility, format compliance, checkpoint quantification, defect traceability). Returns `{passed, criteria[], feedback}`. If any check fails, `feedback` contains specific regeneration guidance.

**`commit_testcase`** — create `test_manual` in Octane + write steps to `/tests/{id}/script`. ⚠️ Production write — always confirm with the user first. Returns `{test_id, octane_url}`.

**`export_csv`** — write generated drafts to a CSV file under `exports/testcases/` (no Octane write). Safe offline-review path. Legacy — prefer `export_xlsx` for professional styled output.

**`export_xlsx`** — write generated drafts to a professional styled Excel (.xlsx) file under `exports/` (no Octane write). Outputs the same data as `export_csv` but with IDCEVO-style formatting: dark-blue header with white bold text, severity row highlights (High=gold / Medium=light-yellow / Low=grey), frozen header row, auto-filter, auto column widths, and a Data Dictionary sheet. Use this instead of `export_csv` when the user wants an Excel deliverable.

**`search_defects`** — semantic search over defect embeddings (hybrid dense + TF-IDF + RRF). Returns top-K candidates.

**`filter_defects`** — topic filter: exact match by project/name, excluding defects with linked test cases. Returns all matches (paginated).

**`generate_from_description`** — generate a test case draft template from a description (no defect ID needed).

**`discover_patterns`** — cluster unlinked defects into reusable patterns via embedding similarity + anchor compatibility.

**`audit_pattern_coverage`** — audit existing test case coverage for discovered patterns.

**`prepare_pattern_drafts`** — prepare RAG context for selected patterns' representative defects.

**`export_pattern_drafts`** — export pattern drafts to CSV (no Octane write).

The RAG retrieval uses Beacon embedding API (`qwen3-embedding-8b`) with local SQLite caching. The defect database is `qgate_raw.db` (read-only, configured via `DEFECT_DB_PATH` env var).

## Batch creation & semantic search

The skill supports three input modes via the `/创建测试用例` slash command:

### A. Single defect (existing flow)

`/创建测试用例 2804379` — one defect → one test case. Uses `POST /api/create-testcase` (single). See the full Procedure below.

### B. Multiple defects (batch flow)

`/创建测试用例 2743423, 2812109, 2783932` — N defects → N test cases.

1. **`POST /api/create-testcase/prepare-batch`** with `{ defect_ids: [...], intent: "..." }` — the server runs the full pipeline (prepare → LLM generate → verify) for each defect concurrently (limit 3), returns `results[]` with per-item success/error. Each result is a complete draft (name, descriptionHtml, stepsText, verification, similarCases).
2. The frontend renders these in `TestCaseBatchPreview` — a list of collapsible cards where the user can:
   - Toggle selection (checkbox per item)
   - Edit name / description / steps inline
   - Re-verify individual items
   - Set a shared Feature ID
3. On confirm, **`POST /api/create-testcase/commit-batch`** with `{ items: [...], owner_workspace_user_id }` — commits serially (each item = create test + write steps), single failure does not block others. Returns per-item `{ defectId, success, test_id, octane_url, error }`.

### C. Semantic search (no defect id)

`/创建测试用例 基于历史的RSU的缺陷` — no numeric id in the message.

1. **`POST /api/create-testcase/search`** with `{ query: "基于历史的RSU的缺陷", top_k: 10 }` — reuses the `duplicate_search_bridge` index (16K+ defect embeddings) to find matching defects. Returns `candidates[]` with `{ defectId, name, project, statusPhase, similarity, snippet }`.
2. The frontend renders these in `DefectCandidateList` — the user picks a subset (checkboxes), then clicks "生成测试用例".
3. The selected subset enters the batch flow (B above) via `prepare-batch`.

**Note**: Semantic search returns a **similarity top-K** (default 10, max 30) — it finds the *most similar* defects to the query text, NOT all defects matching a topic. For "all RSU-related defects" use mode D below.

### D. Topic filter — all defects for a topic, skipping those with linked test cases

`/创建测试用例 RSU` or `/创建测试用例 RSU相关的所有缺陷` — a topic keyword without numeric ids, where the intent is "all defects for this topic, not just the most similar ones".

This is distinct from C (semantic search): C ranks by similarity and returns top-K; **D is an exact filter that returns ALL matching defects** (paginated), and **automatically excludes defects that already have a linked test case** (no need to generate coverage that already exists).

1. **`POST /api/create-testcase/filter-defects`** with `{ keyword: "RSU", limit: 50, offset: 0 }` — queries the local SQLite (`octane_defects` table) where `project = 'RSU' OR name LIKE '%RSU%'` (case-insensitive). Excludes any defect id appearing in the `defect_ids_json` of `octane_testcases` ∪ `octane_traceability_testcases` (the "linked test case" set, ~2,635 ids). Returns `{ success, keyword, total, offset, limit, candidates[], summary: { matched_total, linked_excluded, without_linked_testcase } }`.
2. The frontend renders these in `DefectCandidateList` (filter mode) — shows "共 {total} 个 · 已加载 {loaded} · 已选 {selected}", with a "加载更多" button to page through all results (50 per page).
3. The user selects a subset. Two actions:
   - **生成测试用例** — enters the batch flow (B above) via `prepare-batch` (max 20 per batch; the frontend auto-slices if the selection exceeds 20).
   - **导出 CSV** — generates drafts in batches of 20, then **`POST /api/create-testcase/export-csv`** with `{ keyword, drafts[] }` — writes all drafts to a CSV file under `exports/testcases/` (e.g. `RSU_testcases_1.csv`). **No Octane write** — this is the safe offline-review path. **For professional Excel output**, use `export_xlsx` / `commit_staged_drafts` MCP tools instead — they produce styled `.xlsx` files with header formatting, severity highlights, frozen rows, auto-filter, and a data dictionary sheet. The CSV/Excel columns: defect_id, defect_name, defect_severity, software_version, assigned_ecu, lead_model, project, phase, test_name, description_html, steps_text, verification_passed, verification_feedback, similar_cases, generated_at, error.

**When to use C vs D**:
- "Find defects similar to X" / "哪些缺陷跟这个问题最像" → **C** (semantic similarity top-K)
- "All defects for topic X" / "RSU 所有缺陷" → **D** (exact filter, all matches, skip linked)

### E. Direct generation from description (no defect)

`/创建测试用例 蓝牙连接断开后的重连测试` — the user describes a test scenario directly, without referencing any existing defect or topic.

1. **`POST /api/create-testcase/generate-from-description`** with `{ description: "蓝牙连接断开后的重连测试" }` — generates a test case draft directly from the description, using the LLM to build the description HTML + steps, with RAG-retrieved similar cases for style reference. No defect lookup, no Octane defect needed.
2. The frontend renders the result in `TestCaseBatchPreview` (same as batch flow B), where the user can review, edit, and commit or export to CSV.

### Intent routing (LLM-driven)

When the user types `/创建测试用例 <natural language>` without numeric IDs, the system uses **`POST /api/create-testcase/analyze-intent`** — an LLM call (`analyzeTestcaseIntent`) that reads the natural-language input and returns:

- `{ mode: "filter_defects", keyword: "RSU" }` — the user wants all existing defects for a topic → mode D
- `{ mode: "direct_generate", description: "蓝牙连接断开后的重连测试" }` — the user describes a test scenario → mode E

The LLM understands semantic intent, not just keyword extraction — it correctly routes "基于历史的RSU的缺陷创建测试用例" → filter_defects (keyword=RSU), and "测试蓝牙重连" → direct_generate. This replaces brittle regex-based keyword parsing.

### When to use which

- User gives one or more numeric ids → A (single) or B (batch, ≥2 ids)
- User gives natural language without ids → **LLM analyzes intent** → routes to D (topic filter) or E (direct generation) or C (semantic search)
- The slash command parser: extracts ALL `\b(?:D|DEF-)?\d{4,}\b` matches; ≥2 unique → batch, 1 → single, 0 → **LLM intent analysis** decides D/E.

## Procedure

### 1. Read the defect

Given a defect id, read its details using the `read_defect` MCP tool (tries local SQLite first, falls back to Octane API):

```
read_defect(defect_id: "2804379")
```

Returns `{defect_id, name, severity, software_version, assigned_ecu, lead_model, project, phase, description}`. The description is already HTML — Octane's format.

### 2. Retrieve similar test cases (RAG) + generate the content

This is the agentic RAG pipeline. Two sub-steps: retrieve, then generate.

**2a. RAG retrieval** — find similar existing test cases to use as few-shot style/structure reference:

```
prepare_testcase(defect_id: "2804379")
```

Returns `{defect_info, similar_cases[], few_shot_text}`. The `few_shot_text` contains formatted examples of similar test cases. Use them as a **style reference** when generating, but generate content specific to the source defect. The retrieval is hybrid (dense embedding + TF-IDF keyword + RRF fusion), so it catches both semantic similarity and exact-keyword matches (ECU names, project codes).

**2b. Generate** — from the defect's reproduction information + the few-shot context, derive a test case. The goal is a **regression test** that verifies the defect's failure mode is fixed/prevented. Extract:

- **Preconditions**: what must be true before the test (vehicle/software/tools, baseline data, referenced traces).
- **Steps**: the reproduction + verification actions, in order. The defect's own description usually has the reproduction — translate it into clean, numbered action steps.
- **Checkpoints** (`?` lines): the expected results / pass thresholds. If the defect has quantitative data (e.g. CPU load values, timing thresholds), put the acceptable thresholds here and the baseline/regression values in a comparison table in the description.
- **Pass/fail criteria**: explicit verdict rules.

Then render the content (the agent constructs these based on the defect + few-shot context):
- `description_html` — a concise HTML overview (Objective, Reference, Preconditions, Procedure, Expected, Pass/Fail). Use the convention from the `builder.ts` module: `<html><body>` block with `<b>Section:</b>` headers. Do NOT dump the full procedure here if it's in the steps.
- `steps_text` — plain-text steps in the `[PreCon]` / action / `?` format: `- [PreCon] <text>`, `- <text>`, `- ? <text>`. This goes into the `script` sub-resource.

### 2c. Self-verify (LLM-as-judge)

Before showing the user, run the verification check. This filters low-quality output and catches common issues (missing preconditions, vague checkpoints, format violations):

```
verify_testcase(defect_info: {defect_id: "2804379", name: "..."}, description_html: "...", steps_text: "...")
```

Returns `{passed, criteria[], feedback, pass_count, total_count}`. If any check fails, the `feedback` field tells you exactly what to fix. The verifier checks 5 criteria: failure-mode coverage (steps reference the defect's key terms), step reproducibility (≥3 action steps), format compliance (`[PreCon]`/action/`?`), checkpoint quantification (specific values/thresholds), defect traceability (description references the defect ID).

**Show the user the generated `description` and `steps_text` (with verification result) and get confirmation before proceeding to the write.** This is the review gate.

### 3. Resolve the write-time values

Before creating, you need three values the defect doesn't give you:

- **`owner_workspace_user_id`**: the id of the current authenticated Octane user (the test case's owner). There is no direct "current user" REST endpoint. Resolve it by creating a throwaway work item (e.g. a feature) and reading its `author` field, or use a known id if the user told you. Do NOT guess.
- **`servicepack_node_id`**: default `d1598r3mjrp37by4yjvy1860k` (SP2021) unless the defect's software implies another servicepack.
- **`covered_work_item_ids`**: the feature id to link the test under. Ask the user which feature, or infer from the defect's epic/feature path. The test will appear under this feature's Tests/Coverage tab.

### 4. Write to Octane (confirm first — real production entity)

```
commit_testcase(
  name: "[<project>][<sw>] Regression - <short summary> (D<defect_id>)",
  description_html: description,
  steps_text: steps_text,
  owner_workspace_user_id: owner_id,
  feature_id: feature_id,
  servicepack_node_id: "d1598r3mjrp37by4yjvy1860k"
)
```

Returns `{success, test_id, octane_url}`.

### 5. Verify & report

- The `commit_testcase` tool creates the test + writes steps in one call.
- Verify `covered_content` links the feature: check via Octane UI at the returned `octane_url`.
- Report the Octane UI link: `https://octane-prod.bmwgroup.net/ui/?p=1002/2001#/entity-navigation?entityType=work_item&id=<test_id>`.

## Naming convention

Follow the workspace's existing test naming: `[<project>][<sw-or-release>] <short description> (D<defect_id>)`. Keep it concise and searchable. Example: `[IDCEVO][PU2707] Regression - pps CPU load stable when car is moving (D2804379)`.

## When the defect has no reproduction / is not a regression

This skill assumes a defect with reproduction information that becomes a regression test. If the defect is a feature request, a flaky issue, or lacks repro steps, tell the user — the generated test case quality depends entirely on the defect's content. Offer to draft a best-effort test and flag the gaps rather than fabricate steps.

## Octane UI link format

`https://octane-prod.bmwgroup.net/ui/?p=1002/2001#/entity-navigation?entityType=work_item&id=<id>` — works for tests, features, epics, defects (all are `work_item` navigation entities).
