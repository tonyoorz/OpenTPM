import { resolve } from 'node:path';
import { importAnalysisWorkbook } from './import.js';
import type { AnalysisSourceKind } from './import.js';

function sourceKind(value: string | undefined): AnalysisSourceKind {
  if (value === 'ticket' || value === 'llm_analysis') return value;
  throw new Error('Usage: npm run import-analysis -- <ticket|llm_analysis> <workbook.xlsx>');
}

async function main(): Promise<void> {
  const [kind, filePath] = process.argv.slice(2);
  if (!filePath) throw new Error('Usage: npm run import-analysis -- <ticket|llm_analysis> <workbook.xlsx>');
  const result = await importAnalysisWorkbook(resolve(filePath), sourceKind(kind));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});