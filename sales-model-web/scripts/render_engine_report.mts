// Headless run of the engine Excel exporter. Loads default JSON inputs,
// evaluates the sales model, renders the ReportDef, writes the workbook to
// disk. Use to A/B against the legacy exporter without going through the UI.
//
// Usage:  npx tsx scripts/render_engine_report.mts [--out path.xlsx]

import { writeFileSync } from 'node:fs';
import { argv } from 'node:process';
import ExcelJS from 'exceljs';

import { loadInitialInput } from '../src/data.js';
import { salesModel } from '../src/models/salesModel.js';
import { evaluateSalesModel } from '../src/models/evaluateSalesModel.js';
import { renderReportToWorkbook } from '../src/report/excelRenderer.js';
import { salesReport } from '../src/report/salesReport.js';

const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : 'engine-report.xlsx';

const input = loadInitialInput();
const evalResult = evaluateSalesModel(input);

const wb = new ExcelJS.Workbook();
wb.creator = 'engine renderer (cli)';
renderReportToWorkbook(wb, salesModel, evalResult, salesReport);

const buf = await wb.xlsx.writeBuffer();
writeFileSync(outPath, Buffer.from(buf as ArrayBuffer));
console.log(`Wrote ${outPath} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
