// Bridge from the v1 nested `ModelInput` shape to long-format engine source
// tables. Each v1 field becomes one or more tables; the v2 model then operates
// on those tables uniformly.
//
// This is the seam that lets v1 and v2 share the same input editing surface:
// the React app keeps its existing ModelInput in state, and we flatten on
// demand to feed the engine.

import type { ModelInput, CostDept, PnlMetric, CostDeptMetric, BsLine } from '../types';
import type { Table, Row, TableSchema } from '../engine';

// All months in the forecast horizon. Rows are always emitted (with null
// override values when unset) so the engine's left-join finds a match for
// every modeled row.
const MONTHS_OUT = 72;
const ALL_MONTH_IDXS = Array.from({ length: MONTHS_OUT }, (_, i) => i);

const PNL_METRIC_TO_COL: Record<PnlMetric, string> = {
  revenue: 'revenue_actual',
  costOfSales: 'cost_of_sales_actual',
  grossProfit: 'gross_profit_actual',
  totalOpex: 'total_opex_actual',
  ebitda: 'ebitda_actual',
};

const COST_DEPT_METRIC_TO_COL: Record<CostDeptMetric, string> = {
  staff: 'staff_actual',
  nonStaff: 'non_staff_actual',
  total: 'total_actual',
};

const BS_LINE_TO_COL: Record<BsLine, string> = {
  intangibleAssets: 'intangible_assets_actual',
  tangibleAssets: 'tangible_assets_actual',
  tradeDebtors: 'trade_debtors_actual',
  otherDebtors: 'other_debtors_actual',
  vat: 'vat_actual',
  cash: 'cash_actual',
  tradeCreditors: 'trade_creditors_actual',
  deferredRevenue: 'deferred_revenue_actual',
  otherCreditors: 'other_creditors_actual',
  loans: 'loans_actual',
  shareCapital: 'share_capital_actual',
  sharePremium: 'share_premium_actual',
  otherReserve: 'other_reserve_actual',
  bfwdRetainedEarnings: 'bfwd_retained_earnings_actual',
  currentEarnings: 'current_earnings_actual',
};

const SCHEMAS = {
  pricing: {
    columns: [
      { name: 'type', type: 'string' as const },
      { name: 'sites', type: 'number' as const },
      { name: 'bitfount', type: 'number' as const },
      { name: 'model', type: 'number' as const },
      { name: 'project_fee', type: 'number' as const },
      { name: 'pm_fee', type: 'number' as const },
    ],
  } satisfies TableSchema,

  schedule: {
    columns: [
      { name: 'ta', type: 'string' as const },
      { name: 'type', type: 'string' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'starts', type: 'number' as const },
    ],
  } satisfies TableSchema,

  hubspot_pipeline: {
    columns: [
      { name: 'ta', type: 'string' as const, description: 'Therapeutic area the deal that produced this row was allocated to' },
      { name: 'line_item', type: 'string' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const },
    ],
  } satisfies TableSchema,

  employees: {
    columns: [
      { name: 'id', type: 'string' as const },
      { name: 'first_name', type: 'string' as const },
      { name: 'surname', type: 'string' as const },
      { name: 'position', type: 'string' as const },
      { name: 'department', type: 'string' as const },
      { name: 'location', type: 'string' as const },
      { name: 'start_date', type: 'string' as const, description: 'Current or YYYY-MM' },
      { name: 'end_date', type: 'string' as const, description: 'YYYY-MM or null (runs to horizon end)' },
      { name: 'salary', type: 'number' as const },
      { name: 'sales_cap_eligible', type: 'boolean' as const, description: 'Counts toward the S&M sales-commission cap base' },
    ],
  } satisfies TableSchema,

  employee_assumptions: {
    columns: [
      { name: 'ni_rate', type: 'number' as const },
      { name: 'pension_rate', type: 'number' as const },
      { name: 'inflation_rate', type: 'number' as const },
      { name: 'inflation_start_year', type: 'number' as const },
      { name: 'inflation_start_month', type: 'number' as const },
      { name: 'max_inflation_steps', type: 'number' as const, description: 'Cap on inflation cycles applied (v4 bug: stops at 4)' },
      { name: 'inflate_future_hires', type: 'boolean' as const, description: 'v4 bug: false leaves future hires flat' },
    ],
  } satisfies TableSchema,

  commission: {
    columns: [
      { name: 'rate', type: 'number' as const },
      { name: 'cap_per_month', type: 'number' as const },
      { name: 'sales_per_client', type: 'number' as const },
      { name: 'sales_invoice_rate', type: 'number' as const },
    ],
  } satisfies TableSchema,

  cost_line_items: {
    columns: [
      { name: 'dept', type: 'string' as const },
      { name: 'line_name', type: 'string' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const },
    ],
  } satisfies TableSchema,

  depreciation: {
    columns: [
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const },
    ],
  } satisfies TableSchema,

  // Per-month R&D tax credit (positive = credit received). Booked below
  // operating profit; flows into profit_after_tax and the cash waterfall.
  rd_tax_credit: {
    columns: [
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const },
    ],
  } satisfies TableSchema,

  // Per-month interest income (positive = income received). Booked between
  // EBITDA and operating profit; flows into profit_after_tax and the cash
  // waterfall (via profit_after_tax).
  interest_income: {
    columns: [
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const },
    ],
  } satisfies TableSchema,

  dept_to_tab: {
    columns: [
      { name: 'employee_dept', type: 'string' as const, description: 'Key from Employees tab' },
      { name: 'cost_dept', type: 'string' as const, description: 'One of S&M / G&A / Engineering / Product Support' },
    ],
  } satisfies TableSchema,

  // ── Balance Sheet opening position (single row) ──
  // Values come from the v4 "All In One" / "Balance Sheet" sheets — the opening
  // position at the start of the modeling horizon. Liabilities (creditors,
  // loans) are stored as negative numbers so that Net Assets = sum of all lines
  // is well-defined without per-line sign juggling.
  opening_bs: {
    columns: [
      { name: 'opening_cash', type: 'number' as const, description: 'Opening cash & equivalents' },
      { name: 'opening_tangible_assets', type: 'number' as const, description: 'Opening tangible fixed assets (net)' },
      { name: 'opening_intangible_assets', type: 'number' as const, description: 'Opening intangible assets (net)' },
      { name: 'opening_trade_debtors', type: 'number' as const, description: 'Opening accounts receivable' },
      { name: 'opening_other_debtors', type: 'number' as const, description: 'Other debtors' },
      { name: 'opening_vat', type: 'number' as const, description: 'Opening VAT receivable' },
      { name: 'opening_trade_creditors', type: 'number' as const, description: 'Opening trade creditors (negative)' },
      { name: 'opening_deferred_revenue', type: 'number' as const, description: 'Opening deferred revenue (negative)' },
      { name: 'opening_other_creditors', type: 'number' as const, description: 'Other creditors (negative)' },
      { name: 'opening_loans', type: 'number' as const, description: 'Opening loan balance (negative)' },
      { name: 'share_capital', type: 'number' as const, description: 'Issued share capital (constant)' },
      { name: 'share_premium', type: 'number' as const, description: 'Share premium reserve (constant)' },
      { name: 'other_reserve', type: 'number' as const, description: 'Other reserves (constant)' },
      { name: 'bfwd_retained_earnings', type: 'number' as const, description: 'Brought-forward retained earnings (constant)' },
      { name: 'v4_reported_bfwd_retained_earnings', type: 'number' as const, description: "v4's reported opening BFWD (Budgets!G91) — reconciliation only, does not affect modeled balances" },
    ],
  } satisfies TableSchema,

  // ── Per-month BS schedule: capex, loan repayments, and the 4 WC lines that
  // v4 carries explicitly rather than via days-based formulas. One row per
  // month_idx 0..71.
  bs_monthly_schedule: {
    columns: [
      { name: 'month_idx',        type: 'number' as const },
      { name: 'capex',            type: 'number' as const, description: 'New tangible-asset purchases this month (positive = cash out)' },
      { name: 'loan_repayment',   type: 'number' as const, description: 'Loan principal repaid this month (positive = cash out)' },
      { name: 'trade_creditors',  type: 'number' as const, description: 'Closing trade creditors balance (negative for liability)' },
      { name: 'other_debtors',    type: 'number' as const },
      { name: 'vat',              type: 'number' as const },
      { name: 'other_creditors',  type: 'number' as const, description: 'Closing other creditors balance (negative for liability)' },
    ],
  } satisfies TableSchema,

  // ── Balance Sheet working-capital + tax assumptions (single row) ──
  bs_assumptions: {
    columns: [
      { name: 'ar_days', type: 'number' as const, description: 'Days sales outstanding — drives trade debtors balance' },
      { name: 'ap_days', type: 'number' as const, description: 'Days payable outstanding — drives trade creditors balance' },
      { name: 'monthly_loan_repayment', type: 'number' as const, description: 'Monthly principal repayment (positive number)' },
    ],
  } satisfies TableSchema,

  // Sparse list of per-(TA, month) revenue adjustments. Each row adds its
  // `value` to the TA's monthly total on top of modeled + HubSpot. Drives the
  // v4 2026 Ophthalmology budget tweaks (Jan/Feb/Mar formula adds plus
  // Oct/Nov/Dec hardcoded +$50k). Editable in the Total Revenue tab.
  revenue_adjustments: {
    columns: [
      { name: 'idx',       type: 'number' as const, description: 'Row order (identity column)' },
      { name: 'ta',        type: 'string' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'date',      type: 'string' as const, description: 'YYYY-MM display label' },
      { name: 'value',     type: 'number' as const },
      { name: 'note',      type: 'string' as const },
    ],
  } satisfies TableSchema,

  // Per-(TA, month) aggregated revenue adjustment — engine join target.
  // Built by flatten.ts by collapsing the sparse `revenue_adjustments` rows.
  revenue_adjustment_per_ta_monthly: {
    columns: [
      { name: 'ta', type: 'string' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'adjustment', type: 'number' as const },
    ],
  } satisfies TableSchema,

  // One row per month with a nullable `value` override. Null = use modelled
  // formula; non-null = replace it. Defaults reproduce v4's fully-hardcoded
  // S&M Commission line.
  sales_commission_overrides: {
    columns: [
      { name: 'month_idx', type: 'number' as const },
      { name: 'value', type: 'number' as const, description: 'Override; null falls through to formula' },
    ],
  } satisfies TableSchema,

  // Sparse list of per-month modeller commission adjustments. Each row adds
  // its `value` (positive = additional cost) to the modelled monthly
  // calculation. Drives v4's Jan/Feb/Mar/May 2026 historic commitments.
  modeller_commission_adjustments: {
    columns: [
      { name: 'idx',       type: 'number' as const },
      { name: 'month_idx', type: 'number' as const },
      { name: 'date',      type: 'string' as const, description: 'YYYY-MM (read-only)' },
      { name: 'value',     type: 'number' as const, description: 'Positive cost amount added to modelled commission' },
      { name: 'note',      type: 'string' as const },
    ],
  } satisfies TableSchema,
  modeller_commission_adjustment_per_month: {
    columns: [
      { name: 'month_idx',  type: 'number' as const },
      { name: 'adjustment', type: 'number' as const },
    ],
  } satisfies TableSchema,

  // HubSpot deal → TA allocation rules. One row per regex/TA rule from
  // `HubSpotSyncAssumptions.taAllocation.rules`. Editable in the HubSpot tab;
  // edits flow back to `hubspotSync.taAllocation.rules` via applyEdit. Rules
  // are consumed by `resolveDealTA` at sync time, *not* by the engine — this
  // table only exists as a canonical edit surface.
  hubspot_ta_rules: {
    columns: [
      { name: 'idx', type: 'number' as const, description: 'Rule order — lower idx tested first' },
      { name: 'pattern', type: 'string' as const, description: 'Case-insensitive JavaScript regex tested against the deal name' },
      { name: 'ta', type: 'string' as const, description: 'Therapeutic area to assign when the pattern matches' },
      { name: 'note', type: 'string' as const, description: 'Optional explanation' },
    ],
  } satisfies TableSchema,

  // Sparse adjustment list — one row per user-entered (employee, month, factor)
  // breakpoint. Editable in the Employees tab. The engine joins against
  // employee_factors_t (the expanded version below) rather than this table.
  employee_adjustments_sparse: {
    columns: [
      { name: 'employee_id', type: 'string' as const },
      { name: 'name',        type: 'string' as const, description: 'First + last name (read-only label)' },
      { name: 'month_idx',   type: 'number' as const, description: 'Month index 0..71 from which the factor applies' },
      { name: 'date',        type: 'string' as const, description: 'YYYY-MM display (read-only label)' },
      { name: 'factor',      type: 'number' as const, description: 'Multiplier on the cleanly-computed monthly cost' },
      { name: 'note',        type: 'string' as const, description: 'Optional explanation' },
    ],
  } satisfies TableSchema,

  // Expanded factors — one row per (employee_id, month_idx) where an
  // adjustment applies. Built in flatten.ts by forward-filling the sparse
  // breakpoints. Engine join target.
  employee_factors: {
    columns: [
      { name: 'employee_id', type: 'string' as const },
      { name: 'month_idx',   type: 'number' as const },
      { name: 'factor',      type: 'number' as const },
    ],
  } satisfies TableSchema,

  // ── Actuals overlay: monthly P&L ──
  // One row per month. Each `*_actual` column is null when no override is set;
  // otherwise its value replaces the modeled value in budget_monthly_with_actuals.
  // Yearly P&L derives from the overridden monthly via groupBy(year).
  pnl_monthly_actuals: {
    columns: [
      { name: 'month_idx', type: 'number' as const, description: '0..71 across the forecast horizon' },
      { name: 'revenue_actual', type: 'number' as const, description: 'Actual revenue override (null = use modeled)' },
      { name: 'cost_of_sales_actual', type: 'number' as const, description: 'Actual cost of sales override' },
      { name: 'gross_profit_actual', type: 'number' as const, description: 'Actual gross profit override' },
      { name: 'total_opex_actual', type: 'number' as const, description: 'Actual total opex override' },
      { name: 'ebitda_actual', type: 'number' as const, description: 'Actual EBITDA override' },
    ],
  } satisfies TableSchema,

  // ── Actuals overlay: per-(dept, month) opex ──
  // Lets the user reconcile per-dept monthly costs (e.g. G&A where v4 has
  // ad-hoc formulas) without touching individual line items. Yearly per-dept
  // numbers derive from the overridden monthly.
  cost_dept_monthly_actuals: {
    columns: [
      { name: 'cost_dept', type: 'string' as const, description: 'S&M / G&A / Engineering / Product Support' },
      { name: 'month_idx', type: 'number' as const },
      { name: 'staff_actual', type: 'number' as const, description: 'Staff cost override (null = use modeled)' },
      { name: 'non_staff_actual', type: 'number' as const, description: 'Non-staff cost override' },
      { name: 'total_actual', type: 'number' as const, description: 'Total dept opex override' },
    ],
  } satisfies TableSchema,

  // ── Actuals overlay: monthly Balance Sheet ──
  // One row per month. Yearly view picks end-of-year (December) months from
  // bs_summary_monthly_with_actuals.
  bs_monthly_actuals: {
    columns: [
      { name: 'month_idx', type: 'number' as const, description: '0..71 across the forecast horizon' },
      { name: 'intangible_assets_actual', type: 'number' as const },
      { name: 'tangible_assets_actual', type: 'number' as const },
      { name: 'trade_debtors_actual', type: 'number' as const },
      { name: 'other_debtors_actual', type: 'number' as const },
      { name: 'vat_actual', type: 'number' as const },
      { name: 'cash_actual', type: 'number' as const },
      { name: 'trade_creditors_actual', type: 'number' as const },
      { name: 'deferred_revenue_actual', type: 'number' as const },
      { name: 'other_creditors_actual', type: 'number' as const },
      { name: 'loans_actual', type: 'number' as const },
      { name: 'share_capital_actual', type: 'number' as const },
      { name: 'share_premium_actual', type: 'number' as const },
      { name: 'other_reserve_actual', type: 'number' as const },
      { name: 'bfwd_retained_earnings_actual', type: 'number' as const },
      { name: 'current_earnings_actual', type: 'number' as const },
    ],
  } satisfies TableSchema,
};

export const FLATTEN_SCHEMAS = SCHEMAS;

export interface FlattenedInput {
  tables: Record<string, Table>;
}

export function flattenModelInput(input: ModelInput): FlattenedInput {
  const tables: Record<string, Table> = {};

  // Calendar (`dates_t`) is derived inside the model from a `sequence` source
  // and a `derive_dates` step — see salesModel.ts. We do not produce it here.

  // ─── pricing ───
  tables.pricing_t = {
    schema: SCHEMAS.pricing,
    rows: (['A', 'B', 'C'] as const).map((t): Row => {
      const p = input.pricing[t];
      return {
        type: t,
        sites: p.sites,
        bitfount: p.bitfountLicense,
        model: p.aiLicense,
        project_fee: p.projectFee,
        pm_fee: p.pmFee,
      };
    }),
  };

  // ─── schedule (TA × type × month) ───
  const schedRows: Row[] = [];
  for (const ta of input.taNames) {
    const s = input.schedule[ta];
    if (!s) continue;
    for (const t of ['A', 'B', 'C'] as const) {
      s[t].forEach((starts, i) => {
        schedRows.push({ ta, type: t, month_idx: i, starts });
      });
    }
  }
  tables.schedule_t = { schema: SCHEMAS.schedule, rows: schedRows };

  // ─── Per-(TA, month) revenue adjustments ───
  // Sparse — one row per user-entered breakpoint. Engine joins against the
  // dense per-(ta, month_idx) version below.
  tables.revenue_adjustments_t = {
    schema: SCHEMAS.revenue_adjustments,
    rows: input.revenueAdjustments.map((adj, idx): Row => ({
      idx,
      ta: adj.ta,
      month_idx: adj.monthIdx,
      date: input.dates[adj.monthIdx] ?? '',
      value: adj.value,
      note: adj.note ?? '',
    })),
  };
  // Dense view: sum adjustments per (ta, month_idx). Multiple sparse entries
  // for the same cell add together.
  const adjMap = new Map<string, number>();
  for (const adj of input.revenueAdjustments) {
    const k = `${adj.ta}\x1f${adj.monthIdx}`;
    adjMap.set(k, (adjMap.get(k) ?? 0) + adj.value);
  }
  tables.revenue_adjustment_per_ta_monthly_t = {
    schema: SCHEMAS.revenue_adjustment_per_ta_monthly,
    rows: Array.from(adjMap.entries()).map(([k, value]): Row => {
      const [ta, monthStr] = k.split('\x1f');
      return { ta, month_idx: Number(monthStr), adjustment: value };
    }),
  };

  // ─── Per-month sales commission overrides ───
  // Always emit one row per month. The value is the user's override (or
  // pre-populated v4 value). Null falls through to the formula downstream.
  const overrideByMonth = new Map<number, number | null>();
  for (const o of input.salesCommissionOverrides) overrideByMonth.set(o.monthIdx, o.value);
  tables.sales_commission_overrides_t = {
    schema: SCHEMAS.sales_commission_overrides,
    rows: ALL_MONTH_IDXS.map((m): Row => ({
      month_idx: m,
      value: overrideByMonth.has(m) ? overrideByMonth.get(m) ?? null : null,
    })),
  };

  // ─── Per-month modeller commission adjustments ───
  tables.modeller_commission_adjustments_t = {
    schema: SCHEMAS.modeller_commission_adjustments,
    rows: input.modellerCommissionAdjustments.map((adj, idx): Row => ({
      idx,
      month_idx: adj.monthIdx,
      date: input.dates[adj.monthIdx] ?? '',
      value: adj.value,
      note: adj.note ?? '',
    })),
  };
  const mcAdjMap = new Map<number, number>();
  for (const adj of input.modellerCommissionAdjustments) {
    mcAdjMap.set(adj.monthIdx, (mcAdjMap.get(adj.monthIdx) ?? 0) + adj.value);
  }
  tables.modeller_commission_adjustment_per_month_t = {
    schema: SCHEMAS.modeller_commission_adjustment_per_month,
    rows: Array.from(mcAdjMap.entries()).map(([m, adjustment]): Row => ({ month_idx: m, adjustment })),
  };

  // ─── HubSpot deal → TA allocation rules ───
  tables.hubspot_ta_rules_t = {
    schema: SCHEMAS.hubspot_ta_rules,
    rows: input.hubspotSync.taAllocation.rules.map((rule, idx): Row => ({
      idx,
      pattern: rule.pattern,
      ta: rule.ta,
      note: rule.note ?? '',
    })),
  };

  // ─── hubspot pipeline (TA × line_item × month) ───
  // Emit from byTALineItems (one row per (ta, line_item, month_idx) cell) so
  // each pipeline dollar carries the TA it was allocated to. The legacy
  // `input.hubspot.lineItems` field is the cross-TA sum and is *not* used
  // here — it stays in `HubSpotData` only for backward compatibility with
  // existing UIs that haven't been updated.
  const hsRows: Row[] = [];
  for (const [ta, byLine] of Object.entries(input.hubspot.byTALineItems)) {
    for (const [name, arr] of Object.entries(byLine)) {
      arr.forEach((value, i) => {
        if (value !== 0) hsRows.push({ ta, line_item: name, month_idx: i, value });
      });
    }
  }
  tables.hubspot_pipeline_t = { schema: SCHEMAS.hubspot_pipeline, rows: hsRows };

  // ─── employees ───
  tables.employees_t = {
    schema: SCHEMAS.employees,
    rows: input.employees.map((e): Row => ({
      id: e.id,
      first_name: e.firstName,
      surname: e.surname,
      position: e.position,
      department: e.department,
      location: e.location,
      start_date: e.startDate,
      // Encode "no end date" as the sentinel '9999-12' so date comparisons in
      // the engine work without a null branch. Anyone with end_date ≥ 9999-12
      // is effectively never-ending.
      end_date: e.endDate ?? '9999-12',
      salary: e.salary,
      sales_cap_eligible: e.salesCapEligible ?? false,
    })),
  };

  // ─── employee assumptions (single row) ───
  tables.employee_assumptions_t = {
    schema: SCHEMAS.employee_assumptions,
    rows: [{
      ni_rate: input.employeeAssumptions.niRate,
      pension_rate: input.employeeAssumptions.pensionRate,
      inflation_rate: input.employeeAssumptions.annualInflationRate,
      inflation_start_year: input.employeeAssumptions.inflationStartYear,
      inflation_start_month: input.employeeAssumptions.inflationStartMonth,
      max_inflation_steps: input.employeeAssumptions.maxInflationSteps,
      inflate_future_hires: input.employeeAssumptions.inflateFutureHires,
    }],
  };

  // ─── commission assumptions (single row) ───
  tables.commission_t = {
    schema: SCHEMAS.commission,
    rows: [{
      rate: input.commission.rate,
      cap_per_month: input.commission.capPerMonth,
      sales_per_client: input.commission.salesPerClient,
      sales_invoice_rate: input.commission.salesInvoiceRate,
    }],
  };

  // ─── cost line items (dept × line × month) ───
  // Skip S&M Commission — it's replaced by the derived sales commission.
  const costRows: Row[] = [];
  for (const dept of input.costs.depts) {
    const items = input.costs.lineItems[dept] ?? {};
    for (const [lineName, arr] of Object.entries(items)) {
      if (dept === 'Sales and Marketing' && lineName === 'Commission') continue;
      arr.forEach((value, i) => costRows.push({ dept, line_name: lineName, month_idx: i, value }));
    }
  }
  tables.cost_line_items_t = { schema: SCHEMAS.cost_line_items, rows: costRows };

  // ─── depreciation (per month) ───
  tables.depreciation_t = {
    schema: SCHEMAS.depreciation,
    rows: input.costs.costOfSales.depreciation.map((value, i): Row => ({ month_idx: i, value })),
  };

  // ─── R&D tax credit (per month) ───
  tables.rd_tax_credit_t = {
    schema: SCHEMAS.rd_tax_credit,
    rows: input.rdTaxCredit.map((value, i): Row => ({ month_idx: i, value })),
  };

  // ─── interest income (per month) ───
  tables.interest_income_t = {
    schema: SCHEMAS.interest_income,
    rows: input.interestIncome.map((value, i): Row => ({ month_idx: i, value })),
  };

  // ─── dept to tab mapping (employee_dept → cost_dept) ───
  tables.dept_to_tab_t = {
    schema: SCHEMAS.dept_to_tab,
    rows: Object.entries(input.costs.deptToTab).map(([employee_dept, cost_dept]): Row => ({
      employee_dept,
      cost_dept,
    })),
  };

  // ─── opening balance sheet (single row) ───
  tables.opening_bs_t = {
    schema: SCHEMAS.opening_bs,
    rows: [{
      opening_cash: input.openingBs.openingCash,
      opening_tangible_assets: input.openingBs.openingTangibleAssets,
      opening_intangible_assets: input.openingBs.openingIntangibleAssets,
      opening_trade_debtors: input.openingBs.openingTradeDebtors,
      opening_other_debtors: input.openingBs.openingOtherDebtors,
      opening_vat: input.openingBs.openingVat,
      opening_trade_creditors: input.openingBs.openingTradeCreditors,
      opening_deferred_revenue: input.openingBs.openingDeferredRevenue,
      opening_other_creditors: input.openingBs.openingOtherCreditors,
      opening_loans: input.openingBs.openingLoans,
      share_capital: input.openingBs.shareCapital,
      share_premium: input.openingBs.sharePremium,
      other_reserve: input.openingBs.otherReserve,
      bfwd_retained_earnings: input.openingBs.bfwdRetainedEarnings,
      v4_reported_bfwd_retained_earnings: input.openingBs.v4ReportedBfwdRetainedEarnings,
    }],
  };

  // ─── per-month BS schedule (capex / loans / WC) ───
  tables.bs_monthly_schedule_t = {
    schema: SCHEMAS.bs_monthly_schedule,
    rows: input.bsMonthlySchedule.map((s): Row => ({
      month_idx: s.monthIdx,
      capex: s.capex,
      loan_repayment: s.loanRepayment,
      trade_creditors: s.tradeCreditors,
      other_debtors: s.otherDebtors,
      vat: s.vat,
      other_creditors: s.otherCreditors,
    })),
  };

  // ─── balance sheet assumptions (single row) ───
  tables.bs_assumptions_t = {
    schema: SCHEMAS.bs_assumptions,
    rows: [{
      ar_days: input.bsAssumptions.arDays,
      ap_days: input.bsAssumptions.apDays,
      monthly_loan_repayment: input.bsAssumptions.monthlyLoanRepayment,
    }],
  };

  // ─── per-employee salary adjustments ───
  const empById = new Map(input.employees.map((e) => [e.id, e]));
  const dateOf = (m: number): string => input.dates[m] ?? '';

  // Sparse view: one row per breakpoint — for UI editing.
  tables.employee_adjustments_sparse_t = {
    schema: SCHEMAS.employee_adjustments_sparse,
    rows: input.employeeCostAdjustments.map((adj): Row => {
      const e = empById.get(adj.employeeId);
      const name = e ? `${e.firstName ?? ''} ${e.surname ?? ''}`.trim() || (e.position ?? '') : adj.employeeId;
      return {
        employee_id: adj.employeeId,
        name,
        month_idx: adj.monthIdx,
        date: dateOf(adj.monthIdx),
        factor: adj.factor,
        note: adj.note ?? '',
      };
    }),
  };

  // Expanded factors: for each (employee, month) where an adjustment applies,
  // emit a row with the forward-filled factor. Latest adjustment for the same
  // employee at or before the month wins.
  const byEmployee = new Map<string, Array<{ monthIdx: number; factor: number }>>();
  for (const adj of input.employeeCostAdjustments) {
    const list = byEmployee.get(adj.employeeId) ?? [];
    list.push({ monthIdx: adj.monthIdx, factor: adj.factor });
    byEmployee.set(adj.employeeId, list);
  }
  const factorRows: Row[] = [];
  for (const [empId, list] of byEmployee) {
    const sorted = [...list].sort((a, b) => a.monthIdx - b.monthIdx);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const nextMonth = i + 1 < sorted.length ? sorted[i + 1].monthIdx : MONTHS_OUT;
      for (let m = a.monthIdx; m < nextMonth; m++) {
        factorRows.push({ employee_id: empId, month_idx: m, factor: a.factor });
      }
    }
  }
  tables.employee_factors_t = {
    schema: SCHEMAS.employee_factors,
    rows: factorRows,
  };

  // ─── actuals overlays (monthly) ───
  // For each month_idx 0..71, emit one row with overrides where present and
  // null otherwise. The engine's left-join + iff(null, modeled, actual) picks
  // the actual when set. Yearly rollups are computed downstream from the
  // overridden monthly tables, never edited directly.
  tables.pnl_monthly_actuals_t = {
    schema: SCHEMAS.pnl_monthly_actuals,
    rows: ALL_MONTH_IDXS.map((month_idx): Row => {
      const overrides = input.actuals.pnlMonthly[month_idx] ?? {};
      const row: Row = { month_idx };
      for (const [metric, colName] of Object.entries(PNL_METRIC_TO_COL) as Array<[PnlMetric, string]>) {
        row[colName] = overrides[metric] ?? null;
      }
      return row;
    }),
  };

  tables.cost_dept_monthly_actuals_t = {
    schema: SCHEMAS.cost_dept_monthly_actuals,
    rows: (Object.keys(input.actuals.costDeptMonthly) as CostDept[]).flatMap((dept) =>
      ALL_MONTH_IDXS.map((month_idx): Row => {
        const overrides = input.actuals.costDeptMonthly[dept]?.[month_idx] ?? {};
        const row: Row = { cost_dept: dept, month_idx };
        for (const [metric, colName] of Object.entries(COST_DEPT_METRIC_TO_COL) as Array<[CostDeptMetric, string]>) {
          row[colName] = overrides[metric] ?? null;
        }
        return row;
      }),
    ),
  };

  tables.bs_monthly_actuals_t = {
    schema: SCHEMAS.bs_monthly_actuals,
    rows: ALL_MONTH_IDXS.map((month_idx): Row => {
      const overrides = input.actuals.bsMonthly[month_idx] ?? {};
      const row: Row = { month_idx };
      for (const [line, colName] of Object.entries(BS_LINE_TO_COL) as Array<[BsLine, string]>) {
        row[colName] = overrides[line] ?? null;
      }
      return row;
    }),
  };

  return { tables };
}
