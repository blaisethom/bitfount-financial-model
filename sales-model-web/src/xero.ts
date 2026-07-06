// Types and transform for Xero accounting data → model Actuals overrides.
//
// The Vite server at /api/xero/sync fetches paged invoice data from both Xero
// orgs (Bitfount Inc USD + Bitfount Ltd GBP×FX) via the prokura CONNECT proxy,
// aggregates by account code + month, and returns the result in USD.
// This module classifies accounts by code range and builds ModelInput.actuals.

import type { Actuals, CostDept, PnlMetric } from './types';

// ─── Server response types ────────────────────────────────────────────────

export interface XeroSyncSuccess {
  ok: true;
  fetchedAt: string;
  gbpUsdRate: number;
  /** Sorted list of completed YYYY-MM months covered (Jan 2026 → last complete). */
  completedMonths: string[];
  /**
   * YYYY-MM → account code → total USD amount.
   * ACCREC revenue amounts and ACCPAY cost amounts are both stored as positive
   * numbers — sign interpretation is handled client-side per account class.
   */
  monthly: Record<string, Record<string, number>>;
  /** Account code → {name, type, class} metadata from Xero. */
  accounts: Record<string, { name: string; type: string; class: string }>;
  /**
   * Total bank account balance per completed month from the Xero BalanceSheet
   * report (YYYY-MM → USD equivalent). Parsed from the "Bank" section;
   * empty object if the balance sheet fetch failed.
   */
  bankBalances: Record<string, number>;
  /** Diagnostic note explaining which parse strategy was used or any error. */
  bankBalancesNote?: string;
  /** Org names whose prokura token key was not found (needs re-connecting in prokura). */
  disconnectedOrgs?: string[];
}

export interface XeroSyncFailure {
  ok: false;
  error: string;
}

export type XeroSyncResponse = XeroSyncSuccess | XeroSyncFailure;

// ─── Account classification ───────────────────────────────────────────────
//
// Xero account code ranges (consistent across both entities):
//   400xxx–499xxx  SALES / REVENUE        → revenue
//   500xxx         DIRECTCOSTS            → costOfSales
//   600xxx–619xxx  OVERHEADS (staff misc) → G&A nonStaff  (payroll not in invoices)
//   620xxx         OVERHEADS S&M          → Sales and Marketing nonStaff
//   630xxx         OVERHEADS Engineering  → Engineering nonStaff
//   640xxx–699xxx  OVERHEADS G&A misc     → G&A nonStaff
//   800xxx+        EXPENSE misc           → G&A nonStaff
//   100xxx–199xxx  Fixed assets / FIXED   → skip
//   200xxx–399xxx  Liability / Equity     → skip (no BS from invoices)

type ModelCategory =
  | { kind: 'revenue' }
  | { kind: 'costOfSales' }
  | { kind: 'nonStaff'; dept: CostDept }
  | { kind: 'skip' };

function classifyAccount(code: string, type: string, acctClass: string): ModelCategory {
  if (acctClass === 'REVENUE' || type === 'SALES' || type === 'OTHERINCOME') {
    return { kind: 'revenue' };
  }
  if (type === 'DIRECTCOSTS') return { kind: 'costOfSales' };
  if (acctClass !== 'EXPENSE') return { kind: 'skip' };

  const num = parseInt(code.replace(/\D/g, '').slice(0, 6), 10);
  if (isNaN(num)) return { kind: 'skip' };

  if (num >= 620000 && num < 630000) return { kind: 'nonStaff', dept: 'Sales and Marketing' };
  if (num >= 630000 && num < 640000) return { kind: 'nonStaff', dept: 'Engineering' };
  if ((num >= 600000 && num < 620000) || (num >= 640000 && num < 700000) || num >= 800000) {
    return { kind: 'nonStaff', dept: 'G&A' };
  }
  return { kind: 'skip' };
}

// ─── Actuals transform ────────────────────────────────────────────────────

export interface XeroActualsResult {
  actuals: Actuals;
  summary: string;
  months: string[];
}

/**
 * Build ModelInput.actuals from a successful Xero sync response.
 *
 * Revenue and COS are set from ACCREC/ACCPAY invoice line amounts.
 * Dept nonStaff overrides are set from ACCPAY expense account codes.
 * Staff costs (payroll) are NOT overridden — they require the Payroll API.
 * Cash is set from the BalanceSheet bank totals when available.
 * ebitda is deliberately omitted so the model derives it from the overridden
 * grossProfit − totalOpex.
 */
export function buildActualsFromXero(
  data: XeroSyncSuccess,
  modelDates: string[],
): XeroActualsResult {
  const revenue: Record<number, number> = {};
  const costOfSales: Record<number, number> = {};
  const nonStaff: Record<CostDept, Record<number, number>> = {
    'Sales and Marketing': {},
    'G&A': {},
    'Engineering': {},
    'Product Support': {},
  };
  // Per-account-name cost actuals: key = `dept|account_name`, value = month_idx → total
  const costLineRaw: Record<string, Record<number, number>> = {};

  for (const [yyyymm, codeTotals] of Object.entries(data.monthly)) {
    const monthIdx = modelDates.indexOf(yyyymm);
    if (monthIdx === -1) continue;

    for (const [code, amount] of Object.entries(codeTotals)) {
      const acct = data.accounts[code];
      if (!acct) continue;
      const cat = classifyAccount(code, acct.type, acct.class);

      if (cat.kind === 'revenue') {
        revenue[monthIdx] = (revenue[monthIdx] ?? 0) + amount;
      } else if (cat.kind === 'costOfSales') {
        costOfSales[monthIdx] = (costOfSales[monthIdx] ?? 0) + amount;
      } else if (cat.kind === 'nonStaff') {
        nonStaff[cat.dept][monthIdx] = (nonStaff[cat.dept][monthIdx] ?? 0) + amount;
        // Also record at the individual Xero account level for fine-grained overrides.
        // Key format: "dept|account_name" — matches against cost_line_actuals_t's
        // (dept, line_name) columns. User can rename model lines to match Xero names.
        const lineKey = `${cat.dept}|${acct.name}`;
        if (!costLineRaw[lineKey]) costLineRaw[lineKey] = {};
        costLineRaw[lineKey][monthIdx] = (costLineRaw[lineKey][monthIdx] ?? 0) + amount;
      }
    }
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const pnlMonthly: Actuals['pnlMonthly'] = {};
  const allPnlIdxs = new Set([...Object.keys(revenue), ...Object.keys(costOfSales)].map(Number));
  for (const idx of allPnlIdxs) {
    const overrides: Partial<Record<PnlMetric, number>> = {};
    if (revenue[idx] != null) overrides.revenue = round2(revenue[idx]);
    if (costOfSales[idx] != null) overrides.costOfSales = round2(costOfSales[idx]);
    if (Object.keys(overrides).length > 0) pnlMonthly[idx] = overrides;
  }

  const costDeptMonthly: Actuals['costDeptMonthly'] = {
    'Sales and Marketing': {},
    'G&A': {},
    'Engineering': {},
    'Product Support': {},
  };
  const depts: CostDept[] = ['Sales and Marketing', 'G&A', 'Engineering'];
  for (const dept of depts) {
    for (const [idx, val] of Object.entries(nonStaff[dept])) {
      costDeptMonthly[dept][Number(idx)] = { nonStaff: round2(val) };
    }
  }

  // Round all cost-line actuals
  const costLineMonthly: Actuals['costLineMonthly'] = {};
  for (const [key, byMonth] of Object.entries(costLineRaw)) {
    costLineMonthly[key] = Object.fromEntries(
      Object.entries(byMonth).map(([m, v]) => [Number(m), round2(v)]),
    );
  }

  // Populate cash actuals from the BalanceSheet bank balances.
  const bsMonthly: Actuals['bsMonthly'] = {};
  for (const [yyyymm, balance] of Object.entries(data.bankBalances ?? {})) {
    const monthIdx = modelDates.indexOf(yyyymm);
    if (monthIdx === -1) continue;
    bsMonthly[monthIdx] = { cash: round2(balance) };
  }

  const actuals: Actuals = {
    pnlMonthly,
    costDeptMonthly,
    bsMonthly,
    costLineMonthly,
  };

  const from = data.completedMonths[0] ?? '?';
  const to = data.completedMonths[data.completedMonths.length - 1] ?? '?';
  const range = from === to ? from : `${from} to ${to}`;
  const pnlCount = Object.keys(pnlMonthly).length;
  const deptMonths = depts.reduce((n, d) => n + Object.keys(costDeptMonthly[d]).length, 0);
  const lineCount = Object.keys(costLineMonthly).length;
  const cashMonths = Object.keys(bsMonthly).length;
  const cashNote = cashMonths > 0
    ? `${cashMonths} cash balance${cashMonths !== 1 ? 's' : ''}`
    : `no cash balances${data.bankBalancesNote ? ` [${data.bankBalancesNote}]` : ''}`;
  const summary = `${pnlCount} revenue/COS months · ${deptMonths} dept cost months · ${lineCount} cost line accounts · ${cashNote} (${range})`;

  return { actuals, summary, months: data.completedMonths };
}
