// Walk the salesReport and report what each block would produce in the React
// renderer — number of groups, number of rows in each grid. Lets us verify
// the consolidated block becomes one grid without spinning up a browser.

import { loadInitialInput } from '../src/data.js';
import { evaluateSalesModel } from '../src/models/evaluateSalesModel.js';
import { salesReport } from '../src/report/salesReport.js';
import type { ReportBlock, TableBlock } from '../src/report/types.js';
import type { Row } from '../src/engine';

const evalResult = evaluateSalesModel(loadInitialInput());

function applyFilter(rows: Row[], filter?: TableBlock['filter']): Row[] {
  if (!filter) return rows;
  return rows.filter((r) =>
    Object.entries(filter).every(([k, v]) =>
      Array.isArray(v) ? (v as Array<string | number>).includes(r[k] as string | number) : r[k] === v,
    ),
  );
}

function describeBlock(block: ReportBlock, sectionId: string): void {
  if (block.kind !== 'table') {
    console.log(`  [${block.kind}] ${block.kind === 'title' ? block.text : ''}`);
    return;
  }
  const t = evalResult.tables[block.source];
  if (!t) { console.log(`  [table] ${block.source} — MISSING`); return; }
  const filtered = applyFilter(t.rows, block.filter);
  // groups
  let groups: number;
  if (block.groupBy) {
    const keys = new Set<string>();
    for (const r of filtered) keys.add(block.groupBy.keys.map((k) => String(r[k])).join('\x1f'));
    groups = keys.size;
  } else {
    groups = 1;
  }
  // rows per grid
  let rowsPerGrid = 0;
  if (block.rows.kind === 'pivot-rows') {
    const labels = new Set<string | number>();
    for (const r of filtered) labels.add(r[block.rows.labelCol] as string | number);
    rowsPerGrid = labels.size + (block.totalsRow ? 1 : 0);
  } else if (block.rows.kind === 'value-columns') {
    rowsPerGrid = block.rows.rows.length + (block.totalsRow ? 1 : 0);
  } else if (block.rows.kind === 'explicit') {
    rowsPerGrid = block.rows.rows.length;
  } else {
    rowsPerGrid = filtered.length;
  }
  const title = block.title ? ` "${block.title}"` : '';
  console.log(`  [table${title}] source=${block.source}  → ${groups} grid${groups === 1 ? '' : 's'}, ${rowsPerGrid} row${rowsPerGrid === 1 ? '' : 's'} each`);
}

for (const section of salesReport.sections) {
  if (section.id !== 'revenue-model') continue;
  console.log(`\n=== ${section.label} (${section.id}) ===`);
  for (const block of section.blocks) describeBlock(block, section.id);
}
