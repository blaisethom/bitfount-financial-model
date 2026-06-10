// Summary stats derived from an engine eval result — used by App.tsx's header
// and view-tab subtitles.

import type { EvalResult, Row } from '../engine';

function sumCol(rows: Row[] | undefined, col: string): number {
  if (!rows) return 0;
  let s = 0;
  for (const r of rows) s += Number(r[col]) || 0;
  return s;
}

export interface EngineSummary {
  modeledTotal: number;
  hubspotTotal: number;
  grandTotal: number;
  employeeTotal: number;
  opexTotal: number;
  ebitdaTotal: number;
}

export function engineSummary(r: EvalResult): EngineSummary {
  const revenue = r.tables.revenue_monthly?.rows;
  const modeledTotal = sumCol(revenue, 'modeled_revenue');
  const grandTotal = sumCol(revenue, 'revenue');
  const hubspotTotal = grandTotal - modeledTotal;
  const employeeTotal = sumCol(r.tables.employee_total_monthly?.rows, 'staff');
  const opexTotal = sumCol(r.tables.total_opex_monthly?.rows, 'total_opex');
  const ebitdaTotal = sumCol(r.tables.budget_monthly?.rows, 'ebitda');
  return { modeledTotal, hubspotTotal, grandTotal, employeeTotal, opexTotal, ebitdaTotal };
}
