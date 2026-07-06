// Translate ReportEdit events (engine table rows) into ModelInput mutations.
//
// The React renderer emits cell edits in long-format: `{source, identity,
// col, value}`. The host app's state is the nested `ModelInput` shape used
// by `loadInitialInput`, so we translate per source ref into the
// corresponding nested update.

import type { CellValue } from '../engine';
import type {
  BalanceSheetAssumptions, BsLine, CommissionAssumptions, CostDept, CostDeptMetric,
  EmployeeAssumptions, ModelInput, OpeningBalanceSheet, PnlMetric, Pricing, TrialType,
} from '../types';
import type { ReportEdit } from './EngineSection';

const PRICING_COL_TO_KEY: Record<string, keyof Pricing['A']> = {
  sites: 'sites',
  bitfount: 'bitfountLicense',
  model: 'aiLicense',
  project_fee: 'projectFee',
  pm_fee: 'pmFee',
};

const COMMISSION_COL_TO_KEY: Record<string, keyof CommissionAssumptions> = {
  rate: 'rate',
  cap_per_month: 'capPerMonth',
  sales_per_client: 'salesPerClient',
  sales_invoice_rate: 'salesInvoiceRate',
};

const EMP_ASSUMP_COL_TO_KEY: Record<string, keyof EmployeeAssumptions> = {
  ni_rate: 'niRate',
  pension_rate: 'pensionRate',
  inflation_rate: 'annualInflationRate',
  inflation_start_year: 'inflationStartYear',
  inflation_start_month: 'inflationStartMonth',
  max_inflation_steps: 'maxInflationSteps',
  inflate_future_hires: 'inflateFutureHires',
};

const OPENING_BS_COL_TO_KEY: Record<string, keyof OpeningBalanceSheet> = {
  opening_cash: 'openingCash',
  opening_tangible_assets: 'openingTangibleAssets',
  opening_intangible_assets: 'openingIntangibleAssets',
  opening_trade_debtors: 'openingTradeDebtors',
  opening_other_debtors: 'openingOtherDebtors',
  opening_vat: 'openingVat',
  opening_trade_creditors: 'openingTradeCreditors',
  opening_deferred_revenue: 'openingDeferredRevenue',
  opening_other_creditors: 'openingOtherCreditors',
  opening_loans: 'openingLoans',
  share_capital: 'shareCapital',
  share_premium: 'sharePremium',
  other_reserve: 'otherReserve',
  bfwd_retained_earnings: 'bfwdRetainedEarnings',
};

const BS_ASSUMP_COL_TO_KEY: Record<string, keyof BalanceSheetAssumptions> = {
  ar_days: 'arDays',
  ap_days: 'apDays',
  monthly_loan_repayment: 'monthlyLoanRepayment',
};

// Actual-override columns → typed metric keys. Edits to `*_actual` columns in
// the engine map back to the matching sparse Actuals slot on ModelInput.

const PNL_METRIC_COL_TO_KEY: Record<string, PnlMetric> = {
  revenue_actual: 'revenue',
  cost_of_sales_actual: 'costOfSales',
  gross_profit_actual: 'grossProfit',
  total_opex_actual: 'totalOpex',
  ebitda_actual: 'ebitda',
};

const COST_DEPT_METRIC_COL_TO_KEY: Record<string, CostDeptMetric> = {
  staff_actual: 'staff',
  non_staff_actual: 'nonStaff',
  total_actual: 'total',
};

const BS_LINE_COL_TO_KEY: Record<string, BsLine> = {
  intangible_assets_actual: 'intangibleAssets',
  tangible_assets_actual: 'tangibleAssets',
  trade_debtors_actual: 'tradeDebtors',
  other_debtors_actual: 'otherDebtors',
  vat_actual: 'vat',
  cash_actual: 'cash',
  trade_creditors_actual: 'tradeCreditors',
  deferred_revenue_actual: 'deferredRevenue',
  other_creditors_actual: 'otherCreditors',
  loans_actual: 'loans',
  share_capital_actual: 'shareCapital',
  share_premium_actual: 'sharePremium',
  other_reserve_actual: 'otherReserve',
  bfwd_retained_earnings_actual: 'bfwdRetainedEarnings',
  current_earnings_actual: 'currentEarnings',
};

/** Parse value: numeric input → number; empty string → undefined (clears override). */
function asOverrideValue(v: number | string): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const trimmed = v.trim();
  if (trimmed === '') return undefined;
  const n = parseFloat(trimmed);
  return Number.isNaN(n) ? undefined : n;
}

function asNumber(v: number | string): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

export function applyEditToInput(input: ModelInput, edit: ReportEdit): ModelInput {
  const id = edit.identity;
  switch (edit.source) {
    // ── pricing ─────────────────────────────────────────────────────────
    case 'pricing_t': {
      const t = String(id.type) as TrialType;
      const key = PRICING_COL_TO_KEY[edit.col];
      if (!key) return input;
      return {
        ...input,
        pricing: {
          ...input.pricing,
          [t]: { ...input.pricing[t], [key]: asNumber(edit.value) },
        },
      };
    }

    // ── schedule (starts per TA × type × month) ─────────────────────────
    case 'schedule_t': {
      const ta = String(id.ta);
      const t = String(id.type) as TrialType;
      const m = Number(id.month_idx);
      const cur = input.schedule[ta];
      if (!cur) return input;
      const updated = { A: [...cur.A], B: [...cur.B], C: [...cur.C] };
      updated[t][m] = asNumber(edit.value);
      return {
        ...input,
        schedule: { ...input.schedule, [ta]: updated },
      };
    }

    // ── commission assumptions ──────────────────────────────────────────
    case 'commission_t': {
      const key = COMMISSION_COL_TO_KEY[edit.col];
      if (!key) return input;
      return {
        ...input,
        commission: { ...input.commission, [key]: asNumber(edit.value) },
      };
    }

    // ── employee assumptions ────────────────────────────────────────────
    case 'employee_assumptions_t': {
      const key = EMP_ASSUMP_COL_TO_KEY[edit.col];
      if (!key) return input;
      return {
        ...input,
        employeeAssumptions: { ...input.employeeAssumptions, [key]: asNumber(edit.value) },
      };
    }

    // ── employees roster ────────────────────────────────────────────────
    case 'employees_t': {
      const empId = String(id.id);
      const idx = input.employees.findIndex((e) => e.id === empId);
      if (idx < 0) return input;
      const cur = input.employees[idx];
      const employees = [...input.employees];
      const v = edit.value;
      const numericCols = new Set(['salary']);
      const stringCols = new Set(['first_name', 'surname', 'position', 'department', 'location', 'start_date']);
      const mapKey: Record<string, keyof typeof cur> = {
        first_name: 'firstName',
        surname: 'surname',
        position: 'position',
        department: 'department',
        location: 'location',
        start_date: 'startDate',
        salary: 'salary',
      };
      const k = mapKey[edit.col];
      if (!k) return input;
      if (numericCols.has(edit.col)) {
        employees[idx] = { ...cur, [k]: asNumber(v) } as typeof cur;
      } else if (stringCols.has(edit.col)) {
        employees[idx] = { ...cur, [k]: String(v) } as typeof cur;
      } else return input;
      return { ...input, employees };
    }

    // ── Per-month sales commission overrides ───────────────────────────
    case 'sales_commission_overrides_t': {
      const m = Number(id.month_idx);
      if (!Number.isFinite(m)) return input;
      const list = [...input.salesCommissionOverrides];
      const idx = list.findIndex((o) => o.monthIdx === m);
      if (edit.col === 'value') {
        // Treat empty string / NaN as null (= use modelled formula).
        const raw = edit.value;
        const trimmed = typeof raw === 'string' ? raw.trim() : raw;
        const v: number | null =
          trimmed === '' || trimmed == null ? null
          : typeof trimmed === 'number' ? (Number.isFinite(trimmed) ? trimmed : null)
          : (() => { const n = parseFloat(String(trimmed)); return Number.isFinite(n) ? n : null; })();
        if (idx >= 0) list[idx] = { ...list[idx], value: v };
        else list.push({ monthIdx: m, value: v });
      } else if (edit.col === 'note') {
        if (idx >= 0) list[idx] = { ...list[idx], note: String(edit.value) };
        else list.push({ monthIdx: m, value: null, note: String(edit.value) });
      } else return input;
      return { ...input, salesCommissionOverrides: list };
    }

    // ── Per-month modeller commission adjustments ──────────────────────
    case 'modeller_commission_adjustments_t': {
      const idx = Number(id.idx);
      if (!Number.isFinite(idx)) return input;
      const list = [...input.modellerCommissionAdjustments];
      if (idx < 0 || idx >= list.length) return input;
      const cur = list[idx];
      const next = { ...cur };
      if (edit.col === 'month_idx') {
        const m = asNumber(edit.value);
        if (Number.isFinite(m)) next.monthIdx = m;
      } else if (edit.col === 'value') next.value = asNumber(edit.value);
      else if (edit.col === 'note') next.note = String(edit.value);
      else return input;
      list[idx] = next;
      return { ...input, modellerCommissionAdjustments: list };
    }

    // ── Per-(TA, month) revenue adjustments ─────────────────────────────
    case 'revenue_adjustments_t': {
      const idx = Number(id.idx);
      if (!Number.isFinite(idx)) return input;
      const list = [...input.revenueAdjustments];
      if (idx < 0 || idx >= list.length) return input;
      const cur = list[idx];
      const next = { ...cur };
      if (edit.col === 'ta') next.ta = String(edit.value);
      else if (edit.col === 'month_idx') {
        const m = asNumber(edit.value);
        if (Number.isFinite(m)) next.monthIdx = m;
      } else if (edit.col === 'value') next.value = asNumber(edit.value);
      else if (edit.col === 'note') next.note = String(edit.value);
      else return input;
      list[idx] = next;
      return { ...input, revenueAdjustments: list };
    }

    // ── HubSpot TA allocation rules ─────────────────────────────────────
    case 'hubspot_ta_rules_t': {
      const idx = Number(id.idx);
      if (!Number.isFinite(idx)) return input;
      const rules = [...input.hubspotSync.taAllocation.rules];
      if (idx < 0 || idx >= rules.length) return input;
      const cur = rules[idx];
      const next = { ...cur };
      if (edit.col === 'pattern') next.pattern = String(edit.value);
      else if (edit.col === 'ta') next.ta = String(edit.value);
      else if (edit.col === 'note') next.note = String(edit.value);
      else return input;
      rules[idx] = next;
      return {
        ...input,
        hubspotSync: {
          ...input.hubspotSync,
          taAllocation: { ...input.hubspotSync.taAllocation, rules },
        },
      };
    }

    // ── HubSpot pipeline (TA × line_item × month) ───────────────────────
    case 'hubspot_pipeline_t': {
      const name = String(id.line_item);
      const m = Number(id.month_idx);
      const ta = String(id.ta);
      const items = input.hubspot.lineItems;
      const byTA = input.hubspot.byTALineItems;
      if (!items[name]) return input;
      const v = asNumber(edit.value);
      // Find the previous TA-allocated value for this (ta, line_item, month)
      // so we can patch the cross-TA `lineItems[name]` total consistently.
      const prevTAVal = byTA[ta]?.[name]?.[m] ?? 0;
      const updatedLine = [...items[name]];
      updatedLine[m] = (updatedLine[m] ?? 0) - prevTAVal + v;
      const lineItems = { ...items, [name]: updatedLine };
      // Update the per-TA bucket
      const taLines = byTA[ta] ? { ...byTA[ta] } : {};
      const taArr = taLines[name] ? [...taLines[name]] : new Array(input.dates.length).fill(0);
      taArr[m] = v;
      taLines[name] = taArr;
      const nextByTA = { ...byTA, [ta]: taLines };
      const grandTotal = new Array(input.dates.length).fill(0);
      for (const vs of Object.values(lineItems)) {
        for (let i = 0; i < grandTotal.length; i++) grandTotal[i] += vs[i] ?? 0;
      }
      return { ...input, hubspot: { lineItems, byTALineItems: nextByTA, grandTotal } };
    }

    // ── Cost line items (dept × line × month) ───────────────────────────
    case 'cost_line_items_t': {
      const dept = String(id.dept) as keyof ModelInput['costs']['lineItems'];
      const line = String(id.line_name);
      const m = Number(id.month_idx);
      const items = input.costs.lineItems[dept];
      if (!items?.[line]) return input;
      const updated = [...items[line]];
      updated[m] = asNumber(edit.value);
      return {
        ...input,
        costs: {
          ...input.costs,
          lineItems: {
            ...input.costs.lineItems,
            [dept]: { ...items, [line]: updated },
          },
        },
      };
    }

    // ── Depreciation per month ──────────────────────────────────────────
    case 'depreciation_t': {
      const m = Number(id.month_idx);
      const arr = [...input.costs.costOfSales.depreciation];
      arr[m] = asNumber(edit.value);
      return {
        ...input,
        costs: { ...input.costs, costOfSales: { ...input.costs.costOfSales, depreciation: arr } },
      };
    }

    // ── R&D tax credit per month ────────────────────────────────────────
    case 'rd_tax_credit_t': {
      const m = Number(id.month_idx);
      const arr = [...input.rdTaxCredit];
      arr[m] = asNumber(edit.value);
      return { ...input, rdTaxCredit: arr };
    }

    // ── Interest income per month ───────────────────────────────────────
    case 'interest_income_t': {
      const m = Number(id.month_idx);
      const arr = [...input.interestIncome];
      arr[m] = asNumber(edit.value);
      return { ...input, interestIncome: arr };
    }

    // ── Opening balance sheet (single row) ──────────────────────────────
    case 'opening_bs_t': {
      const key = OPENING_BS_COL_TO_KEY[edit.col];
      if (!key) return input;
      return {
        ...input,
        openingBs: { ...input.openingBs, [key]: asNumber(edit.value) },
      };
    }

    // ── Balance sheet assumptions (single row) ──────────────────────────
    case 'bs_assumptions_t': {
      const key = BS_ASSUMP_COL_TO_KEY[edit.col];
      if (!key) return input;
      return {
        ...input,
        bsAssumptions: { ...input.bsAssumptions, [key]: asNumber(edit.value) },
      };
    }

    // ── Actuals: monthly P&L overrides ──────────────────────────────────
    case 'pnl_monthly_actuals_t': {
      const m = Number(id.month_idx);
      const key = PNL_METRIC_COL_TO_KEY[edit.col];
      if (!key || !Number.isFinite(m)) return input;
      const prev = input.actuals.pnlMonthly[m] ?? {};
      const v = asOverrideValue(edit.value);
      const next = { ...prev };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return {
        ...input,
        actuals: {
          ...input.actuals,
          pnlMonthly: { ...input.actuals.pnlMonthly, [m]: next },
        },
      };
    }

    // ── Actuals: per-(dept, month) opex overrides ───────────────────────
    case 'cost_dept_monthly_actuals_t': {
      const dept = String(id.cost_dept) as CostDept;
      const m = Number(id.month_idx);
      const key = COST_DEPT_METRIC_COL_TO_KEY[edit.col];
      if (!key || !Number.isFinite(m)) return input;
      if (!(dept in input.actuals.costDeptMonthly)) return input;
      const prev = input.actuals.costDeptMonthly[dept][m] ?? {};
      const v = asOverrideValue(edit.value);
      const next = { ...prev };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return {
        ...input,
        actuals: {
          ...input.actuals,
          costDeptMonthly: {
            ...input.actuals.costDeptMonthly,
            [dept]: {
              ...input.actuals.costDeptMonthly[dept],
              [m]: next,
            },
          },
        },
      };
    }

    // ── Employee salary adjustments (sparse, per (emp, month)) ─────────
    case 'employee_adjustments_sparse_t': {
      const empId = String(id.employee_id);
      const m = Number(id.month_idx);
      if (!empId || !Number.isFinite(m)) return input;
      const list = [...input.employeeCostAdjustments];
      const idx = list.findIndex((a) => a.employeeId === empId && a.monthIdx === m);
      if (idx < 0) return input;
      const cur = list[idx];
      if (edit.col === 'factor') {
        list[idx] = { ...cur, factor: asNumber(edit.value) };
      } else if (edit.col === 'note') {
        list[idx] = { ...cur, note: String(edit.value) };
      } else if (edit.col === 'month_idx') {
        const newM = asNumber(edit.value);
        if (Number.isFinite(newM)) list[idx] = { ...cur, monthIdx: newM };
      } else {
        // employee_id / name / date are read-only labels.
        return input;
      }
      return { ...input, employeeCostAdjustments: list };
    }

    // ── Cost-line actuals (per dept × line_name × month) ───────────────
    // Edits to actual_value update actuals.costLineMonthly["dept|line_name"][month_idx].
    // Clearing (empty string) removes the override so the modeled value is used again.
    case 'cost_line_actuals_t': {
      const dept = String(id.dept);
      const line = String(id.line_name);
      const m = Number(id.month_idx);
      if (!dept || !line || !Number.isFinite(m)) return input;
      if (edit.col !== 'actual_value') return input;
      const key = `${dept}|${line}`;
      const v = asOverrideValue(edit.value);
      const prev = input.actuals.costLineMonthly ?? {};
      const prevEntry = prev[key] ?? {};
      const nextEntry = { ...prevEntry };
      if (v === undefined) delete nextEntry[m];
      else nextEntry[m] = v;
      const nextCostLine = { ...prev, [key]: nextEntry };
      if (Object.keys(nextEntry).length === 0) delete nextCostLine[key];
      return {
        ...input,
        actuals: { ...input.actuals, costLineMonthly: nextCostLine },
      };
    }

    // ── Actuals: monthly balance sheet overrides ────────────────────────
    case 'bs_monthly_actuals_t': {
      const m = Number(id.month_idx);
      const key = BS_LINE_COL_TO_KEY[edit.col];
      if (!key || !Number.isFinite(m)) return input;
      const prev = input.actuals.bsMonthly[m] ?? {};
      const v = asOverrideValue(edit.value);
      const next = { ...prev };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return {
        ...input,
        actuals: {
          ...input.actuals,
          bsMonthly: { ...input.actuals.bsMonthly, [m]: next },
        },
      };
    }

    // ── Per-month BS schedule (capex / loans / working-capital) ─────────
    case 'bs_monthly_schedule_t': {
      const m = Number(id.month_idx);
      const key = BS_SCHEDULE_COL_TO_KEY[edit.col];
      if (!key || !Number.isFinite(m)) return input;
      const arr = input.bsMonthlySchedule.map((s) => ({ ...s }));
      const row = arr.find((s) => s.monthIdx === m);
      if (!row) return input;
      row[key] = asNumber(edit.value);
      return { ...input, bsMonthlySchedule: arr };
    }

    default:
      return input;
  }
}

/** BS schedule flattened column → BalanceSheetMonthlySchedule numeric key. */
const BS_SCHEDULE_COL_TO_KEY: Record<string, 'capex' | 'loanRepayment' | 'tradeCreditors' | 'otherDebtors' | 'vat' | 'otherCreditors'> = {
  capex: 'capex',
  loan_repayment: 'loanRepayment',
  trade_creditors: 'tradeCreditors',
  other_debtors: 'otherDebtors',
  vat: 'vat',
  other_creditors: 'otherCreditors',
};

/** Source tables that `applyEditToInput` knows how to mutate — i.e. the set of
 *  editable manual inputs. Used by the Engine Preview to decide which source
 *  cells to make editable. */
export const EDITABLE_SOURCES: ReadonlySet<string> = new Set([
  'pricing_t', 'schedule_t', 'commission_t', 'employee_assumptions_t', 'employees_t',
  'sales_commission_overrides_t', 'modeller_commission_adjustments_t', 'revenue_adjustments_t',
  'hubspot_ta_rules_t', 'hubspot_pipeline_t', 'cost_line_items_t',
  'depreciation_t', 'rd_tax_credit_t', 'interest_income_t',
  'opening_bs_t', 'bs_assumptions_t', 'bs_monthly_schedule_t',
  'pnl_monthly_actuals_t', 'cost_dept_monthly_actuals_t', 'employee_adjustments_sparse_t',
  'bs_monthly_actuals_t', 'cost_line_actuals_t',
]);

// Tiny utility to keep CellValue narrowing local.
export type { CellValue };
