"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = require("node:path");
const import_js_1 = require("./import.js");
function sourceKind(value) {
    if (value === 'ticket' || value === 'llm_analysis')
        return value;
    throw new Error('Usage: npm run import-analysis -- <ticket|llm_analysis> <workbook.xlsx>');
}
async function main() {
    const [kind, filePath] = process.argv.slice(2);
    if (!filePath)
        throw new Error('Usage: npm run import-analysis -- <ticket|llm_analysis> <workbook.xlsx>');
    const result = await (0, import_js_1.importAnalysisWorkbook)((0, node_path_1.resolve)(filePath), sourceKind(kind));
    console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
