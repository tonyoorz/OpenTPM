# Vizion Testcase

## Analysis workbook import

The importer creates and writes to two PostgreSQL tables:

- `defect_analysis.workbook_rows` preserves every Excel row as JSONB together with its file name, sheet name, row number, original ticket ID, and normalized ticket ID.
- `defect_analysis.ticket_analyses` provides one queryable row per normalized ticket ID. It includes ticket ID, description, LLM summary, function, ECU, software version, project, risk level and score, QGate severity, closure disposition, closure reason, and the complete source row as JSONB.

Re-running the same import updates the existing source row. Non-empty fields from later rows enrich the normalized ticket record without replacing existing values with blanks.

Set `PG_CONNECTION_STRING` before importing. The target role needs permission to create the `defect_analysis` schema and its table and index.

```powershell
$env:PG_CONNECTION_STRING = 'postgresql://user:password@host:5432/database'
Set-Location plugin/vizion-testcase
npm run build
npm run import-analysis -- ticket 'C:\path\to\ticket-source.xlsx'
npm run import-analysis -- llm_analysis 'C:\path\to\llm-analysis.xlsx'
```

Use the source kind to describe the workbook content, not its filename. A sheet containing mixed source and LLM columns can be imported as `llm_analysis`; all columns remain available in the JSONB `data` value.

For the current analysis files, import `Full 09 analysis.xlsx` as `ticket` and `Phase06full.xlsx` as `llm_analysis`. Their normalized ticket ID sets do not overlap, so they remain independently traceable source batches.