// Full v2 expression of the existing sales/cost/employee/budget model.
// Every value v1's `computeModel` produces should be reproducible by walking
// this DAG.
//
// Sources are mostly `manual` — they correspond to data the user edits in the
// React UI (pricing grid, schedule, employees, etc.) and are supplied at
// evaluation time via `flattenModelInput`. The calendar (`dates_t`) is
// **derived**: a `sequence` source produces month indices 0..71, and a
// `derive_dates` step uses Excel-style arithmetic (`floor(idx/12)`,
// `mod(idx,12)`, `concat(…)`) to compute the YYYY-MM string for each row.
// `year`/`month_num` are then derived inline via `year(date)`/`month(date)`
// wherever needed.
//
// Step naming convention:
//   <noun>_<grain>      e.g. `active_by_ta_type_month`
//   <noun>_monthly      single value per month
//   <noun>_yearly       single value per year
//
// All cell-level math uses engine expressions (col/lit/add/mul/iff/min/pow/…)
// so the Excel renderer can emit the same logic as formulas.

import {
  defineModel, manual, sequence, step, ops, agg,
  col, lit, add, sub, mul, div, lt, le, ge, eq, ne, and, or, iff, min as minFn, max as maxFn, pow,
  year, month, floor, mod, concat,
} from '../engine';
import { FLATTEN_SCHEMAS as S } from './flatten';

const START_YEAR = 2026;
const START_MONTH = 1;
const MONTHS = 72;

export const salesModel = defineModel({
  // Every monthly table — sources and step outputs — pivots on month_idx in
  // the explorer view. Tables without that column render as flat rows.
  defaultAxis: 'month_idx',

  sources: {
    month_indices: sequence({
      column: 'month_idx',
      count: MONTHS,
      description:
        'Calendar driver — generates rows with `month_idx` 0..71 for the modeling ' +
        'horizon. The `dates_t` calendar table is derived from this in the ' +
        '`derive_dates` step below.',
    }),
    pricing_t: manual({
      schema: S.pricing,
      defaults: [],
      description:
        'Per-trial-type pricing (sites, Bitfount license, model license, project ' +
        'fee, PM fee). Edited in the Pricing grid on the Revenue Model tab.',
    }),
    schedule_t: manual({
      schema: S.schedule,
      defaults: [],
      description:
        'New client starts per (therapeutic area × trial type × month). Edited ' +
        'cell-by-cell in the Revenue Model tab; one row per (TA, type, month).',
    }),
    hubspot_pipeline_t: manual({
      schema: S.hubspot_pipeline,
      defaults: [],
      description:
        'HubSpot pipeline value per (TA × line item × month). Editable on the HubSpot ' +
        'tab; refreshed in bulk via the HubSpot sync, which assigns each deal to a ' +
        'TA via `HubSpotSyncAssumptions.taAllocation` (regex rules on deal name + ' +
        'per-deal manual overrides). The `hubspot_pipeline` engine adapter ' +
        '(registered in `main.tsx`) can produce this table directly via ' +
        '`materializeApiSources` — see `evaluateSalesModelWithLiveHubSpot` in ' +
        '`evaluateSalesModel.ts`.',
    }),
    sales_commission_overrides_t: manual({
      schema: S.sales_commission_overrides,
      defaults: [],
      description:
        'Per-month override of the modelled sales commission. One row per month; ' +
        '`value=null` falls through to our `min(6k × starts + 12% × revenue, 1.5 × ' +
        'Total Sales Salary)` formula. Defaults reproduce v4\'s fully-hardcoded ' +
        'S&M Commission line (72 monthly values from costs_data.json).',
    }),
    modeller_commission_adjustments_t: manual({
      schema: S.modeller_commission_adjustments,
      defaults: [],
      description:
        'Sparse per-month additions to modelled modeller commission. Each row adds ' +
        'its `value` to the row-304 calculation for that month. Defaults reproduce ' +
        'v4\'s four hand-entered Jan/Feb/Mar/May 2026 historic commitments in ' +
        'Budgets!row 22 (which our `min(0.8 × AI revenue, $30k)` formula yields 0 ' +
        'for, since AI revenue starts later).',
    }),
    modeller_commission_adjustment_per_month_t: manual({
      schema: S.modeller_commission_adjustment_per_month,
      defaults: [],
      description:
        'Dense per-month sum of modeller_commission_adjustments_t. Built in ' +
        'flatten.ts so the engine left-join is keyed by month_idx alone. Internal — ' +
        'edits flow through the sparse table above.',
    }),
    revenue_adjustments_t: manual({
      schema: S.revenue_adjustments,
      defaults: [],
      description:
        'Sparse list of per-(TA, month) revenue adjustments. Each row adds its ' +
        '`value` on top of (modeled + HubSpot) for that TA × month. Editable on ' +
        'the Total Revenue tab; defaults reproduce v4\'s six 2026 Ophthalmology ' +
        'budget tweaks (Jan/Feb/Mar formula adds + Oct/Nov/Dec hardcoded values).',
    }),
    revenue_adjustment_per_ta_monthly_t: manual({
      schema: S.revenue_adjustment_per_ta_monthly,
      defaults: [],
      description:
        'Dense per-(ta, month_idx) aggregation of revenue_adjustments_t. Built ' +
        'in flatten.ts so the engine left-join is keyed by the same identity ' +
        'as ta_monthly_with_hubspot. Internal — edits flow through the sparse ' +
        'table above.',
    }),
    hubspot_ta_rules_t: manual({
      schema: S.hubspot_ta_rules,
      defaults: [],
      description:
        'HubSpot deal → TA allocation rules. Each row is a case-insensitive regex ' +
        'tested against the deal name; the first match wins. Edit on the HubSpot ' +
        'tab. Consumed by `resolveDealTA` at sync time (not by the engine), so ' +
        'changes only take effect on the next "Sync from HubSpot".',
    }),
    employees_t: manual({
      schema: S.employees,
      defaults: [],
      description:
        'Headcount roster: name, department, location, start date, base salary. ' +
        'Edited on the Employees tab.',
    }),
    employee_assumptions_t: manual({
      schema: S.employee_assumptions,
      defaults: [],
      description:
        'Single-row payroll assumptions: NI rate, pension rate, annual inflation ' +
        'rate, and the year/month inflation kicks in. Edited on the Employees tab.',
    }),
    commission_t: manual({
      schema: S.commission,
      defaults: [],
      description:
        'Single-row commission assumptions: modeller rate + per-TA monthly cap, ' +
        'sales commission per new client + invoice-rate fraction. Edited on the ' +
        'Revenue Model tab.',
    }),
    cost_line_items_t: manual({
      schema: S.cost_line_items,
      defaults: [],
      description:
        'Non-staff cost lines per (department × line × month). Edited on the ' +
        'Costs tab. Excludes S&M Commission — that line is replaced by the ' +
        'derived `sales_commission_monthly`.',
    }),
    depreciation_t: manual({
      schema: S.depreciation,
      defaults: [],
      description:
        'Capital depreciation per month. Booked below operating profit ' +
        '(operating_profit = ebitda − depreciation) to match v4\'s P&L ' +
        'layout. Also drives Tangible Assets writedown.',
    }),
    rd_tax_credit_t: manual({
      schema: S.rd_tax_credit,
      defaults: [],
      description:
        'R&D tax credit received per month (positive = credit). Added below ' +
        'operating profit: profit_after_tax = operating_profit + rd_credit. ' +
        'Defaults reproduce v4 ($437k 2026, $330k 2027, $330k 2028) smoothed ' +
        'evenly across each year.',
    }),
    dept_to_tab_t: manual({
      schema: S.dept_to_tab,
      defaults: [],
      description:
        'Mapping from Employees-tab department key → cost-tab department (S&M / ' +
        'G&A / Engineering / Product Support). Edited in the Costs section config.',
    }),
    opening_bs_t: manual({
      schema: S.opening_bs,
      defaults: [],
      description:
        'Opening balance sheet position (single row) — Cash, Tangible Assets, ' +
        'Trade Debtors/Creditors, Loans, Share Cap items, BFWD retained earnings. ' +
        'Defaults lifted from the v4 spreadsheet\'s "All In One" sheet (set in ' +
        'data.ts). Drives every derived balance sheet line; liabilities stored ' +
        'as negative numbers.',
    }),
    bs_assumptions_t: manual({
      schema: S.bs_assumptions,
      defaults: [],
      description:
        'Working-capital assumptions. `arDays` drives Trade Debtors via ' +
        '`revenue × ar_days / 30`. `apDays` and `monthlyLoanRepayment` are ' +
        'kept for legacy reference but are no longer consumed — the ' +
        '`bs_monthly_schedule_t` source below carries explicit per-month ' +
        'values for trade creditors and loan repayments.',
    }),
    bs_monthly_schedule_t: manual({
      schema: S.bs_monthly_schedule,
      defaults: [],
      description:
        'Per-month BS schedule: capex spent, loan principal repaid, and ' +
        'closing balances for Trade Creditors / Other Debtors / VAT / Other ' +
        'Creditors. Defaults refreshed from v4-model.xlsx (capex = Capital ' +
        'Purchases!row65; loan paydown clears the $217,680 BlueJay balance on ' +
        'v4\'s path — $23,640 in Jan-2026 then $12,000/mo Apr-2027→Jul-2028; ' +
        'WC lines from Budgets rows 73/74/78/80). Drives tangible-assets, ' +
        'loans, the four WC balances, and the cash waterfall — so editing any ' +
        'cell here flows into the BS.',
    }),
    employee_adjustments_sparse_t: manual({
      schema: S.employee_adjustments_sparse,
      defaults: [],
      description:
        'Sparse list of per-employee salary adjustments. Each row sets a ' +
        'multiplier on one employee\'s cleanly-computed monthly cost that ' +
        'applies from `month_idx` forward until a later row for the same ' +
        'employee overrides it. Used to reproduce v4\'s hand-edited per-cell ' +
        'multipliers (Naaman ×0.8 from Apr 2026, Blaise ×0.66 from Apr 2026 ' +
        'then ×2.8052 from Apr 2027). Editable in the Employees tab.',
    }),
    employee_factors_t: manual({
      schema: S.employee_factors,
      defaults: [],
      description:
        'Expanded per-(employee, month) factor table built by forward-filling ' +
        '`employee_adjustments_sparse_t`. Internal — drives the cost adjustment ' +
        'join below. Edits flow through the sparse table; this table is ' +
        'regenerated by flatten.ts.',
    }),
    pnl_monthly_actuals_t: manual({
      schema: S.pnl_monthly_actuals,
      defaults: [],
      description:
        'Per-month P&L override values (Revenue / Cost of Sales / Gross Profit / ' +
        'Total Opex / EBITDA). Any column that is null falls back to the modeled ' +
        'value; non-null values replace the modeled value in ' +
        'budget_monthly_with_actuals. Yearly P&L is summed from the overridden ' +
        'monthly table, never edited directly.',
    }),
    cost_dept_monthly_actuals_t: manual({
      schema: S.cost_dept_monthly_actuals,
      defaults: [],
      description:
        'Per-(cost_dept, month_idx) opex override values (staff / non_staff / total). ' +
        'Lets the user reconcile per-dept monthly costs (e.g. v4\'s G&A where ' +
        'manual ×0.66 multipliers and blank-formula cells diverge from our clean ' +
        'inflation model). Yearly per-dept totals derive from the overridden monthly.',
    }),
    bs_monthly_actuals_t: manual({
      schema: S.bs_monthly_actuals,
      defaults: [],
      description:
        'Per-month balance sheet override values. Yearly view picks end-of-year ' +
        '(December) months from the overridden monthly table.',
    }),
  },

  steps: [
    // ─── Calendar: derive YYYY-MM date strings from month_idx + start ───────
    step({
      id: 'derive_dates',
      name: 'Derive calendar dates from month_idx',
      description:
        `For each row in month_indices, compute date = YYYY-MM, starting ` +
        `${START_YEAR}-${String(START_MONTH).padStart(2, '0')}. ` +
        'year = start_year + floor(month_idx / 12); ' +
        'month_num = mod(month_idx, 12) + 1; ' +
        'date = year & "-" & (zero-padded month_num).',
      input: 'month_indices',
      op: ops.map({
        date: concat(
          add(lit(START_YEAR), floor(div(col('month_idx'), lit(12)))),
          lit('-'),
          // Zero-pad single-digit months: pad when (mod(month_idx, 12) + 1) < 10.
          iff(lt(mod(col('month_idx'), lit(12)), lit(9)), lit('0'), lit('')),
          add(mod(col('month_idx'), lit(12)), lit(1)),
        ),
      }),
      output: 'dates_t',
    }),

    // ─── Active trials per (TA, type, month) — rolling 12-month sum of starts ─
    // Window carries `starts` forward alongside the new `active` column so the
    // downstream join can compute project revenue from `starts`. The public
    // `active_by_ta_type_month` projects to just `active` for a clean view.
    step({
      id: 'active_by_ta_type_month_window',
      name: 'Active trials per TA × type × month (with starts carried through)',
      description:
        'For each (TA, type) partition, active[m] = sum of starts in months [m-11, m]. ' +
        'A trial is active for exactly 12 months from its start. Internal — kept ' +
        'around because the downstream join still needs `starts` to compute project revenue.',
      input: 'schedule_t',
      op: ops.window({
        partitionBy: ['ta', 'type'],
        orderBy: 'month_idx',
        range: { preceding: 11, following: 0 },
        derive: { active: agg.sum('starts') },
      }),
      output: 'active_by_ta_type_month_window',
    }),
    step({
      id: 'active_by_ta_type_month',
      name: 'Active trials per TA × type × month',
      description: 'Project the window output down to just the active count per (TA, type, month).',
      input: 'active_by_ta_type_month_window',
      op: ops.select(['ta', 'type', 'month_idx', 'active']),
      output: 'active_by_ta_type_month',
    }),

    // ─── Join with pricing to compute per-(TA, type, month) revenue lines ───
    step({
      id: 'active_with_pricing',
      name: 'Join active trials with pricing by type',
      description:
        'Attach Sites / Bitfount / Model / Project Fee / PM Fee columns to each row. ' +
        'Reads from the window output (with starts) so project revenue downstream can use `starts`.',
      input: 'active_by_ta_type_month_window',
      op: ops.join('pricing_t', [{ left: 'type', right: 'type' }], 'inner'),
      output: 'active_with_pricing',
    }),
    step({
      id: 'revenue_by_ta_type_month_raw',
      name: 'Per-TA × type × month revenue components (with inputs)',
      description:
        'platform = active × (bitfount + model) × sites / 12; project = starts × project_fee; ' +
        'pm = active × pm_fee. Internal — `revenue_by_ta_type_month` projects this down to revenue cols only.',
      input: 'active_with_pricing',
      op: ops.map({
        platform: div(mul(mul(col('active'), add(col('bitfount'), col('model'))), col('sites')), lit(12)),
        project: mul(col('starts'), col('project_fee')),
        pm: mul(col('active'), col('pm_fee')),
      }),
      output: 'revenue_by_ta_type_month_raw',
    }),
    step({
      id: 'revenue_by_ta_type_month',
      name: 'Per-TA × type × month revenue components',
      description: 'Drop the count + rate inputs so the published table is just the revenue numbers.',
      input: 'revenue_by_ta_type_month_raw',
      op: ops.select(['ta', 'type', 'month_idx', 'platform', 'project', 'pm']),
      output: 'revenue_by_ta_type_month',
    }),

    // ─── Roll up to per-TA per-month totals ─────────────────────────────────
    step({
      id: 'ta_monthly_components',
      name: 'Per-TA per-month revenue components (sum across types)',
      description: 'Sum the three revenue rows across Type A / B / C.',
      input: 'revenue_by_ta_type_month',
      op: ops.groupBy(['ta', 'month_idx'], {
        platform: agg.sum('platform'),
        project: agg.sum('project'),
        pm: agg.sum('pm'),
      }),
      output: 'ta_monthly_components',
    }),
    step({
      id: 'ta_monthly_total',
      name: 'Per-TA per-month total revenue',
      description: 'total = platform + project + pm.',
      input: 'ta_monthly_components',
      op: ops.map({ total: add(add(col('platform'), col('project')), col('pm')) }),
      output: 'ta_monthly_total',
    }),

    // ─── Modeled (cross-TA) totals per month ────────────────────────────────
    step({
      id: 'modeled_total_monthly',
      name: 'Modeled total revenue per month (sum across TAs)',
      description: 'Sum platform / project / pm / total across every TA, per month.',
      input: 'ta_monthly_total',
      op: ops.groupBy(['month_idx'], {
        platform: agg.sum('platform'),
        project: agg.sum('project'),
        pm: agg.sum('pm'),
        total: agg.sum('total'),
      }),
      output: 'modeled_total_monthly',
    }),

    // ─── HubSpot rollups ────────────────────────────────────────────────────
    // Pipeline rows are bucketed per (ta, line_item, month) at flatten time;
    // the deal-name regex rules in HubSpotSyncAssumptions.taAllocation decide
    // each deal's TA. From there:
    //   - hubspot_per_ta_monthly  → per-TA monthly totals (joined into the
    //                                per-TA revenue stack below)
    //   - hubspot_total_monthly   → cross-TA monthly total (the legacy view)
    step({
      id: 'hubspot_per_ta_monthly',
      name: 'HubSpot pipeline per TA × month',
      description: 'Sum HubSpot pipeline values per (TA, month).',
      input: 'hubspot_pipeline_t',
      op: ops.groupBy(['ta', 'month_idx'], { hubspot: agg.sum('value') }),
      output: 'hubspot_per_ta_monthly',
    }),
    step({
      id: 'hubspot_total_monthly',
      name: 'HubSpot pipeline total per month',
      description: 'Sum HubSpot line items per month (cross-TA total).',
      input: 'hubspot_pipeline_t',
      op: ops.groupBy(['month_idx'], { hubspot: agg.sum('value') }),
      output: 'hubspot_total_monthly',
    }),

    // Combine modeled per-TA totals with the HubSpot-per-TA bucket. Each TA's
    // row now carries `total_modeled` (platform + project + pm) and `hubspot`
    // (allocated HubSpot pipeline); `total` is the sum. Downstream
    // ta_monthly_total stays purely modeled (some views want the clean split).
    step({
      id: 'ta_monthly_total_joined_hubspot',
      name: 'Join per-TA modeled total with per-TA HubSpot',
      description: 'Left join ta_monthly_total with hubspot_per_ta_monthly on (ta, month_idx).',
      input: 'ta_monthly_total',
      op: ops.join(
        'hubspot_per_ta_monthly',
        [{ left: 'ta', right: 'ta' }, { left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'ta_monthly_total_joined_hubspot',
    }),
    step({
      id: 'ta_monthly_with_hubspot_pre_adj',
      name: 'Per-TA per-month revenue (modeled + HubSpot, pre-adjustment)',
      description:
        'For each (TA, month) row: total_modeled = modeled total; hubspot = ' +
        'allocated HubSpot pipeline (0 when no rule matched a deal for this TA).',
      input: 'ta_monthly_total_joined_hubspot',
      op: ops.map({
        total_modeled: col('total'),
        hubspot: iff(eq(col('hubspot'), lit(null)), lit(0), col('hubspot')),
      }),
      output: 'ta_monthly_with_hubspot_pre_adj',
    }),
    step({
      id: 'ta_monthly_with_adjustment',
      name: 'Join per-TA revenue with manual adjustments',
      description: 'Left join the pre-adjustment per-TA table with the dense per-(ta, month) adjustment values.',
      input: 'ta_monthly_with_hubspot_pre_adj',
      op: ops.join(
        'revenue_adjustment_per_ta_monthly_t',
        [{ left: 'ta', right: 'ta' }, { left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'ta_monthly_with_adjustment',
    }),
    step({
      id: 'ta_monthly_with_hubspot',
      name: 'Per-TA per-month revenue (modeled + HubSpot + adjustments)',
      description:
        'adjustment = sum of all matching revenue_adjustments_t rows (default 0 ' +
        'when no entry). total = total_modeled + hubspot + adjustment. Drives ' +
        'the per-TA view that mirrors v4\'s Budgets-sheet per-TA lines exactly ' +
        '— v4\'s six 2026 Ophthalmology budget tweaks ship as defaults.',
      input: 'ta_monthly_with_adjustment',
      op: ops.map({
        adjustment: iff(eq(col('adjustment'), lit(null)), lit(0), col('adjustment')),
        total: add(
          add(col('total_modeled'), col('hubspot')),
          iff(eq(col('adjustment'), lit(null)), lit(0), col('adjustment')),
        ),
      }),
      output: 'ta_monthly_with_hubspot',
    }),

    step({
      id: 'modeled_with_hubspot',
      name: 'Join modeled and HubSpot totals',
      description: 'Combine into a single row per month with both totals.',
      input: 'modeled_total_monthly',
      op: ops.join('hubspot_total_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'modeled_with_hubspot',
    }),
    step({
      id: 'revenue_adjustment_monthly',
      name: 'Total revenue adjustment per month (cross-TA)',
      description: 'Sum per-(TA, month) revenue adjustments across all TAs, giving one row per month.',
      input: 'revenue_adjustment_per_ta_monthly_t',
      op: ops.groupBy(['month_idx'], { adjustment: agg.sum('adjustment') }),
      output: 'revenue_adjustment_monthly',
    }),
    step({
      id: 'modeled_with_hubspot_with_adjustment',
      name: 'Join modeled + HubSpot totals with revenue adjustment',
      description: 'Left join so months without any adjustment row pick up `adjustment = null` (treated as 0 downstream).',
      input: 'modeled_with_hubspot',
      op: ops.join(
        'revenue_adjustment_monthly',
        [{ left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'modeled_with_hubspot_with_adjustment',
    }),
    step({
      id: 'revenue_monthly',
      name: 'Total revenue per month',
      description:
        'revenue = modeled total + hubspot pipeline + sum of per-TA revenue ' +
        'adjustments. Defaults reproduce v4\'s six 2026 Ophthalmology budget ' +
        'tweaks, closing the previously-documented $217,998 gap in 2026.',
      input: 'modeled_with_hubspot_with_adjustment',
      op: ops.map({
        modeled_revenue: col('total'),
        revenue: add(
          add(
            col('total'),
            iff(eq(col('hubspot'), lit(null)), lit(0), col('hubspot')),
          ),
          iff(eq(col('adjustment'), lit(null)), lit(0), col('adjustment')),
        ),
      }),
      output: 'revenue_monthly',
    }),

    // ─── Modeller commission per TA per month (with cap) ────────────────────
    step({
      id: 'model_revenue_by_ta_type_month_raw',
      name: 'Model-license-only revenue per TA × type × month (with inputs)',
      description:
        'model_rev = active × model × sites / 12 — the commissionable portion. ' +
        'Internal — projected down to just the revenue number in the next step.',
      input: 'active_with_pricing',
      op: ops.map({ model_rev: div(mul(mul(col('active'), col('model')), col('sites')), lit(12)) }),
      output: 'model_revenue_by_ta_type_month_raw',
    }),
    step({
      id: 'model_revenue_by_ta_type_month',
      name: 'Model-license-only revenue per TA × type × month',
      description: 'Drop the count + rate inputs so the published table is just the revenue number.',
      input: 'model_revenue_by_ta_type_month_raw',
      op: ops.select(['ta', 'type', 'month_idx', 'model_rev']),
      output: 'model_revenue_by_ta_type_month',
    }),
    step({
      id: 'model_revenue_by_ta_month',
      name: 'Model revenue per TA × month (sum across types)',
      description: 'Per-TA commissionable revenue per month.',
      input: 'model_revenue_by_ta_type_month',
      op: ops.groupBy(['ta', 'month_idx'], { model_rev: agg.sum('model_rev') }),
      output: 'model_revenue_by_ta_month',
    }),
    step({
      id: 'modeller_commission_per_ta_with_params',
      name: 'Attach commission params (rate, cap) to each TA × month row',
      description: 'Cross-join with the single-row commission table.',
      input: 'model_revenue_by_ta_month',
      op: ops.cross('commission_t'),
      output: 'modeller_commission_per_ta_with_params',
    }),
    step({
      id: 'modeller_commission_per_ta_monthly',
      name: 'Modeller commission per TA per month',
      description: 'commission = min(rate × model_rev, cap_per_month) — capped per TA per month.',
      input: 'modeller_commission_per_ta_with_params',
      op: ops.map({
        commission: minFn(mul(col('rate'), col('model_rev')), col('cap_per_month')),
      }),
      output: 'modeller_commission_per_ta_monthly',
    }),
    step({
      id: 'modeller_commission_modeled_monthly',
      name: 'Modelled modeller commission per month (pre-adjustment)',
      description: 'Sum per-TA modeller commission across all TAs.',
      input: 'modeller_commission_per_ta_monthly',
      op: ops.groupBy(['month_idx'], { modeller_commission: agg.sum('commission') }),
      output: 'modeller_commission_modeled_monthly',
    }),
    step({
      id: 'modeller_commission_joined_adjustment',
      name: 'Join modelled modeller commission with manual adjustments',
      description: 'Left join on month_idx; months without an adjustment get null (treated as 0 below).',
      input: 'modeller_commission_modeled_monthly',
      op: ops.join(
        'modeller_commission_adjustment_per_month_t',
        [{ left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'modeller_commission_joined_adjustment',
    }),
    step({
      id: 'modeller_commission_monthly',
      name: 'Total modeller commission per month (with adjustments)',
      description:
        'modeller_commission = modelled (row-304 equivalent: sum of per-TA `min(0.8 × ' +
        'AI revenue, $30k)` cap) + manual adjustment. Defaults reproduce v4\'s four ' +
        'Jan/Feb/Mar/May 2026 historic-commitment entries in Budgets!row 22 so the ' +
        'cost-of-sales line in our Budget P&L matches v4 to the cent.',
      input: 'modeller_commission_joined_adjustment',
      op: ops.map({
        modeller_commission: add(
          col('modeller_commission'),
          iff(eq(col('adjustment'), lit(null)), lit(0), col('adjustment')),
        ),
      }),
      output: 'modeller_commission_monthly',
    }),

    // ─── Sales commission per month ─────────────────────────────────────────
    step({
      id: 'starts_per_month',
      name: 'Total new clients per month (across TAs and types)',
      description: 'Sum schedule.starts across all TAs and types per month.',
      input: 'schedule_t',
      op: ops.groupBy(['month_idx'], { total_starts: agg.sum('starts') }),
      output: 'starts_per_month',
    }),
    step({
      id: 'starts_with_revenue',
      name: 'Join total starts with monthly revenue',
      description: 'Both inputs are keyed by month_idx.',
      input: 'starts_per_month',
      op: ops.join('revenue_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'starts_with_revenue',
    }),
    step({
      id: 'starts_with_revenue_and_commission',
      name: 'Attach commission params per month',
      description: 'Cross-join with the single-row commission table to access rates.',
      input: 'starts_with_revenue',
      op: ops.cross('commission_t'),
      output: 'starts_with_revenue_and_commission',
    }),
    step({
      id: 'sales_commission_uncapped_monthly',
      name: 'Sales commission per month (uncapped)',
      description:
        'Raw commission before applying the salary cap: ' +
        'sales_per_client × total_starts + sales_invoice_rate × revenue. ' +
        'Capped at 1.5 × Total Sales Salary downstream in sales_commission_monthly ' +
        'so the line tracks v4\'s `MIN(6k×starts + 12%×revenue, 1.5×sales_salary)` rule.',
      input: 'starts_with_revenue_and_commission',
      op: ops.map({
        sales_commission_uncapped:
          add(
            mul(col('sales_per_client'), col('total_starts')),
            mul(col('sales_invoice_rate'), col('revenue')),
          ),
      }),
      output: 'sales_commission_uncapped_monthly',
    }),

    // ─── Per-employee monthly cost (loaded salary × inflation factor) ───────
    step({
      id: 'employees_cross_dates',
      name: 'Cross-join employees with dates',
      description: 'One row per (employee, month) before computing per-month cost.',
      input: 'employees_t',
      op: ops.cross('dates_t'),
      output: 'employees_cross_dates',
    }),
    step({
      id: 'employees_with_params',
      name: 'Cross-join with employee assumptions',
      description: 'Attach NI rate, pension rate, inflation rate, inflation start year/month.',
      input: 'employees_cross_dates',
      op: ops.cross('employee_assumptions_t'),
      output: 'employees_with_params',
    }),
    step({
      id: 'employees_with_date_parts',
      name: 'Derive year_n and month_n from the date column',
      description:
        'year_n = YEAR(date), month_n = MONTH(date). Pulled out so the ' +
        'inflation comparison below can reference them without re-parsing.',
      input: 'employees_with_params',
      op: ops.map({
        year_n: year(col('date')),
        month_n: month(col('date')),
      }),
      output: 'employees_with_date_parts',
    }),
    step({
      id: 'per_employee_monthly',
      name: 'Per-employee monthly cost',
      description:
        'active = (start_date == "Current" OR date >= start_date) AND date <= end_date. ' +
        'end_date defaults to "9999-12" in flatten, so employees without an explicit ' +
        'departure run the full horizon. ' +
        'inflation_steps = min(maxInflationSteps, (year_n - startY) + (month_n >= startM ? 1 : 0)), ' +
        'zeroed before the inflation start. With inflateFutureHires=false ' +
        'the steps are forced to 0 for any employee whose start_date is not "Current" ' +
        '— this reproduces a v4 spreadsheet bug. ' +
        'cost = active × salary × (1 + NI + pension) / 12 × pow(1 + inflation_rate, steps).',
      input: 'employees_with_date_parts',
      op: ops.map({
        active: iff(
          and(
            or(eq(col('start_date'), lit('Current')), ge(col('date'), col('start_date'))),
            le(col('date'), col('end_date')),
          ),
          lit(1),
          lit(0),
        ),
        // Raw step count: years since inflation_start_year + bump in start_month.
        inflation_steps_raw: iff(
          or(
            and(eq(col('year_n'), col('inflation_start_year')), lt(col('month_n'), col('inflation_start_month'))),
            lt(col('year_n'), col('inflation_start_year')),
          ),
          lit(0),
          add(
            sub(col('year_n'), col('inflation_start_year')),
            iff(ge(col('month_n'), col('inflation_start_month')), lit(1), lit(0)),
          ),
        ),
      }),
      output: 'per_employee_monthly_intermediate',
    }),
    step({
      id: 'per_employee_monthly_steps_capped',
      name: 'Apply v4 inflation bugs (cap + future-hire zero)',
      description:
        'inflation_steps = min(inflation_steps_raw, max_inflation_steps), then forced to 0 ' +
        'for any employee whose start_date is not "Current" when inflate_future_hires=false. ' +
        'Reproduces the v4 Employees-sheet behaviour exactly.',
      input: 'per_employee_monthly_intermediate',
      op: ops.map({
        inflation_steps: iff(
          and(
            ne(col('start_date'), lit('Current')),
            eq(col('inflate_future_hires'), lit(false)),
          ),
          lit(0),
          minFn(col('inflation_steps_raw'), col('max_inflation_steps')),
        ),
      }),
      output: 'per_employee_monthly_intermediate_capped',
    }),
    step({
      id: 'per_employee_monthly_cost',
      name: 'Per-employee monthly cost (final)',
      description:
        'Apply loaded-salary + inflation to the active flag. Zero for months before the employee started.',
      input: 'per_employee_monthly_intermediate_capped',
      op: ops.map({
        cost: mul(
          mul(
            col('active'),
            div(mul(col('salary'), add(lit(1), add(col('ni_rate'), col('pension_rate')))), lit(12)),
          ),
          pow(add(lit(1), col('inflation_rate')), col('inflation_steps')),
        ),
      }),
      output: 'per_employee_monthly_cost_raw',
    }),
    // Apply per-(employee, month) salary adjustment factors. The expanded
    // factor table has one row per (employee_id, month_idx) where an
    // adjustment applies; everywhere else the factor is null → cost passes
    // through unchanged.
    step({
      id: 'per_employee_monthly_cost_join_factor',
      name: 'Attach per-month salary adjustment factor',
      description:
        'Left join per_employee_monthly_cost_raw with employee_factors_t on ' +
        '(id, month_idx). Rows without an adjustment get factor=null.',
      input: 'per_employee_monthly_cost_raw',
      op: ops.join(
        'employee_factors_t',
        [{ left: 'id', right: 'employee_id' }, { left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'per_employee_with_factor',
    }),
    step({
      id: 'per_employee_monthly_cost',
      name: 'Per-employee monthly cost (final, with adjustments)',
      description:
        'cost = raw cost × (factor or 1). Used by every downstream per-dept ' +
        'rollup so adjustments flow through to the P&L automatically.',
      input: 'per_employee_with_factor',
      op: ops.map({
        cost: mul(
          col('cost'),
          iff(eq(col('factor'), lit(null)), lit(1), col('factor')),
        ),
      }),
      output: 'per_employee_monthly_cost',
    }),

    // ─── Sales-commission salary cap ────────────────────────────────────────
    // Sum the monthly cost of the sales-cap-eligible employees (Sales Director,
    // Sales Manager, Marketing, Enterprise Sales Managers, Therapeutic Sales
    // Managers — see `salesCapEligible` in employees_data.json). Multiplied by
    // 1.5 this gives v4's `Total Sales Salary × 1.5` cap; sales_commission_monthly
    // applies `MIN(uncapped, cap)`.
    step({
      id: 'sales_cap_eligible_monthly',
      name: 'Filter per-employee cost to sales-cap-eligible employees',
      description: 'Keep only rows where the employee is flagged as salesCapEligible.',
      input: 'per_employee_monthly_cost',
      op: ops.filter(eq(col('sales_cap_eligible'), lit(true))),
      output: 'sales_cap_eligible_monthly',
    }),
    step({
      id: 'sales_cap_base_monthly',
      name: 'Sales-cap base per month',
      description: 'Sum cost of cap-eligible employees per month → "Total Sales Salary" in v4.',
      input: 'sales_cap_eligible_monthly',
      op: ops.groupBy(['month_idx'], { sales_cap_base: agg.sum('cost') }),
      output: 'sales_cap_base_monthly',
    }),
    step({
      id: 'sales_commission_with_cap',
      name: 'Join uncapped sales commission with cap base',
      description: 'Inner join on month_idx; both have one row per month.',
      input: 'sales_commission_uncapped_monthly',
      op: ops.join(
        'sales_cap_base_monthly',
        [{ left: 'month_idx', right: 'month_idx' }],
        'inner',
      ),
      output: 'sales_commission_with_cap',
    }),
    step({
      id: 'sales_commission_modeled_monthly',
      name: 'Sales commission per month (modelled, capped)',
      description:
        'sales_commission_modeled = MIN(sales_commission_uncapped, 1.5 × sales_cap_base). ' +
        'Reproduces v4\'s intended formula `MIN(6k×starts + 12%×revenue, ' +
        '1.5×SUM(Employees!L11:L19))`. Overridden by ' +
        'sales_commission_monthly downstream — v4\'s actual S&M Commission ' +
        'line is fully hardcoded and doesn\'t follow this formula in later years.',
      input: 'sales_commission_with_cap',
      op: ops.map({
        sales_commission_modeled: minFn(
          col('sales_commission_uncapped'),
          mul(lit(1.5), col('sales_cap_base')),
        ),
      }),
      output: 'sales_commission_modeled_monthly',
    }),
    step({
      id: 'sales_commission_joined_override',
      name: 'Join modelled sales commission with overrides',
      description: 'Left join on month_idx; rows without an override get value=null.',
      input: 'sales_commission_modeled_monthly',
      op: ops.join(
        'sales_commission_overrides_t',
        [{ left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'sales_commission_joined_override',
    }),
    step({
      id: 'sales_commission_monthly',
      name: 'Sales commission per month (override or modelled)',
      description:
        'sales_commission = override `value` if non-null, otherwise the modelled ' +
        'value. Defaults populate every month with v4\'s hardcoded value from ' +
        'costs_data.json so we match v4\'s S&M Commission line to the cent out of ' +
        'the box. Edit any cell to use a different value; set to blank to fall ' +
        'back to the modelled formula. Booked to the Sales & Marketing dept as a ' +
        'derived cost line.',
      input: 'sales_commission_joined_override',
      op: ops.map({
        sales_commission: iff(
          eq(col('value'), lit(null)),
          col('sales_commission_modeled'),
          col('value'),
        ),
      }),
      output: 'sales_commission_monthly',
    }),

    // ─── Per-dept (employee-side) per-month cost ────────────────────────────
    step({
      id: 'employee_dept_monthly',
      name: 'Employee cost per (employee_dept, month)',
      description: 'Sum per-employee cost grouped by the employee\'s declared department.',
      input: 'per_employee_monthly_cost',
      op: ops.groupBy(['department', 'month_idx'], { staff: agg.sum('cost') }),
      output: 'employee_dept_monthly',
    }),
    step({
      id: 'employee_dept_monthly_total',
      name: 'Total employee cost per month',
      description: 'Sum across departments.',
      input: 'employee_dept_monthly',
      op: ops.groupBy(['month_idx'], { staff: agg.sum('staff') }),
      output: 'employee_total_monthly',
    }),

    // ─── Per-cost-dept staff cost (via dept_to_tab mapping) ─────────────────
    step({
      id: 'employee_dept_to_cost_dept',
      name: 'Map employee department to cost department',
      description: 'Join employee per-dept costs with the dept_to_tab mapping.',
      input: 'employee_dept_monthly',
      op: ops.join('dept_to_tab_t', [{ left: 'department', right: 'employee_dept' }], 'inner'),
      output: 'employee_dept_to_cost_dept',
    }),
    step({
      id: 'cost_dept_staff_monthly',
      name: 'Staff cost per cost-dept × month',
      description: 'Aggregate by cost_dept (S&M / G&A / Engineering / Product Support).',
      input: 'employee_dept_to_cost_dept',
      op: ops.groupBy(['cost_dept', 'month_idx'], { staff: agg.sum('staff') }),
      output: 'cost_dept_staff_monthly',
    }),

    // ─── Cost line items per cost-dept × month ──────────────────────────────
    step({
      id: 'cost_line_items_dept_monthly',
      name: 'Non-staff line items per cost-dept × month',
      description: 'Sum static line items (excluding S&M Commission, replaced by derived sales commission).',
      input: 'cost_line_items_t',
      op: ops.groupBy(['dept', 'month_idx'], { non_staff: agg.sum('value') }),
      output: 'cost_line_items_dept_monthly',
    }),

    // ─── Per-cost-dept total cost (staff + non-staff + derived sales comm) ──
    step({
      id: 'cost_dept_staff_and_line',
      name: 'Join staff cost with non-staff line items per cost-dept × month',
      description: 'Left-join so depts without staff (rare) still appear.',
      input: 'cost_dept_staff_monthly',
      op: ops.join(
        'cost_line_items_dept_monthly',
        [{ left: 'cost_dept', right: 'dept' }, { left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'cost_dept_staff_and_line',
    }),
    step({
      id: 'cost_dept_with_sales_commission',
      name: 'Attach derived sales commission to S&M rows',
      description: 'Left-join to sales_commission_monthly on month; only S&M rows pick up a non-null value.',
      input: 'cost_dept_staff_and_line',
      op: ops.join(
        'sales_commission_monthly',
        [{ left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'cost_dept_with_sales_commission',
    }),
    step({
      id: 'cost_dept_total_monthly',
      name: 'Total cost per cost-dept × month',
      description:
        'total = staff + non_staff + (sales_commission if cost_dept = "Sales and Marketing" else 0).',
      input: 'cost_dept_with_sales_commission',
      op: ops.map({
        non_staff: iff(eq(col('non_staff'), lit(null)), lit(0), col('non_staff')),
        derived: iff(
          eq(col('cost_dept'), lit('Sales and Marketing')),
          iff(eq(col('sales_commission'), lit(null)), lit(0), col('sales_commission')),
          lit(0),
        ),
        total: add(
          add(
            col('staff'),
            iff(eq(col('non_staff'), lit(null)), lit(0), col('non_staff')),
          ),
          iff(
            eq(col('cost_dept'), lit('Sales and Marketing')),
            iff(eq(col('sales_commission'), lit(null)), lit(0), col('sales_commission')),
            lit(0),
          ),
        ),
      }),
      output: 'cost_dept_total_monthly',
    }),

    // ─── Total opex per month ───────────────────────────────────────────────
    // ─── Per-dept actuals overlay (moved here so total_opex_monthly picks up
    // the override values and they flow through to Budget P&L and EBITDA).
    step({
      id: 'cost_dept_total_monthly_joined_actuals',
      name: 'Join per-dept monthly opex with actuals overrides',
      description: 'Left join cost_dept_total_monthly with cost_dept_monthly_actuals_t on (cost_dept, month_idx).',
      input: 'cost_dept_total_monthly',
      op: ops.join(
        'cost_dept_monthly_actuals_t',
        [{ left: 'cost_dept', right: 'cost_dept' }, { left: 'month_idx', right: 'month_idx' }],
        'left',
      ),
      output: 'cost_dept_total_monthly_joined_actuals',
    }),
    step({
      id: 'cost_dept_total_monthly_with_actuals',
      name: 'Per-dept monthly opex with actuals overlay',
      description:
        'staff / non_staff use the override if set, modeled otherwise. ' +
        'total uses total_actual if set; otherwise it recomputes as ' +
        '(overridden staff) + (overridden non_staff) + (modeled derived). ' +
        'Default G&A staff actuals for Jan/Feb/Mar 2026 reproduce v4\'s ' +
        'manual Salaries adjustments (`=Employees!L51-2642` etc.) so Total ' +
        'Opex and EBITDA roll up to v4\'s yearly numbers exactly.',
      input: 'cost_dept_total_monthly_joined_actuals',
      op: ops.map({
        staff: iff(eq(col('staff_actual'), lit(null)), col('staff'), col('staff_actual')),
        non_staff: iff(eq(col('non_staff_actual'), lit(null)), col('non_staff'), col('non_staff_actual')),
        total: iff(
          eq(col('total_actual'), lit(null)),
          add(
            add(
              iff(eq(col('staff_actual'), lit(null)), col('staff'), col('staff_actual')),
              iff(eq(col('non_staff_actual'), lit(null)), col('non_staff'), col('non_staff_actual')),
            ),
            col('derived'),
          ),
          col('total_actual'),
        ),
      }),
      output: 'cost_dept_total_monthly_with_actuals',
    }),
    step({
      id: 'total_opex_monthly',
      name: 'Total opex per month (with per-dept actuals)',
      description: 'Sum total cost across all four departments — reads from the actuals-overridden table.',
      input: 'cost_dept_total_monthly_with_actuals',
      op: ops.groupBy(['month_idx'], { total_opex: agg.sum('total') }),
      output: 'total_opex_monthly',
    }),

    // ─── Cost of sales + gross profit + EBITDA per month ────────────────────
    step({
      id: 'rev_with_modeller_commission',
      name: 'Join revenue with modeller commission per month',
      description: 'Inner join on month_idx; both have one row per month.',
      input: 'revenue_monthly',
      op: ops.join('modeller_commission_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'rev_with_modeller_commission',
    }),
    step({
      id: 'budget_with_cos_gp',
      name: 'Cost of sales + gross profit per month',
      description:
        'cost_of_sales = modeller_commission; gross_profit = revenue - cost_of_sales. ' +
        'Depreciation is booked below EBITDA (operating_profit step) rather than ' +
        'inside COGS — matches v4\'s Budgets-sheet layout.',
      input: 'rev_with_modeller_commission',
      op: ops.map({
        modeller_commission: iff(eq(col('modeller_commission'), lit(null)), lit(0), col('modeller_commission')),
        cost_of_sales: iff(eq(col('modeller_commission'), lit(null)), lit(0), col('modeller_commission')),
        gross_profit: sub(
          col('revenue'),
          iff(eq(col('modeller_commission'), lit(null)), lit(0), col('modeller_commission')),
        ),
      }),
      output: 'budget_with_cos_gp',
    }),
    step({
      id: 'budget_with_opex',
      name: 'Join with total opex per month',
      description: 'Bring opex onto the same row to compute EBITDA.',
      input: 'budget_with_cos_gp',
      op: ops.join('total_opex_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'budget_with_opex',
    }),
    step({
      id: 'budget_monthly',
      name: 'Monthly P&L (with EBITDA)',
      description: 'EBITDA = gross_profit - total_opex.',
      input: 'budget_with_opex',
      op: ops.map({
        total_opex: iff(eq(col('total_opex'), lit(null)), lit(0), col('total_opex')),
        ebitda: sub(
          col('gross_profit'),
          iff(eq(col('total_opex'), lit(null)), lit(0), col('total_opex')),
        ),
      }),
      output: 'budget_monthly',
    }),

    // ─── Yearly rollups ─────────────────────────────────────────────────────
    step({
      id: 'budget_with_dates',
      name: 'Attach calendar date to monthly P&L',
      description: 'Join with dates_t to bring the YYYY-MM date string onto each row.',
      input: 'budget_monthly',
      op: ops.join('dates_t', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'budget_with_dates',
    }),
    step({
      id: 'budget_with_year',
      name: 'Derive calendar year via YEAR(date)',
      description: 'year = YEAR(date) so the next step can group by calendar year.',
      input: 'budget_with_dates',
      op: ops.map({ year: year(col('date')) }),
      output: 'budget_with_year',
    }),
    // ─── Actuals overlay: monthly P&L ───────────────────────────────────────
    // Override at the leaf monthly level, then roll up. The yearly view is
    // always derived from the overridden monthly so the two stay consistent.
    step({
      id: 'budget_monthly_joined_actuals',
      name: 'Join monthly P&L with actuals overrides',
      description: 'Left join budget_monthly with pnl_monthly_actuals_t on month_idx.',
      input: 'budget_monthly',
      op: ops.join('pnl_monthly_actuals_t', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'budget_monthly_joined_actuals',
    }),
    step({
      id: 'budget_monthly_with_actuals',
      name: 'Monthly P&L with actuals overlay',
      description:
        'For each metric, use the override if provided; otherwise the modeled value. ' +
        'Subtotals cascade: gross_profit auto-recomputes from overridden revenue − cost_of_sales ' +
        'when gross_profit_actual is blank; ebitda auto-recomputes from gross_profit − ' +
        'total_opex when ebitda_actual is blank. Pinning revenue alone therefore flows ' +
        'through to gross_profit and ebitda automatically; pinning ebitda directly ' +
        'fixes it independent of the inputs. Yearly P&L sums these overridden monthly values.',
      input: 'budget_monthly_joined_actuals',
      op: ops.map({
        revenue: iff(eq(col('revenue_actual'), lit(null)), col('revenue'), col('revenue_actual')),
        cost_of_sales: iff(eq(col('cost_of_sales_actual'), lit(null)), col('cost_of_sales'), col('cost_of_sales_actual')),
        gross_profit: iff(
          eq(col('gross_profit_actual'), lit(null)),
          sub(
            iff(eq(col('revenue_actual'), lit(null)), col('revenue'), col('revenue_actual')),
            iff(eq(col('cost_of_sales_actual'), lit(null)), col('cost_of_sales'), col('cost_of_sales_actual')),
          ),
          col('gross_profit_actual'),
        ),
        total_opex: iff(eq(col('total_opex_actual'), lit(null)), col('total_opex'), col('total_opex_actual')),
        ebitda: iff(
          eq(col('ebitda_actual'), lit(null)),
          sub(
            iff(
              eq(col('gross_profit_actual'), lit(null)),
              sub(
                iff(eq(col('revenue_actual'), lit(null)), col('revenue'), col('revenue_actual')),
                iff(eq(col('cost_of_sales_actual'), lit(null)), col('cost_of_sales'), col('cost_of_sales_actual')),
              ),
              col('gross_profit_actual'),
            ),
            iff(eq(col('total_opex_actual'), lit(null)), col('total_opex'), col('total_opex_actual')),
          ),
          col('ebitda_actual'),
        ),
      }),
      output: 'budget_monthly_with_actuals',
    }),

    // ─── Below EBITDA: operating profit + R&D tax credit + profit after tax ─
    // Match v4's P&L layout: depreciation sits below EBITDA, then the R&D tax
    // credit is added on top of operating profit to get profit after tax. The
    // remaining v4 P&L lines (other income / interest / corp tax) are zero or
    // immaterial in the forecast — see the report section for the breakdown.
    step({
      id: 'budget_with_dep_join',
      name: 'Join overridden monthly P&L with depreciation',
      description: 'Bring per-month depreciation onto each row to compute operating_profit.',
      input: 'budget_monthly_with_actuals',
      op: ops.join('depreciation_t', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'budget_with_dep_join',
    }),
    step({
      id: 'budget_with_dep_renamed',
      name: 'Rename depreciation `value` column',
      description: 'Rename to depreciation_value so the next join with rd_tax_credit_t (also has `value`) does not collide.',
      input: 'budget_with_dep_join',
      op: ops.rename({ value: 'depreciation_value' }),
      output: 'budget_with_dep_renamed',
    }),
    step({
      id: 'budget_with_rd_credit_join',
      name: 'Join with R&D tax credit per month',
      description: 'Bring per-month R&D credit onto each row to compute profit_after_tax.',
      input: 'budget_with_dep_renamed',
      op: ops.join('rd_tax_credit_t', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'budget_with_rd_credit_join',
    }),
    step({
      id: 'budget_monthly_full_pl',
      name: 'Monthly P&L (with operating profit + profit after tax)',
      description:
        'depreciation = depreciation_t.value (null → 0); ' +
        'operating_profit = ebitda - depreciation; ' +
        'rd_tax_credit = rd_tax_credit_t.value (null → 0); ' +
        'profit_after_tax = operating_profit + rd_tax_credit. ' +
        'EBITDA above is the actuals-overridden value, so any pinned EBITDA ' +
        'flows through to operating_profit and profit_after_tax automatically.',
      input: 'budget_with_rd_credit_join',
      op: ops.map({
        depreciation: iff(eq(col('depreciation_value'), lit(null)), lit(0), col('depreciation_value')),
        operating_profit: sub(
          col('ebitda'),
          iff(eq(col('depreciation_value'), lit(null)), lit(0), col('depreciation_value')),
        ),
        rd_tax_credit: iff(eq(col('value'), lit(null)), lit(0), col('value')),
        profit_after_tax: add(
          sub(
            col('ebitda'),
            iff(eq(col('depreciation_value'), lit(null)), lit(0), col('depreciation_value')),
          ),
          iff(eq(col('value'), lit(null)), lit(0), col('value')),
        ),
      }),
      output: 'budget_monthly_full_pl',
    }),

    // Yearly P&L is now derived from the overridden monthly — no separate yearly input.
    step({
      id: 'budget_with_actuals_dates',
      name: 'Attach calendar date to overridden monthly P&L',
      description: 'Join with dates_t to bring date onto each overridden row.',
      input: 'budget_monthly_full_pl',
      op: ops.join('dates_t', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'budget_with_actuals_dates',
    }),
    step({
      id: 'budget_with_actuals_year',
      name: 'Derive calendar year on overridden monthly P&L',
      description: 'year = YEAR(date).',
      input: 'budget_with_actuals_dates',
      op: ops.map({ year: year(col('date')) }),
      output: 'budget_with_actuals_year',
    }),
    step({
      id: 'budget_yearly',
      name: 'Yearly P&L (derived from overridden monthly)',
      description:
        'Sum revenue / cost_of_sales / gross_profit / total_opex / ebitda / ' +
        'depreciation / operating_profit / rd_tax_credit / profit_after_tax by ' +
        'calendar year from the overridden monthly table. Any month-level ' +
        'override flows up here.',
      input: 'budget_with_actuals_year',
      op: ops.groupBy(['year'], {
        revenue: agg.sum('revenue'),
        cost_of_sales: agg.sum('cost_of_sales'),
        gross_profit: agg.sum('gross_profit'),
        total_opex: agg.sum('total_opex'),
        ebitda: agg.sum('ebitda'),
        depreciation: agg.sum('depreciation'),
        operating_profit: agg.sum('operating_profit'),
        rd_tax_credit: agg.sum('rd_tax_credit'),
        profit_after_tax: agg.sum('profit_after_tax'),
      }),
      output: 'budget_yearly',
    }),

    // ─── Per-dept actuals overlay: now defined above (before total_opex_monthly)
    // so the overrides flow into Total Opex and EBITDA. The yearly rollups
    // below still use the same `cost_dept_total_monthly_with_actuals` table.
    step({
      id: 'cost_dept_with_actuals_dates',
      name: 'Attach calendar date to overridden per-dept monthly',
      description: 'Join with dates_t to bring the YYYY-MM date string onto each row.',
      input: 'cost_dept_total_monthly_with_actuals',
      op: ops.join('dates_t', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cost_dept_with_actuals_dates',
    }),
    step({
      id: 'cost_dept_with_actuals_year',
      name: 'Derive calendar year for per-dept monthly',
      description: 'year = YEAR(date).',
      input: 'cost_dept_with_actuals_dates',
      op: ops.map({ year: year(col('date')) }),
      output: 'cost_dept_with_actuals_year',
    }),
    step({
      id: 'cost_dept_yearly',
      name: 'Per-dept yearly opex (derived from overridden monthly)',
      description: 'Sum staff / non_staff / total across months in each year, per cost_dept.',
      input: 'cost_dept_with_actuals_year',
      op: ops.groupBy(['cost_dept', 'year'], {
        staff: agg.sum('staff'),
        non_staff: agg.sum('non_staff'),
        total: agg.sum('total'),
      }),
      output: 'cost_dept_yearly',
    }),

    // ─── Balance Sheet build-up (simplified) ───────────────────────────────
    //
    // Two cumulative-window derivations supply the v4 Balance Sheet's
    // Tangible Assets (= total cost − accumulated depreciation) and the
    // closing equity position (= cumulative EBITDA). Both are running
    // totals across the 72-month horizon with no partition.

    step({
      id: 'cumulative_depreciation_monthly',
      name: 'Cumulative capital depreciation per month',
      description: 'Running total of `depreciation_t.value` across the 72-month horizon.',
      input: 'depreciation_t',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: MONTHS, following: 0 },
        derive: { cumulative_depreciation: agg.sum('value') },
      }),
      output: 'cumulative_depreciation_monthly',
    }),

    step({
      id: 'cumulative_capex_monthly',
      name: 'Cumulative capex per month',
      description: 'Running total of `bs_monthly_schedule_t.capex` across the 72-month horizon.',
      input: 'bs_monthly_schedule_t',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: MONTHS, following: 0 },
        derive: { cumulative_capex: agg.sum('capex') },
      }),
      output: 'cumulative_capex_monthly',
    }),
    step({
      id: 'cumulative_loan_repaid_monthly',
      name: 'Cumulative loan repayments per month',
      description: 'Running total of `bs_monthly_schedule_t.loan_repayment` across the 72-month horizon.',
      input: 'bs_monthly_schedule_t',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: MONTHS, following: 0 },
        derive: { cumulative_loan_repaid: agg.sum('loan_repayment') },
      }),
      output: 'cumulative_loan_repaid_monthly',
    }),

    step({
      id: 'cumulative_ebitda_monthly',
      name: 'Cumulative EBITDA per month (with actuals)',
      description:
        'Running total of `budget_monthly_with_actuals.ebitda` — kept for ' +
        'reference (and any downstream view that wants pure EBITDA cumulative). ' +
        'Retained earnings and the cash waterfall now use ' +
        '`cumulative_profit_after_tax_monthly` instead.',
      input: 'budget_monthly_with_actuals',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: MONTHS, following: 0 },
        derive: { cumulative_ebitda: agg.sum('ebitda') },
      }),
      output: 'cumulative_ebitda_monthly',
    }),

    step({
      id: 'cumulative_profit_after_tax_monthly',
      name: 'Cumulative profit-after-tax per month',
      description:
        'Running total of `budget_monthly_full_pl.profit_after_tax` (ebitda − ' +
        'depreciation + rd_tax_credit). Drives Current Earnings on the BS and ' +
        'flows into the cash waterfall as the textbook-indirect starting point.',
      input: 'budget_monthly_full_pl',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: MONTHS, following: 0 },
        derive: { cumulative_profit_after_tax: agg.sum('profit_after_tax') },
      }),
      output: 'cumulative_profit_after_tax_monthly',
    }),

    // ─── Balance Sheet derivations ─────────────────────────────────────────
    //
    // Each balance-sheet line is built up via a focused mini-pipeline (cross
    // with `opening_bs_t` / `bs_assumptions_t` to pull scalars in, then map).
    // Final consolidation lives in `bs_summary_monthly` at the bottom.

    // Tangible assets[m] = opening + cumulative capex − cumulative depreciation.
    step({
      id: 'tangible_assets_with_capex_dep',
      name: 'Join cumulative depreciation with cumulative capex',
      description: 'Bring both running totals onto one row per month.',
      input: 'cumulative_depreciation_monthly',
      op: ops.join('cumulative_capex_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'tangible_assets_with_capex_dep',
    }),
    step({
      id: 'tangible_assets_with_opening',
      name: 'Attach opening BS for tangible asset calc',
      description: 'Cross with opening_bs_t so opening_tangible_assets is available.',
      input: 'tangible_assets_with_capex_dep',
      op: ops.cross('opening_bs_t'),
      output: 'tangible_assets_with_opening',
    }),
    step({
      id: 'tangible_assets_monthly_map',
      name: 'Tangible assets per month (compute)',
      description:
        'tangible_assets = opening_tangible_assets + cumulative_capex − cumulative_depreciation ' +
        '(raw, pre-floor; the bs_summary_monthly step floors it at 0). Per-month ' +
        'capex from the bs_monthly_schedule tracks v4 Capital Purchases — year-end ' +
        'tangible ≈ $6k → $62k → $180k → $207k → $105k → $0 (floored).',
      input: 'tangible_assets_with_opening',
      op: ops.map({
        tangible_assets: sub(
          add(col('opening_tangible_assets'), col('cumulative_capex')),
          col('cumulative_depreciation'),
        ),
      }),
      output: 'tangible_assets_monthly_full',
    }),
    step({
      id: 'tangible_assets_monthly_select',
      name: 'Tangible assets per month (projection)',
      description: 'Drop intermediate columns; published table is just month_idx + tangible_assets.',
      input: 'tangible_assets_monthly_full',
      op: ops.select(['month_idx', 'tangible_assets']),
      output: 'tangible_assets_monthly',
    }),

    // Trade debtors[m] ≈ monthly revenue × AR-days / 30. Captures the receivables
    // balance proportional to revenue and AR collection period.
    step({
      id: 'trade_debtors_with_assumptions',
      name: 'Attach BS assumptions to monthly revenue',
      description: 'Cross-join revenue_monthly with bs_assumptions_t to pull AR days inline.',
      input: 'revenue_monthly',
      op: ops.cross('bs_assumptions_t'),
      output: 'trade_debtors_with_assumptions',
    }),
    step({
      id: 'trade_debtors_monthly_map',
      name: 'Trade debtors per month',
      description: 'trade_debtors = revenue × ar_days / 30. Stylised AR balance proportional to revenue.',
      input: 'trade_debtors_with_assumptions',
      op: ops.map({ trade_debtors: div(mul(col('revenue'), col('ar_days')), lit(30)) }),
      output: 'trade_debtors_monthly_full',
    }),
    step({
      id: 'trade_debtors_monthly_select',
      name: 'Trade debtors per month (projection)',
      description: 'Drop revenue+assumption inputs; published table is just month_idx + trade_debtors.',
      input: 'trade_debtors_monthly_full',
      op: ops.select(['month_idx', 'trade_debtors']),
      output: 'trade_debtors_monthly',
    }),

    // Trade Creditors / Other Debtors / VAT / Other Creditors: pulled directly
    // from the per-month schedule (no formula). v4 carries these as explicit
    // monthly trajectories rather than days-based formulas.
    step({
      id: 'trade_creditors_monthly',
      name: 'Trade creditors per month',
      description: 'Direct read from bs_monthly_schedule.trade_creditors (closing balance, negative).',
      input: 'bs_monthly_schedule_t',
      op: ops.select(['month_idx', 'trade_creditors']),
      output: 'trade_creditors_monthly',
    }),
    step({
      id: 'other_debtors_monthly',
      name: 'Other debtors per month',
      description: 'Direct read from bs_monthly_schedule.other_debtors.',
      input: 'bs_monthly_schedule_t',
      op: ops.select(['month_idx', 'other_debtors']),
      output: 'other_debtors_monthly',
    }),
    step({
      id: 'vat_monthly',
      name: 'VAT receivable per month',
      description: 'Direct read from bs_monthly_schedule.vat.',
      input: 'bs_monthly_schedule_t',
      op: ops.select(['month_idx', 'vat']),
      output: 'vat_monthly',
    }),
    step({
      id: 'other_creditors_monthly',
      name: 'Other creditors per month',
      description: 'Direct read from bs_monthly_schedule.other_creditors.',
      input: 'bs_monthly_schedule_t',
      op: ops.select(['month_idx', 'other_creditors']),
      output: 'other_creditors_monthly',
    }),

    // Loans[m] = opening + cumulative repayments. Clamped at 0 so over-payment
    // can't flip the sign. Schedule (in bs_monthly_schedule.loan_repayment)
    // defaults to $0 Jan-Sep 2026, then $12,000/mo from Oct 2026 for 18 months
    // until the loan is fully paid off in early 2028.
    step({
      id: 'loans_with_opening',
      name: 'Attach opening loan balance to cumulative repayment',
      description: 'Cross-join cumulative_loan_repaid_monthly with opening_bs_t.',
      input: 'cumulative_loan_repaid_monthly',
      op: ops.cross('opening_bs_t'),
      output: 'loans_with_opening',
    }),
    step({
      id: 'loans_monthly_map',
      name: 'Loans per month',
      description:
        'loans[m] = min(0, opening_loans + cumulative_loan_repaid). Clamped at 0 ' +
        'so over-repayment can\'t produce a positive loan balance.',
      input: 'loans_with_opening',
      op: ops.map({
        loans: minFn(
          lit(0),
          add(col('opening_loans'), col('cumulative_loan_repaid')),
        ),
      }),
      output: 'loans_monthly_full',
    }),
    step({
      id: 'loans_monthly_select',
      name: 'Loans per month (projection)',
      description: 'Published table: month_idx + loans + cumulative_loan_repaid (used by cash build).',
      input: 'loans_monthly_full',
      op: ops.select(['month_idx', 'loans', 'cumulative_loan_repaid']),
      output: 'loans_monthly',
    }),

    // Cash build (full waterfall — textbook indirect method):
    //   cash = opening_cash
    //        + cumulative_profit_after_tax            // ebitda − dep + rd_credit
    //        + cumulative_depreciation                // non-cash add-back
    //        − cumulative_capex                       // cash spent on assets
    //        − cumulative_loan_repaid
    //        − (trade_debtors − opening_trade_debtors)     // Δ AR drains cash
    //        − (other_debtors − opening_other_debtors)      // Δ other debtors
    //        − (vat − opening_vat)                          // Δ VAT receivable
    //        − (trade_creditors − opening_trade_creditors)  // Δ AP (creditors negative; Δ negative provides cash)
    //        − (other_creditors − opening_other_creditors)
    // Cum_PaT + cum_dep = cum_EBITDA + cum_rd_credit, so this is equivalent to
    // adding the R&D credit cash on top of the previous (EBITDA + dep add-back)
    // formulation. With opening BS satisfying Net Assets = Total Equity, this
    // guarantees the BS balances (Difference rounds to floating-point noise).
    step({
      id: 'cash_components_step1',
      name: 'Project cumulative profit-after-tax to just month + total',
      description: 'Strip cumulative_profit_after_tax_monthly down to (month_idx, cumulative_profit_after_tax).',
      input: 'cumulative_profit_after_tax_monthly',
      op: ops.select(['month_idx', 'cumulative_profit_after_tax']),
      output: 'cash_components_step1',
    }),
    step({
      id: 'cash_components_step2',
      name: 'Join with cumulative depreciation',
      description: 'Bring cumulative_depreciation alongside cumulative_ebitda per month.',
      input: 'cash_components_step1',
      op: ops.join('cumulative_depreciation_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step2',
    }),
    step({
      id: 'cash_components_step3',
      name: 'Join with cumulative capex',
      description: 'Bring cumulative_capex alongside the cumulative P&L items.',
      input: 'cash_components_step2',
      op: ops.join('cumulative_capex_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step3',
    }),
    step({
      id: 'cash_components_step4',
      name: 'Join with cumulative loan repayments',
      description: 'Bring cumulative_loan_repaid alongside the cumulative P&L items.',
      input: 'cash_components_step3',
      op: ops.join('loans_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step4',
    }),
    step({
      id: 'cash_components_step5',
      name: 'Join with trade debtors balance',
      description: 'Bring per-month trade_debtors inline so we can subtract Δ AR from cash.',
      input: 'cash_components_step4',
      op: ops.join('trade_debtors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step5',
    }),
    step({
      id: 'cash_components_step6',
      name: 'Join with trade creditors balance',
      description: 'Bring per-month trade_creditors inline so we can add Δ AP to cash.',
      input: 'cash_components_step5',
      op: ops.join('trade_creditors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step6',
    }),
    step({
      id: 'cash_components_step7',
      name: 'Join with other debtors balance',
      description: 'Bring per-month other_debtors inline.',
      input: 'cash_components_step6',
      op: ops.join('other_debtors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step7',
    }),
    step({
      id: 'cash_components_step8',
      name: 'Join with VAT balance',
      description: 'Bring per-month VAT inline.',
      input: 'cash_components_step7',
      op: ops.join('vat_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step8',
    }),
    step({
      id: 'cash_components_step9',
      name: 'Join with other creditors balance',
      description: 'Bring per-month other_creditors inline.',
      input: 'cash_components_step8',
      op: ops.join('other_creditors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'cash_components_step9',
    }),
    step({
      id: 'cash_components_step10',
      name: 'Attach opening BS scalars',
      description: 'Cross with opening_bs_t to pull all opening balances inline.',
      input: 'cash_components_step9',
      op: ops.cross('opening_bs_t'),
      output: 'cash_components_step10',
    }),
    step({
      id: 'cash_monthly_map',
      name: 'Cash per month (full waterfall)',
      description:
        'cash = opening_cash + cum_profit_after_tax + cum_depreciation − cum_capex − cum_loan_repaid ' +
        '− Δ(trade_debtors) − Δ(other_debtors) − Δ(vat) ' +
        '− Δ(trade_creditors) − Δ(other_creditors). ' +
        'Each Δ = closing − opening; for asset items this drains cash when balance grows, ' +
        'for liability items (stored as negative) the same sign convention provides cash ' +
        'when the liability grows (Δ becomes more negative).',
      input: 'cash_components_step10',
      op: ops.map({
        cash: sub(
          sub(
            sub(
              sub(
                sub(
                  add(
                    add(
                      sub(
                        sub(
                          add(col('opening_cash'), col('cumulative_profit_after_tax')),
                          col('cumulative_capex'),
                        ),
                        col('cumulative_loan_repaid'),
                      ),
                      col('cumulative_depreciation'),
                    ),
                    sub(col('opening_trade_debtors'), col('trade_debtors')),
                  ),
                  sub(col('other_debtors'), col('opening_other_debtors')),
                ),
                sub(col('vat'), col('opening_vat')),
              ),
              sub(col('trade_creditors'), col('opening_trade_creditors')),
            ),
            sub(col('other_creditors'), col('opening_other_creditors')),
          ),
          lit(0),
        ),
      }),
      output: 'cash_monthly_full',
    }),
    step({
      id: 'cash_monthly_select',
      name: 'Cash per month (projection)',
      description: 'Drop intermediate columns; published table is just month_idx + cash.',
      input: 'cash_monthly_full',
      op: ops.select(['month_idx', 'cash']),
      output: 'cash_monthly',
    }),

    // Retained earnings = BFWD + cumulative profit-after-tax. PaT subtracts
    // depreciation below EBITDA and adds the R&D credit, so this is the real
    // post-tax profit accumulation (within the limit that we don't model
    // corporation tax — zero in the forecast horizon).
    step({
      id: 'retained_earnings_with_opening',
      name: 'Attach opening BFWD to cumulative profit-after-tax',
      description: 'Cross-join cumulative_profit_after_tax_monthly with opening_bs_t.',
      input: 'cumulative_profit_after_tax_monthly',
      op: ops.cross('opening_bs_t'),
      output: 'retained_earnings_with_opening',
    }),
    step({
      id: 'retained_earnings_monthly_map',
      name: 'Retained earnings + current earnings per month',
      description:
        'current_earnings = cumulative_profit_after_tax. ' +
        'retained_earnings = BFWD + current_earnings.',
      input: 'retained_earnings_with_opening',
      op: ops.map({
        current_earnings: col('cumulative_profit_after_tax'),
        retained_earnings: add(col('bfwd_retained_earnings'), col('cumulative_profit_after_tax')),
      }),
      output: 'retained_earnings_monthly_full',
    }),
    step({
      id: 'retained_earnings_monthly_select',
      name: 'Retained earnings per month (projection)',
      description: 'Published table: month_idx + current_earnings + retained_earnings.',
      input: 'retained_earnings_monthly_full',
      op: ops.select(['month_idx', 'current_earnings', 'retained_earnings']),
      output: 'retained_earnings_monthly',
    }),

    // ─── Balance Sheet consolidation ───────────────────────────────────────
    // Walk the derived per-line tables into a single wide table that has every
    // balance sheet line as a column. Report rendering pulls each row from
    // here.
    step({
      id: 'bs_summary_step1',
      name: 'Balance sheet: cross dates with opening BS',
      description: 'One row per month, with opening BS scalars attached.',
      input: 'dates_t',
      op: ops.cross('opening_bs_t'),
      output: 'bs_summary_step1',
    }),
    step({
      id: 'bs_summary_step2',
      name: 'Balance sheet: join tangible assets',
      description: 'Attach the per-month tangible asset balance.',
      input: 'bs_summary_step1',
      op: ops.join('tangible_assets_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step2',
    }),
    step({
      id: 'bs_summary_step3',
      name: 'Balance sheet: join trade debtors',
      description: 'Attach the per-month trade debtors balance.',
      input: 'bs_summary_step2',
      op: ops.join('trade_debtors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step3',
    }),
    step({
      id: 'bs_summary_step4',
      name: 'Balance sheet: join trade creditors',
      description: 'Attach the per-month trade creditors balance.',
      input: 'bs_summary_step3',
      op: ops.join('trade_creditors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step4',
    }),
    step({
      id: 'bs_summary_step5',
      name: 'Balance sheet: join cash',
      description: 'Attach the per-month cash balance.',
      input: 'bs_summary_step4',
      op: ops.join('cash_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step5',
    }),
    step({
      id: 'bs_summary_step6',
      name: 'Balance sheet: join loans',
      description: 'Attach the per-month loan balance.',
      input: 'bs_summary_step5',
      op: ops.join('loans_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step6',
    }),
    step({
      id: 'bs_summary_step7',
      name: 'Balance sheet: join retained earnings',
      description: 'Attach current_earnings + retained_earnings per month.',
      input: 'bs_summary_step6',
      op: ops.join('retained_earnings_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step7',
    }),
    step({
      id: 'bs_summary_step8',
      name: 'Balance sheet: join other debtors',
      description: 'Attach the per-month other_debtors balance from the schedule.',
      input: 'bs_summary_step7',
      op: ops.join('other_debtors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step8',
    }),
    step({
      id: 'bs_summary_step9',
      name: 'Balance sheet: join VAT',
      description: 'Attach the per-month VAT balance from the schedule.',
      input: 'bs_summary_step8',
      op: ops.join('vat_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step9',
    }),
    step({
      id: 'bs_summary_step10',
      name: 'Balance sheet: join other creditors',
      description: 'Attach the per-month other_creditors balance from the schedule.',
      input: 'bs_summary_step9',
      op: ops.join('other_creditors_monthly', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
      output: 'bs_summary_step10',
    }),
    step({
      id: 'bs_summary_monthly',
      name: 'Balance Sheet (monthly, all lines)',
      description:
        'Final wide table — one row per month with every balance sheet line as a ' +
        'column. Carries the opening-position constants forward (intangibles, ' +
        'other debtors, VAT, deferred revenue, other creditors, share cap items), ' +
        'sums the subtotals (total_fixed, total_current_assets, ' +
        'total_current_liabilities, net_assets, total_equity), and emits a ' +
        '`difference` check (net_assets − total_equity) which should round to zero.',
      input: 'bs_summary_step10',
      // Tangible Assets cannot fall below zero. v4's depreciation schedule
      // (Capital Purchases!155 ≈ $1.316M) exceeds the total capitalised cost
      // (opening $45,635 + capex $1,081,600 = $1,127,235) by ~$189k, so the
      // raw book value (opening + Σcapex − Σdepreciation) turns negative in
      // late 2031. v4 hides this by leaving the Tangible Assets formula
      // un-dragged to the final columns, so it snaps to 0 in Dec-2031 (a
      // spreadsheet bug). We floor it honestly via `max(raw, 0)`. The
      // depreciation that floor disallows (`max(−raw, 0)` — i.e. the part that
      // would have written the asset below zero) is added back into Current
      // Earnings, since you cannot expense depreciation on an asset you no
      // longer carry. Both adjustments are equal and land on opposite sides of
      // the sheet, so Net Assets ≡ Total Equity is preserved (Difference → 0).
      op: ops.map({
        tangible_assets: maxFn(col('tangible_assets'), lit(0)),
        current_earnings: add(
          col('current_earnings'),
          maxFn(sub(lit(0), col('tangible_assets')), lit(0)),
        ),
        intangible_assets: col('opening_intangible_assets'),
        total_fixed_assets: add(maxFn(col('tangible_assets'), lit(0)), col('opening_intangible_assets')),
        total_current_assets: add(
          add(col('trade_debtors'), col('other_debtors')),
          add(col('vat'), col('cash')),
        ),
        deferred_revenue: col('opening_deferred_revenue'),
        total_current_liabilities: add(
          col('trade_creditors'),
          add(col('opening_deferred_revenue'), col('other_creditors')),
        ),
        net_assets: add(
          add(maxFn(col('tangible_assets'), lit(0)), col('opening_intangible_assets')),
          add(
            add(
              add(col('trade_debtors'), col('other_debtors')),
              add(col('vat'), col('cash')),
            ),
            add(
              add(
                col('trade_creditors'),
                add(col('opening_deferred_revenue'), col('other_creditors')),
              ),
              col('loans'),
            ),
          ),
        ),
        total_equity: add(
          add(col('share_capital'), col('share_premium')),
          add(
            col('other_reserve'),
            add(
              col('bfwd_retained_earnings'),
              add(col('current_earnings'), maxFn(sub(lit(0), col('tangible_assets')), lit(0))),
            ),
          ),
        ),
        difference: sub(
          add(
            add(maxFn(col('tangible_assets'), lit(0)), col('opening_intangible_assets')),
            add(
              add(
                add(col('trade_debtors'), col('other_debtors')),
                add(col('vat'), col('cash')),
              ),
              add(
                add(
                  col('trade_creditors'),
                  add(col('opening_deferred_revenue'), col('other_creditors')),
                ),
                col('loans'),
              ),
            ),
          ),
          add(
            add(col('share_capital'), col('share_premium')),
            add(
              col('other_reserve'),
              add(
                col('bfwd_retained_earnings'),
                add(col('current_earnings'), maxFn(sub(lit(0), col('tangible_assets')), lit(0))),
              ),
            ),
          ),
        ),
      }),
      output: 'bs_summary_monthly',
    }),

    // ─── Actuals overlay: monthly Balance Sheet ─────────────────────────────
    // Override at the monthly level. Subtotals (Total Fixed Assets, Current
    // Assets / Liabilities, Net Assets, Total Equity, Difference) recompute
    // from the overridden lines. Yearly BS view is the December rows.
    step({
      id: 'bs_summary_monthly_joined_actuals',
      name: 'Join monthly BS with actuals overrides',
      description: 'Left join bs_summary_monthly with bs_monthly_actuals_t on month_idx.',
      input: 'bs_summary_monthly',
      op: ops.join('bs_monthly_actuals_t', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
      output: 'bs_summary_monthly_joined_actuals',
    }),
    step({
      id: 'bs_summary_monthly_with_actuals_lines',
      name: 'Monthly balance sheet lines with actuals overlay',
      description:
        'For each balance sheet line in each month, use the override value if provided; ' +
        'otherwise fall back to the modeled balance.',
      input: 'bs_summary_monthly_joined_actuals',
      op: ops.map({
        intangible_assets: iff(eq(col('intangible_assets_actual'), lit(null)), col('intangible_assets'), col('intangible_assets_actual')),
        tangible_assets: iff(eq(col('tangible_assets_actual'), lit(null)), col('tangible_assets'), col('tangible_assets_actual')),
        trade_debtors: iff(eq(col('trade_debtors_actual'), lit(null)), col('trade_debtors'), col('trade_debtors_actual')),
        other_debtors: iff(eq(col('other_debtors_actual'), lit(null)), col('other_debtors'), col('other_debtors_actual')),
        vat: iff(eq(col('vat_actual'), lit(null)), col('vat'), col('vat_actual')),
        cash: iff(eq(col('cash_actual'), lit(null)), col('cash'), col('cash_actual')),
        trade_creditors: iff(eq(col('trade_creditors_actual'), lit(null)), col('trade_creditors'), col('trade_creditors_actual')),
        deferred_revenue: iff(eq(col('deferred_revenue_actual'), lit(null)), col('deferred_revenue'), col('deferred_revenue_actual')),
        other_creditors: iff(eq(col('other_creditors_actual'), lit(null)), col('other_creditors'), col('other_creditors_actual')),
        loans: iff(eq(col('loans_actual'), lit(null)), col('loans'), col('loans_actual')),
        share_capital: iff(eq(col('share_capital_actual'), lit(null)), col('share_capital'), col('share_capital_actual')),
        share_premium: iff(eq(col('share_premium_actual'), lit(null)), col('share_premium'), col('share_premium_actual')),
        other_reserve: iff(eq(col('other_reserve_actual'), lit(null)), col('other_reserve'), col('other_reserve_actual')),
        bfwd_retained_earnings: iff(eq(col('bfwd_retained_earnings_actual'), lit(null)), col('bfwd_retained_earnings'), col('bfwd_retained_earnings_actual')),
        current_earnings: iff(eq(col('current_earnings_actual'), lit(null)), col('current_earnings'), col('current_earnings_actual')),
      }),
      output: 'bs_summary_monthly_with_actuals_lines',
    }),
    step({
      id: 'bs_summary_monthly_with_actuals',
      name: 'Monthly balance sheet (subtotals + check) with actuals',
      description:
        'Recompute subtotals (Fixed Assets / Current Assets / Current Liabilities / ' +
        'Net Assets / Total Equity) from the overridden line values, plus the ' +
        'Difference check.',
      input: 'bs_summary_monthly_with_actuals_lines',
      op: ops.map({
        total_fixed_assets: add(col('tangible_assets'), col('intangible_assets')),
        total_current_assets: add(
          add(col('trade_debtors'), col('other_debtors')),
          add(col('vat'), col('cash')),
        ),
        total_current_liabilities: add(
          col('trade_creditors'),
          add(col('deferred_revenue'), col('other_creditors')),
        ),
        net_assets: add(
          add(col('tangible_assets'), col('intangible_assets')),
          add(
            add(
              add(col('trade_debtors'), col('other_debtors')),
              add(col('vat'), col('cash')),
            ),
            add(
              add(
                col('trade_creditors'),
                add(col('deferred_revenue'), col('other_creditors')),
              ),
              col('loans'),
            ),
          ),
        ),
        total_equity: add(
          add(col('share_capital'), col('share_premium')),
          add(
            col('other_reserve'),
            add(col('bfwd_retained_earnings'), col('current_earnings')),
          ),
        ),
        difference: sub(
          add(
            add(col('tangible_assets'), col('intangible_assets')),
            add(
              add(
                add(col('trade_debtors'), col('other_debtors')),
                add(col('vat'), col('cash')),
              ),
              add(
                add(
                  col('trade_creditors'),
                  add(col('deferred_revenue'), col('other_creditors')),
                ),
                col('loans'),
              ),
            ),
          ),
          add(
            add(col('share_capital'), col('share_premium')),
            add(
              col('other_reserve'),
              add(col('bfwd_retained_earnings'), col('current_earnings')),
            ),
          ),
        ),
      }),
      output: 'bs_summary_monthly_with_actuals',
    }),

    // Yearly BS view = end-of-year rows from the overridden monthly table.
    step({
      id: 'bs_yearly_with_actuals_filter',
      name: 'Yearly BS: filter to December rows of overridden monthly',
      description: 'Keep month_idx ≡ 11 (mod 12) — the end-of-year position for each year.',
      input: 'bs_summary_monthly_with_actuals',
      op: ops.filter(eq(mod(col('month_idx'), lit(12)), lit(11))),
      output: 'bs_yearly_with_actuals_filter',
    }),
    step({
      id: 'bs_yearly_with_actuals_year_col',
      name: 'Yearly BS: derive calendar year column',
      description: 'year = 2026 + floor(month_idx / 12).',
      input: 'bs_yearly_with_actuals_filter',
      op: ops.map({ year: add(lit(START_YEAR), floor(div(col('month_idx'), lit(12)))) }),
      output: 'bs_yearly_with_actuals_year_col',
    }),
    step({
      id: 'bs_yearly_with_actuals',
      name: 'Yearly balance sheet (derived from overridden monthly)',
      description:
        'Group by year so the identity is `year` (not month_idx) — lets the Excel ' +
        'renderer and React table look up rows by year. Each year has exactly one ' +
        'input row (the December position) so sum is the identity transform.',
      input: 'bs_yearly_with_actuals_year_col',
      op: ops.groupBy(['year'], {
        intangible_assets: agg.sum('intangible_assets'),
        tangible_assets: agg.sum('tangible_assets'),
        total_fixed_assets: agg.sum('total_fixed_assets'),
        trade_debtors: agg.sum('trade_debtors'),
        other_debtors: agg.sum('other_debtors'),
        vat: agg.sum('vat'),
        cash: agg.sum('cash'),
        total_current_assets: agg.sum('total_current_assets'),
        trade_creditors: agg.sum('trade_creditors'),
        deferred_revenue: agg.sum('deferred_revenue'),
        other_creditors: agg.sum('other_creditors'),
        total_current_liabilities: agg.sum('total_current_liabilities'),
        loans: agg.sum('loans'),
        net_assets: agg.sum('net_assets'),
        share_capital: agg.sum('share_capital'),
        share_premium: agg.sum('share_premium'),
        other_reserve: agg.sum('other_reserve'),
        bfwd_retained_earnings: agg.sum('bfwd_retained_earnings'),
        current_earnings: agg.sum('current_earnings'),
        total_equity: agg.sum('total_equity'),
        difference: agg.sum('difference'),
      }),
      output: 'bs_yearly_with_actuals',
    }),
  ],

  outputs: [
    { ref: 'active_by_ta_type_month', label: 'Active trials per TA × type × month' },
    { ref: 'revenue_by_ta_type_month', label: 'Per TA × type × month revenue components' },
    { ref: 'ta_monthly_total', label: 'Per-TA per-month total revenue (modeled only)' },
    { ref: 'hubspot_per_ta_monthly', label: 'Per-TA HubSpot pipeline per month' },
    { ref: 'ta_monthly_with_hubspot', label: 'Per-TA per-month revenue (modeled + HubSpot)' },
    { ref: 'modeled_total_monthly', label: 'Modeled revenue total per month' },
    { ref: 'revenue_monthly', label: 'Monthly total revenue (modeled + HubSpot)' },
    { ref: 'modeller_commission_per_ta_monthly', label: 'Modeller commission per TA × month' },
    { ref: 'modeller_commission_monthly', label: 'Total modeller commission per month' },
    { ref: 'sales_commission_monthly', label: 'Sales commission per month (S&M derived)' },
    { ref: 'per_employee_monthly_cost', label: 'Per-employee monthly cost' },
    { ref: 'cost_dept_staff_monthly', label: 'Cost dept staff cost per month' },
    { ref: 'cost_dept_total_monthly', label: 'Cost dept total per month' },
    { ref: 'total_opex_monthly', label: 'Total opex per month' },
    { ref: 'budget_monthly', label: 'Monthly P&L (revenue → EBITDA)' },
    { ref: 'budget_monthly_full_pl', label: 'Monthly P&L (with operating profit + PaT)' },
    { ref: 'budget_yearly', label: 'Yearly P&L' },
    { ref: 'tangible_assets_monthly', label: 'Tangible assets per month' },
    { ref: 'trade_debtors_monthly', label: 'Trade debtors per month' },
    { ref: 'trade_creditors_monthly', label: 'Trade creditors per month' },
    { ref: 'cash_monthly', label: 'Cash per month' },
    { ref: 'loans_monthly', label: 'Loans per month' },
    { ref: 'retained_earnings_monthly', label: 'Retained earnings per month' },
    { ref: 'bs_summary_monthly', label: 'Balance Sheet (monthly, all lines)' },
    { ref: 'budget_monthly_with_actuals', label: 'Monthly P&L (with actuals overlay)' },
    { ref: 'cost_dept_total_monthly_with_actuals', label: 'Per-dept monthly opex (with actuals overlay)' },
    { ref: 'cost_dept_yearly', label: 'Per-dept yearly opex (derived)' },
    { ref: 'bs_summary_monthly_with_actuals', label: 'Monthly Balance Sheet (with actuals overlay)' },
    { ref: 'bs_yearly_with_actuals', label: 'Yearly Balance Sheet (end-of-year, derived)' },
  ],

  // Logical sections mirroring the source spreadsheet's tabs (and the web
  // app's view tabs). Each ref is either a source name or a step output.
  // The explorer uses this when "Group by section" is on.
  groups: [
    {
      name: 'Calendar',
      description: 'Month index sequence and the derived YYYY-MM date string.',
      refs: ['month_indices', 'dates_t'],
    },
    {
      name: 'Revenue Model',
      description:
        'Per-TA × type × month active trials and revenue components, rolled ' +
        'up to per-TA and modeled-total monthly. Modeller and sales commission ' +
        'derivations live here too.',
      refs: [
        'pricing_t', 'schedule_t', 'commission_t',
        'active_by_ta_type_month_window', 'active_by_ta_type_month',
        'active_with_pricing',
        'revenue_by_ta_type_month_raw', 'revenue_by_ta_type_month',
        'ta_monthly_components', 'ta_monthly_total', 'modeled_total_monthly',
        'model_revenue_by_ta_type_month_raw', 'model_revenue_by_ta_type_month',
        'model_revenue_by_ta_month',
        'modeller_commission_per_ta_with_params', 'modeller_commission_per_ta_monthly',
        'modeller_commission_monthly',
        'starts_per_month', 'starts_with_revenue', 'starts_with_revenue_and_commission',
        'sales_commission_monthly',
      ],
    },
    {
      name: 'HubSpot',
      description: 'HubSpot pipeline line items per month and rollup with the modeled total.',
      refs: [
        'hubspot_pipeline_t',
        'hubspot_per_ta_monthly', 'ta_monthly_total_joined_hubspot', 'ta_monthly_with_hubspot',
        'hubspot_total_monthly', 'modeled_with_hubspot', 'revenue_monthly',
      ],
    },
    {
      name: 'Employees',
      description: 'Headcount roster, payroll assumptions, and the per-employee × month cost build-up with inflation.',
      refs: [
        'employees_t', 'employee_assumptions_t',
        'employees_cross_dates', 'employees_with_params', 'employees_with_date_parts',
        'per_employee_monthly_intermediate', 'per_employee_monthly_cost',
        'employee_dept_monthly', 'employee_total_monthly',
      ],
    },
    {
      name: 'Costs',
      description: 'Non-staff cost line items, depreciation, and the per-cost-dept staff + non-staff + derived-sales-commission rollup.',
      refs: [
        'cost_line_items_t', 'depreciation_t', 'dept_to_tab_t',
        'employee_dept_to_cost_dept', 'cost_dept_staff_monthly',
        'cost_line_items_dept_monthly', 'cost_dept_staff_and_line',
        'cost_dept_with_sales_commission', 'cost_dept_total_monthly',
        'total_opex_monthly',
      ],
    },
    {
      name: 'Budget P&L',
      description:
        'Revenue → cost of sales → gross profit → opex → EBITDA, plus the ' +
        'below-EBITDA layer: − depreciation → operating profit + R&D credit ' +
        '→ profit after tax. Monthly and yearly.',
      refs: [
        'rev_with_modeller_commission',
        'budget_with_cos_gp', 'budget_with_opex', 'budget_monthly',
        'rd_tax_credit_t',
        'budget_with_dep_join', 'budget_with_dep_renamed',
        'budget_with_rd_credit_join', 'budget_monthly_full_pl',
        'budget_with_dates', 'budget_with_year', 'budget_yearly',
      ],
    },
    {
      name: 'Balance Sheet',
      description:
        'Opening balance sheet + per-month derivations: tangible assets (− cumulative ' +
        'depreciation), trade debtors (revenue × AR days), trade creditors (cash opex ' +
        '× AP days), loans (− cumulative repayments), retained earnings (BFWD + ' +
        'cumulative profit-after-tax), and cash (opening + cumulative PaT + ' +
        'depreciation add-back − capex − loan repayments − ΔWC). All consolidated ' +
        'in bs_summary_monthly.',
      refs: [
        'opening_bs_t', 'bs_assumptions_t',
        'cumulative_depreciation_monthly', 'cumulative_ebitda_monthly',
        'cumulative_profit_after_tax_monthly',
        'tangible_assets_with_opening', 'tangible_assets_monthly_full', 'tangible_assets_monthly',
        'trade_debtors_with_assumptions', 'trade_debtors_monthly_full', 'trade_debtors_monthly',
        'non_staff_opex_monthly',
        'trade_creditors_with_modeller', 'trade_creditors_with_assumptions',
        'trade_creditors_monthly_full', 'trade_creditors_monthly',
        'loans_with_opening', 'loans_with_assumptions',
        'loans_monthly_full', 'loans_monthly',
        'cash_components_step1', 'cash_components_step2', 'cash_components_step3',
        'cash_components_step4', 'cash_components_step5', 'cash_components_step6',
        'cash_monthly_full', 'cash_monthly',
        'retained_earnings_with_opening', 'retained_earnings_monthly_full', 'retained_earnings_monthly',
        'bs_summary_step1', 'bs_summary_step2', 'bs_summary_step3', 'bs_summary_step4',
        'bs_summary_step5', 'bs_summary_step6', 'bs_summary_step7', 'bs_summary_monthly',
      ],
    },
  ],
});

