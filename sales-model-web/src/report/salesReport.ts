// Report definition for the sales model. Each section becomes a worksheet in
// the Excel export (and a tab in the future web renderer).
//
// Layout mirrors the original spreadsheet:
//   - Revenue Model — pricing / commission / per-TA stacks / aggregates
//   - Total Revenue — HubSpot + per-TA grand totals
//   - HubSpot Pipeline — line items × month
//   - Employees — roster + monthly cost + per-dept breakdown
//   - Costs — per-dept line items + total
//   - Budget P&L — revenue → cost of sales → opex → EBITDA, monthly + yearly

import type { ReportBlock, ReportDef, ReportSection } from './types';

const ACTIVE_TAS = ['Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5'];

const TYPE_LABELS: Record<string, string> = {
  A: 'Type A (Small)',
  B: 'Type B (Medium)',
  C: 'Type C (Large)',
};

const yearRollup = { yearTotals: true, grandTotal: true, grandTotalLabel: '6-yr Total' };
const monthAxis = { col: 'month_idx', labels: 'dates' } as const;

/** Per-TA: starts (canonical) + active (derived) + revenue (derived) + modeller commission (derived). */
function perTABlocks(ta: string): ReportBlock[] {
  return [
    { kind: 'title', text: ta, level: 2 },

    { kind: 'title', text: `${ta} — client starts per month`, level: 3 },
    {
      kind: 'table',
      source: 'schedule_t',
      filter: { ta },
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'Type',
        labelCol: 'type',
        valueCol: 'starts',
        labelMap: TYPE_LABELS,
        format: 'count',
      },
      totalsRow: { label: 'Total starts' },
      rollup: yearRollup,
      defaultFormat: 'count',
      canonical: { refs: ['schedule_t'] },
    },

    { kind: 'title', text: `${ta} — active trials per month`, level: 3 },
    {
      kind: 'table',
      source: 'active_by_ta_type_month',
      filter: { ta },
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'Type',
        labelCol: 'type',
        valueCol: 'active',
        labelMap: TYPE_LABELS,
        format: 'count',
      },
      totalsRow: { label: 'Total active', bold: true },
      rollup: yearRollup,
      defaultFormat: 'count',
    },

    { kind: 'title', text: `${ta} — modeller commission ($)`, level: 3 },
    {
      kind: 'table',
      source: 'modeller_commission_per_ta_monthly',
      filter: { ta },
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [{ col: 'commission', label: 'Modeller commission' }],
      },
      rollup: yearRollup,
    },

    { kind: 'spacer', rows: 1 },
  ];
}

// ─── Sections ────────────────────────────────────────────────────────────

const revenueModelSection: ReportSection = {
  id: 'revenue-model',
  label: 'Revenue Model',
  hint: 'Pricing, per-TA monthly revenue (starts → active → platform / project / PM), modeller commission, aggregates.',
  blocks: [
    { kind: 'title', text: 'Pricing assumptions' },
    {
      kind: 'table',
      source: 'pricing_t',
      rows: { kind: 'table-rows', labelCol: 'type', labelHeader: 'Type' },
      defaultFormat: 'money',
      canonical: { refs: ['pricing_t'] },
    },
    { kind: 'spacer', rows: 1 },

    { kind: 'title', text: 'Commission assumptions' },
    {
      kind: 'table',
      source: 'commission_t',
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'rate',               label: 'Modeller commission rate',       format: 'percent' },
          { col: 'cap_per_month',      label: 'Modeller cap (per TA / month)',  format: 'money' },
          { col: 'sales_per_client',   label: 'Sales commission per new client', format: 'money' },
          { col: 'sales_invoice_rate', label: 'Sales commission invoice rate',   format: 'percent' },
        ],
      },
      canonical: { refs: ['commission_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Monthly revenue ($)' },
    {
      kind: 'table',
      source: 'ta_monthly_total',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        labelHeader: '',
        rows: [
          { source: 'hubspot_total_monthly', identity: {}, valueCol: 'hubspot',
            label: 'HubSpot pipeline (subtotal)', bold: true },
          ...ACTIVE_TAS.map((ta) => ({
            identity: { ta }, valueCol: 'total', label: ta,
          })),
          { source: 'modeled_total_monthly', identity: {}, valueCol: 'total',
            label: 'Modeled TAs (subtotal)', bold: true },
          { source: 'revenue_monthly', identity: {}, valueCol: 'revenue',
            label: 'Grand total (HubSpot + modeled)', bold: true },
        ],
      },
      rollup: yearRollup,
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Per-therapeutic-area monthly detail' },
    ...ACTIVE_TAS.flatMap(perTABlocks),

    { kind: 'title', text: 'Aggregates (used by Costs / Budget)' },
    {
      kind: 'table',
      source: 'starts_per_month',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [{ col: 'total_starts', label: 'Total client starts', format: 'count' }],
      },
      rollup: yearRollup,
      defaultFormat: 'count',
    },
    {
      kind: 'table',
      source: 'modeller_commission_monthly',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [{ col: 'modeller_commission', label: 'Total modeller commission' }],
      },
      rollup: yearRollup,
    },
  ],
};

// ─── HubSpot Pipeline ────────────────────────────────────────────────────

const hubspotSection: ReportSection = {
  id: 'hubspot',
  label: 'HubSpot Pipeline',
  hint: 'Pipeline by therapeutic area / line item / month, pulled from HubSpot sync. Each deal is allocated to a TA via the rules below.',
  blocks: [
    { kind: 'title', text: 'Deal → TA allocation rules' },
    { kind: 'paragraph', italic: true,
      text:
        'Case-insensitive regex tested against each deal name during sync. The first ' +
        'matching rule\'s TA wins; if no rule matches, the deal goes to the default TA ' +
        '("Ophthalmology"). Rules take effect on the next "Sync from HubSpot". To add ' +
        'a new TA: set the pattern (e.g. `\\\\b(liver|mash|hepatic)\\\\b`) and the TA ' +
        'name (e.g. `Hepatology`); the engine starts bucketing matching deals there.',
    },
    {
      kind: 'table',
      source: 'hubspot_ta_rules_t',
      rows: { kind: 'table-rows', labelCol: 'idx', labelHeader: '#' },
      canonical: { refs: ['hubspot_ta_rules_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'HubSpot pipeline per TA × month' },
    {
      kind: 'table',
      source: 'hubspot_per_ta_monthly',
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'TA',
        labelCol: 'ta',
        valueCol: 'hubspot',
        format: 'money',
      },
      totalsRow: { label: 'Total HubSpot pipeline', bold: true },
      rollup: yearRollup,
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'HubSpot pipeline by line item × month' },
    {
      kind: 'table',
      source: 'hubspot_pipeline_t',
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'Line item',
        labelCol: 'line_item',
        valueCol: 'value',
        format: 'money',
      },
      totalsRow: { label: 'Total', bold: true },
      rollup: yearRollup,
      canonical: { refs: ['hubspot_pipeline_t'] },
    },
  ],
};

// ─── Total Revenue ───────────────────────────────────────────────────────

const totalRevenueSection: ReportSection = {
  id: 'total-revenue',
  label: 'Total Revenue',
  hint: 'HubSpot pipeline + modeled per-TA revenue.',
  blocks: [
    { kind: 'title', text: 'Per-TA revenue (modeled + HubSpot + adjustments)' },
    { kind: 'paragraph', italic: true,
      text:
        'Each TA row stacks its modeled pipeline (platform + project + PM), its ' +
        'allocated HubSpot pipeline, any manual revenue adjustments, and the total. ' +
        'Deals are bucketed into TAs at sync time using the rules on the HubSpot tab; ' +
        'with the default config every HubSpot deal routes to Ophthalmology. ' +
        'Adjustments default to v4\'s six 2026 Ophthalmology budget tweaks.',
    },
    {
      kind: 'table',
      source: 'ta_monthly_with_hubspot',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        labelHeader: 'TA',
        rows: ACTIVE_TAS.flatMap((ta) => [
          { identity: { ta }, valueCol: 'total_modeled', label: `${ta} — modeled` },
          { identity: { ta }, valueCol: 'hubspot',       label: `${ta} — HubSpot` },
          { identity: { ta }, valueCol: 'adjustment',    label: `${ta} — adjustment` },
          { identity: { ta }, valueCol: 'total',         label: `${ta} — total`, bold: true },
        ]),
      },
      rollup: yearRollup,
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Manual revenue adjustments (per-TA per-month)' },
    { kind: 'paragraph', italic: true,
      text:
        'Each row adds `value` to one (TA, month) cell on top of modeled + HubSpot. ' +
        'Used to reproduce v4\'s hand-edited budget tweaks: Jan/Feb/Mar 2026 ' +
        'Ophthalmology formulas (`+ 33,165 × 1.32 − 8,000`, `+ 12,869 × 1.32`, ' +
        '`+ 31,919 × 1.32 − 26,900`) and the Oct/Nov/Dec 2026 hardcoded +$50k/mo ' +
        'pasted into Revenue!row 19. Together these close the previously-documented ' +
        '2026 gap of $217,998. Edit `value` to tune; idx/date are read-only labels.',
    },
    {
      kind: 'table',
      source: 'revenue_adjustments_t',
      rows: { kind: 'table-rows', labelCol: 'idx', labelHeader: '#' },
      canonical: { refs: ['revenue_adjustments_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Monthly revenue ($)' },
    {
      kind: 'table',
      source: 'ta_monthly_total',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        rows: [
          { source: 'hubspot_total_monthly', identity: {}, valueCol: 'hubspot',
            label: 'HubSpot pipeline (subtotal)', bold: true },
          ...ACTIVE_TAS.map((ta) => ({
            identity: { ta }, valueCol: 'total', label: ta,
          })),
          { source: 'modeled_total_monthly', identity: {}, valueCol: 'total',
            label: 'Modeled TAs (subtotal)', bold: true },
          { source: 'revenue_monthly', identity: {}, valueCol: 'revenue',
            label: 'Grand total (HubSpot + modeled)', bold: true },
        ],
      },
      rollup: yearRollup,
    },
  ],
};

// ─── Employees ───────────────────────────────────────────────────────────

const employeesSection: ReportSection = {
  id: 'employees',
  label: 'Employees',
  hint: 'Headcount roster and monthly cost build-up (loaded salary × inflation).',
  blocks: [
    { kind: 'title', text: 'Cost assumptions' },
    {
      kind: 'table',
      source: 'employee_assumptions_t',
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'ni_rate',               label: 'NI rate',               format: 'percent' },
          { col: 'pension_rate',          label: 'Pension rate',          format: 'percent' },
          { col: 'inflation_rate',        label: 'Annual inflation rate', format: 'percent' },
          { col: 'inflation_start_year',  label: 'Inflation start year',  format: 'integer' },
          { col: 'inflation_start_month', label: 'Inflation start month', format: 'integer' },
        ],
      },
      canonical: { refs: ['employee_assumptions_t'] },
    },
    { kind: 'spacer', rows: 1 },
    {
      kind: 'table',
      source: 'employee_assumptions_t',
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'max_inflation_steps',  label: 'Max inflation steps (v4 bug: 4)',  format: 'integer' },
          { col: 'inflate_future_hires', label: 'Inflate future hires (v4 bug: false)' },
        ],
      },
      canonical: { refs: ['employee_assumptions_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Salary adjustments (per-employee monthly multipliers)' },
    { kind: 'paragraph', italic: true,
      text:
        'Each row sets a multiplier on one employee\'s cleanly-computed monthly cost ' +
        'that applies from `month_idx` forward until a later row for the same employee ' +
        'overrides it. Default rows reproduce v4\'s hand-edited per-cell tweaks: ' +
        'Naaman Tammuz ×0.8 from Apr 2026, Blaise Thomson ×0.66 from Apr 2026 then ' +
        '×2.8052 from Apr 2027 (tracks Naaman\'s salary). Edit the factor and note ' +
        'columns; the employee, month, and date are read-only labels.',
    },
    {
      kind: 'table',
      source: 'employee_adjustments_sparse_t',
      rows: { kind: 'table-rows', labelCol: 'employee_id', labelHeader: 'Employee ID' },
      canonical: { refs: ['employee_adjustments_sparse_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Employees roster' },
    {
      kind: 'table',
      source: 'employees_t',
      rows: { kind: 'table-rows', labelCol: 'id', labelHeader: 'ID' },
      canonical: { refs: ['employees_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Employee cost by department × month (with actuals overlay)' },
    {
      kind: 'table',
      // Reads the actuals-overridden table so values match the Costs tab
      // and the Budget P&L. The raw per-employee sums (pre-overlay) are
      // visible via the engine explorer if needed.
      source: 'cost_dept_total_monthly_with_actuals',
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'Department',
        labelCol: 'cost_dept',
        valueCol: 'staff',
        format: 'money',
      },
      totalsRow: { label: 'Total employee cost', bold: true },
      rollup: yearRollup,
    },
  ],
};

// ─── Costs ───────────────────────────────────────────────────────────────

const COST_DEPTS = ['Sales and Marketing', 'G&A', 'Engineering', 'Product Support'];

/**
 * Line items per department, hardcoded from costs_data.json — used to build the
 * per-dept explicit-rows blocks. Note: S&M's "Commission" is intentionally
 * absent here because the engine replaces it with the derived
 * `sales_commission_monthly` (and would otherwise double-count).
 */
const COST_LINE_ITEMS: Record<string, string[]> = {
  'Sales and Marketing': [
    'US staff on-costs', 'Events', 'Comms', 'Web site', 'Advertising',
    'Consultants', 'Sales literature', 'Entertainment ',
    'Travel - National', 'Travel - International',
  ],
  'G&A': [
    'Bonus', 'Staff Welfare', 'Recruitment', 'Insurance', 'Rent',
    'Building costs', 'Cleaning', 'Telephone & Internet', 'IT costs',
    'Printing and stationery', 'Postage, freight and courier services',
    'Accounting and Audit', 'Professional Fees', 'Legal Fees', 'Consultants',
    'Subscriptions', 'Training', 'Travel', 'Entertaining', 'Bank charges',
    'Management Expenses',
  ],
  'Engineering': [
    'Bonus', 'Contractors', 'Consumables', 'Travel', 'Approvals',
    'Validation Data', 'Expenses and Consumables', 'IT Software and Consumables',
  ],
  'Product Support': [
    'Bonus', 'Travel', 'Technical services', 'IT Security',
  ],
};

/** Per-dept block (Staff Costs + derived Sales Commission for S&M + line items + Total). */
function perDeptBlocks(dept: string): ReportBlock[] {
  const lineItems = COST_LINE_ITEMS[dept] ?? [];
  const isSM = dept === 'Sales and Marketing';
  return [
    { kind: 'title', text: dept, level: 2 },
    {
      kind: 'table',
      source: 'cost_line_items_t',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        labelHeader: 'Line',
        rows: [
          { source: 'cost_dept_total_monthly_with_actuals',
            identity: { cost_dept: dept }, valueCol: 'staff',
            label: 'Staff Costs' },
          ...(isSM ? [{
            source: 'sales_commission_monthly',
            identity: {} as Record<string, string | number>,
            valueCol: 'sales_commission',
            label: 'Sales Commission (modeled)',
          }] : []),
          ...lineItems.map((li) => ({
            source: 'cost_line_items_t',
            identity: { dept, line_name: li },
            valueCol: 'value',
            label: li,
          })),
          { source: 'cost_dept_total_monthly_with_actuals',
            identity: { cost_dept: dept }, valueCol: 'total',
            label: `Total ${dept}`, bold: true },
        ],
      },
      rollup: yearRollup,
      defaultFormat: 'money',
      canonical: { refs: ['cost_line_items_t'] },
    },
    { kind: 'spacer', rows: 1 },
  ];
}

const costsSection: ReportSection = {
  id: 'costs',
  label: 'Costs',
  hint: 'Per-department budgets: Staff Costs (from Employees), Sales Commission (derived, S&M only), line items, and total — laid out like the v4 spreadsheet.',
  blocks: [
    { kind: 'title', text: 'Departmental cost detail' },
    ...COST_DEPTS.flatMap(perDeptBlocks),

    { kind: 'title', text: 'Roll-up: all departments (with actuals overlay)' },
    {
      kind: 'table',
      source: 'cost_dept_total_monthly_with_actuals',
      axis: monthAxis,
      rows: {
        kind: 'pivot-rows',
        labelHeader: 'Department',
        labelCol: 'cost_dept',
        valueCol: 'total',
        format: 'money',
      },
      totalsRow: { label: 'Total opex', bold: true },
      rollup: yearRollup,
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Per-dept yearly opex (derived from monthly + actuals)' },
    ...COST_DEPTS.flatMap((dept): ReportBlock[] => [
      { kind: 'title', text: dept, level: 3 },
      {
        kind: 'table',
        source: 'cost_dept_yearly',
        filter: { cost_dept: dept },
        rows: {
          kind: 'value-columns',
          rows: [
            { col: 'staff',     label: 'Staff' },
            { col: 'non_staff', label: 'Non-staff' },
            { col: 'total',     label: 'Total opex', bold: true },
          ],
        },
        defaultFormat: 'money',
      },
    ]),
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Per-dept monthly actuals (override modeled values)' },
    { kind: 'paragraph', italic: true,
      text:
        'Pin per-dept monthly opex to specific values when the modeled output drifts from v4 ' +
        '(e.g. G&A staff cost where v4\'s Employees sheet uses ad-hoc per-employee multipliers — ' +
        'David Friend × 0.66, blank "Extra" rows, no inflation in some cells — that our clean ' +
        '5%-each-April model doesn\'t replicate). Blank cells fall through to the modeled value. ' +
        'Yearly per-dept totals above derive automatically.',
    },
    ...COST_DEPTS.flatMap((dept): ReportBlock[] => [
      { kind: 'title', text: `${dept} — monthly actuals`, level: 3 },
      {
        kind: 'table',
        source: 'cost_dept_monthly_actuals_t',
        filter: { cost_dept: dept },
        axis: monthAxis,
        rows: {
          kind: 'value-columns',
          rows: [
            { col: 'staff_actual',     label: 'Staff (actual)' },
            { col: 'non_staff_actual', label: 'Non-staff (actual)' },
            { col: 'total_actual',     label: 'Total (actual)' },
          ],
        },
        rollup: yearRollup,
        defaultFormat: 'money',
        canonical: { refs: ['cost_dept_monthly_actuals_t'] },
      },
    ]),
  ],
};

// ─── Budget P&L ──────────────────────────────────────────────────────────

const budgetSection: ReportSection = {
  id: 'budget',
  label: 'Budget P&L',
  hint: 'Profit & Loss layout matching the v4 Budgets sheet — revenue per TA, cost of sales, gross profit, opex per dept, EBITDA.',
  blocks: [
    { kind: 'title', text: 'Capital depreciation (input)' },
    {
      kind: 'table',
      source: 'depreciation_t',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [{ col: 'value', label: 'Capital depreciation' }],
      },
      rollup: yearRollup,
      canonical: { refs: ['depreciation_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Sales commission overrides (per-month)' },
    { kind: 'paragraph', italic: true,
      text:
        'v4\'s S&M Commission line is fully hardcoded — every monthly cell is a ' +
        'pasted value with no underlying formula, and the late-year values ' +
        'plateau around $145k/month, well below what our cap-based formula ' +
        '`min(6k×starts + 12%×revenue, 1.5 × Total Sales Salary)` produces. ' +
        'Each cell here overrides the modelled value for that month. Defaults ' +
        'are populated from v4 (costs_data.json) so we match S&M Commission to ' +
        'the cent out of the box. Clear a cell to fall back to the formula.',
    },
    {
      kind: 'table',
      source: 'sales_commission_overrides_t',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [{ col: 'value', label: 'Sales commission (override; blank = formula)' }],
      },
      rollup: yearRollup,
      canonical: { refs: ['sales_commission_overrides_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Modeller commission adjustments (per-month additions)' },
    { kind: 'paragraph', italic: true,
      text:
        'Each row adds `value` (positive = additional cost) to the modelled ' +
        'monthly modeller commission. Defaults reproduce v4\'s four hand-entered ' +
        'Jan/Feb/Mar/May 2026 Budgets!row 22 entries — historic commitments paid ' +
        'before the AI-revenue ramp begins (where our `min(0.8 × AI_revenue, $30k)` ' +
        'formula yields $0). The May entry is a $5,000 hardcoded value with no ' +
        'formula in v4; Jan/Feb/Mar are GBP amounts scaled by 1.32 USD/GBP. Edit ' +
        '`value` to tune; idx/date are read-only labels.',
    },
    {
      kind: 'table',
      source: 'modeller_commission_adjustments_t',
      rows: { kind: 'table-rows', labelCol: 'idx', labelHeader: '#' },
      canonical: { refs: ['modeller_commission_adjustments_t'] },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Profit & Loss (monthly — with actuals overlay)' },
    {
      kind: 'table',
      source: 'budget_monthly_with_actuals',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        labelHeader: 'Line',
        rows: [
          // ── Revenue ──
          ...ACTIVE_TAS.map((ta) => ({
            source: 'ta_monthly_total',
            identity: { ta }, valueCol: 'total', label: ta,
          })),
          { source: 'hubspot_total_monthly',
            identity: {} as Record<string, string | number>,
            valueCol: 'hubspot', label: 'HubSpot pipeline (subtotal)' },
          { source: 'budget_monthly_with_actuals',
            identity: {} as Record<string, string | number>,
            valueCol: 'revenue', label: 'Total Revenue', bold: true },
          // ── Cost of Sales ──
          { source: 'modeller_commission_monthly',
            identity: {} as Record<string, string | number>,
            valueCol: 'modeller_commission', label: 'Modeller Commission' },
          { source: 'depreciation_t',
            identity: {} as Record<string, string | number>,
            valueCol: 'value', label: 'Capital depreciation' },
          { source: 'budget_monthly_with_actuals',
            identity: {} as Record<string, string | number>,
            valueCol: 'cost_of_sales', label: 'Total Cost of Sales', bold: true },
          // ── Gross Profit ──
          { source: 'budget_monthly_with_actuals',
            identity: {} as Record<string, string | number>,
            valueCol: 'gross_profit', label: 'GROSS PROFIT', bold: true },
          // ── Operating Expenses (per dept) ──
          ...COST_DEPTS.map((dept) => ({
            source: 'cost_dept_total_monthly_with_actuals',
            identity: { cost_dept: dept }, valueCol: 'total', label: dept,
          })),
          { source: 'budget_monthly_with_actuals',
            identity: {} as Record<string, string | number>,
            valueCol: 'total_opex', label: 'Total Opex', bold: true },
          // ── EBITDA ──
          { source: 'budget_monthly_with_actuals',
            identity: {} as Record<string, string | number>,
            valueCol: 'ebitda', label: 'EBITDA', bold: true },
        ],
      },
      rollup: yearRollup,
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Profit & Loss (yearly — derived from monthly with actuals)' },
    {
      kind: 'table',
      source: 'budget_yearly',
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'revenue',       label: 'Revenue', bold: true },
          { col: 'cost_of_sales', label: 'Cost of sales' },
          { col: 'gross_profit',  label: 'Gross profit', bold: true },
          { col: 'total_opex',    label: 'Total opex' },
          { col: 'ebitda',        label: 'EBITDA', bold: true },
        ],
      },
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Monthly P&L actuals (override modeled values to pin to v4)' },
    { kind: 'paragraph', italic: true,
      text:
        'Enter v4\'s monthly values here to override the modeled monthly P&L. Blank cells ' +
        'fall through to the modeled value; entering any number (including 0) pins the line ' +
        'to that value for that month. The monthly view above and yearly rollup both derive ' +
        'from these overrides — pasting the v4 monthly row gives a matching yearly total ' +
        'automatically.',
    },
    {
      kind: 'table',
      source: 'pnl_monthly_actuals_t',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'revenue_actual',       label: 'Revenue (actual)' },
          { col: 'cost_of_sales_actual', label: 'Cost of sales (actual)' },
          { col: 'gross_profit_actual',  label: 'Gross profit (actual)' },
          { col: 'total_opex_actual',    label: 'Total opex (actual)' },
          { col: 'ebitda_actual',        label: 'EBITDA (actual)' },
        ],
      },
      rollup: yearRollup,
      defaultFormat: 'money',
      canonical: { refs: ['pnl_monthly_actuals_t'] },
    },
    { kind: 'paragraph', italic: true,
      text:
        'v4 P&L below EBITDA — Other Income / Exceptional / Interest / Depreciation (below-line) ' +
        '/ Amortisation / Financing Costs / Tax (R&D credit) / Corporation Tax — is zero or ' +
        'immaterial in the v4 forecast (Tax R&D credit ≈ $70–90k/yr, Corporation Tax kicks in ' +
        '2029+ and tracks 19% of operating profit). The Balance Sheet\'s Current earnings line ' +
        'uses cumulative EBITDA as the proxy for profit-after-tax, which is exact for the ' +
        'forecast period and within ~5% once Corporation Tax begins.',
    },
  ],
};

// ─── Balance Sheet ──────────────────────────────────────────────────────
//
// Layout mirrors v4's Budgets-sheet Balance Sheet. Every line in v4's layout
// flows from `bs_summary_monthly` (one row per month, every BS line as a
// column). Year-end columns are the December values, not sums — this is
// achieved by setting `yearTotals: false` and instead exposing the full
// monthly grid; the rollup writes `grandTotal: true` to also show the end of
// the horizon.

/** Opening BS assumptions — kept editable as a single-row canonical block. */
const openingBsBlock: ReportBlock = {
  kind: 'table',
  source: 'opening_bs_t',
  rows: {
    kind: 'value-columns',
    rows: [
      { col: 'opening_cash',              label: 'Opening cash',                 format: 'money' },
      { col: 'opening_tangible_assets',   label: 'Opening tangible assets',      format: 'money' },
      { col: 'opening_intangible_assets', label: 'Opening intangible assets',    format: 'money' },
      { col: 'opening_trade_debtors',     label: 'Opening trade debtors',        format: 'money' },
      { col: 'opening_other_debtors',     label: 'Other debtors (constant)',     format: 'money' },
      { col: 'opening_vat',               label: 'VAT (constant)',               format: 'money' },
      { col: 'opening_trade_creditors',   label: 'Opening trade creditors (–)',  format: 'money' },
      { col: 'opening_deferred_revenue',  label: 'Deferred revenue (constant)',  format: 'money' },
      { col: 'opening_other_creditors',   label: 'Other creditors (constant)',   format: 'money' },
      { col: 'opening_loans',             label: 'Opening loans (–)',            format: 'money' },
      { col: 'share_capital',             label: 'Share capital',                format: 'money' },
      { col: 'share_premium',             label: 'Share premium',                format: 'money' },
      { col: 'other_reserve',             label: 'Other reserve',                format: 'money' },
      { col: 'bfwd_retained_earnings',    label: 'BFWD retained earnings',       format: 'money' },
    ],
  },
  canonical: { refs: ['opening_bs_t'] },
};

const bsAssumptionsBlock: ReportBlock = {
  kind: 'table',
  source: 'bs_assumptions_t',
  rows: {
    kind: 'value-columns',
    rows: [
      { col: 'ar_days',                label: 'AR days (drives trade debtors)',    format: 'integer' },
      { col: 'ap_days',                label: 'AP days (drives trade creditors)',  format: 'integer' },
      { col: 'monthly_loan_repayment', label: 'Monthly loan repayment',            format: 'money' },
    ],
  },
  canonical: { refs: ['bs_assumptions_t'] },
};

const balanceSheetSection: ReportSection = {
  id: 'balance-sheet',
  label: 'Balance Sheet',
  hint:
    'v4-aligned balance sheet built from the opening position + monthly P&L. ' +
    'Tangible assets write down via cumulative depreciation; trade debtors / creditors ' +
    'scale with revenue / opex via AR & AP days; cash closes the loop (Net Assets = Equity).',
  blocks: [
    { kind: 'title', text: 'Opening position' },
    openingBsBlock,
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Working-capital + loan assumptions' },
    bsAssumptionsBlock,
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Balance Sheet (monthly, end-of-period — with actuals overlay)' },
    {
      kind: 'table',
      source: 'bs_summary_monthly_with_actuals',
      axis: monthAxis,
      rows: {
        kind: 'explicit',
        labelHeader: 'Line',
        rows: [
          // ── Fixed Assets ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'intangible_assets',
            label: 'Intangible Assets' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'tangible_assets',
            label: 'Tangible Assets' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'total_fixed_assets',
            label: 'Total Fixed Assets', bold: true },
          // ── Current Assets ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'trade_debtors',
            label: 'Trade Debtors' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'other_debtors',
            label: 'Other debtors' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'vat',
            label: 'VAT' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'cash',
            label: 'Cash' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'total_current_assets',
            label: 'Total Current Assets', bold: true },
          // ── Current Liabilities ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'trade_creditors',
            label: 'Trade Creditors' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'deferred_revenue',
            label: 'Deferred Revenue' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'other_creditors',
            label: 'Other creditors' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'total_current_liabilities',
            label: 'Total Current Liabilities', bold: true },
          // ── Loans ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'loans',
            label: 'Loans' },
          // ── Net Assets ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'net_assets',
            label: 'Net Assets', bold: true },
          // ── Equity ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'share_capital',
            label: 'Share capital' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'share_premium',
            label: 'Share premium' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'other_reserve',
            label: 'Other reserve' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'bfwd_retained_earnings',
            label: 'BFWD retained earnings' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'current_earnings',
            label: 'Current earnings (cumulative EBITDA)' },
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'total_equity',
            label: 'Total Equity', bold: true },
          // ── Check ──
          { source: 'bs_summary_monthly_with_actuals', identity: {}, valueCol: 'difference',
            label: 'Difference (Net Assets − Equity)' },
        ],
      },
      rollup: { grandTotal: true, grandTotalLabel: 'End of horizon' },
      defaultFormat: 'money',
    },
    { kind: 'paragraph', italic: true,
      text:
        'Modeling notes: (1) Tangible assets are clamped at zero — once cumulative ' +
        'depreciation exceeds the opening balance the asset is fully written down ' +
        '(no new capex modeled). (2) Trade debtors = revenue × AR days / 30, trade ' +
        'creditors = cash opex × AP days / 30 — stylised, not modeled at the ' +
        'invoice/payment level. (3) Current earnings proxy = cumulative EBITDA ' +
        '(below-EBITDA P&L lines — interest, tax, amortisation — are zero in v4 ' +
        'forecast, so this is exact for the forecast period). (4) Cash includes ' +
        'opening cash, cumulative EBITDA, depreciation add-back (capped at the ' +
        'opening tangible balance so we don\'t add back depreciation on assets ' +
        'we never had), Δ AR, Δ AP, and loan repayments — so the BS balances ' +
        '(Difference rounds to zero).',
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Balance Sheet (yearly — end-of-year, derived)' },
    {
      kind: 'table',
      source: 'bs_yearly_with_actuals',
      axis: { col: 'year', labels: 'raw' },
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'intangible_assets',         label: 'Intangible Assets' },
          { col: 'tangible_assets',           label: 'Tangible Assets' },
          { col: 'total_fixed_assets',        label: 'Total Fixed Assets', bold: true },
          { col: 'trade_debtors',             label: 'Trade Debtors' },
          { col: 'other_debtors',             label: 'Other debtors' },
          { col: 'vat',                       label: 'VAT' },
          { col: 'cash',                      label: 'Cash' },
          { col: 'total_current_assets',      label: 'Total Current Assets', bold: true },
          { col: 'trade_creditors',           label: 'Trade Creditors' },
          { col: 'deferred_revenue',          label: 'Deferred Revenue' },
          { col: 'other_creditors',           label: 'Other creditors' },
          { col: 'total_current_liabilities', label: 'Total Current Liabilities', bold: true },
          { col: 'loans',                     label: 'Loans' },
          { col: 'net_assets',                label: 'Net Assets', bold: true },
          { col: 'share_capital',             label: 'Share capital' },
          { col: 'share_premium',             label: 'Share premium' },
          { col: 'other_reserve',             label: 'Other reserve' },
          { col: 'bfwd_retained_earnings',    label: 'BFWD retained earnings' },
          { col: 'current_earnings',          label: 'Current earnings' },
          { col: 'total_equity',              label: 'Total Equity', bold: true },
          { col: 'difference',                label: 'Difference (Net Assets − Equity)' },
        ],
      },
      defaultFormat: 'money',
    },
    { kind: 'spacer', rows: 2 },

    { kind: 'title', text: 'Monthly BS actuals (override modeled values)' },
    { kind: 'paragraph', italic: true,
      text:
        'Pin individual balance sheet lines to v4 monthly values. Subtotals ' +
        '(Total Fixed Assets, Current Assets/Liabilities, Net Assets, Total Equity) ' +
        'recompute from the overridden lines per month. The yearly view above picks ' +
        'the December (end-of-year) rows. The Difference row shows how far the ' +
        'overridden BS is from balancing.',
    },
    {
      kind: 'table',
      source: 'bs_monthly_actuals_t',
      axis: monthAxis,
      rows: {
        kind: 'value-columns',
        rows: [
          { col: 'intangible_assets_actual',       label: 'Intangible Assets (actual)' },
          { col: 'tangible_assets_actual',         label: 'Tangible Assets (actual)' },
          { col: 'trade_debtors_actual',           label: 'Trade Debtors (actual)' },
          { col: 'other_debtors_actual',           label: 'Other debtors (actual)' },
          { col: 'vat_actual',                     label: 'VAT (actual)' },
          { col: 'cash_actual',                    label: 'Cash (actual)' },
          { col: 'trade_creditors_actual',         label: 'Trade Creditors (actual)' },
          { col: 'deferred_revenue_actual',        label: 'Deferred Revenue (actual)' },
          { col: 'other_creditors_actual',         label: 'Other creditors (actual)' },
          { col: 'loans_actual',                   label: 'Loans (actual)' },
          { col: 'share_capital_actual',           label: 'Share capital (actual)' },
          { col: 'share_premium_actual',           label: 'Share premium (actual)' },
          { col: 'other_reserve_actual',           label: 'Other reserve (actual)' },
          { col: 'bfwd_retained_earnings_actual',  label: 'BFWD retained earnings (actual)' },
          { col: 'current_earnings_actual',        label: 'Current earnings (actual)' },
        ],
      },
      defaultFormat: 'money',
      canonical: { refs: ['bs_monthly_actuals_t'] },
    },
  ],
};

export const salesReport: ReportDef = {
  calendarRef: 'dates_t',
  // dates_t is hidden so inline date expansions (CONCATENATE chains) collapse
  // into single cell refs — without this, per-employee × month formulas
  // blow past Excel's 8192-char formula limit.
  // Materialize per_employee_monthly_cost in a hidden helper sheet so the
  // per-dept staff cost cells reference addressed cells (a short SUM range)
  // rather than re-expanding the end-date + inflation-cap + future-hire cascade
  // for each of ~15 employees per dept. Without this the per-dept-month cells
  // exceed Excel's 8192-char formula limit.
  hiddenSheets: ['dates_t', 'per_employee_monthly_cost'],
  sections: [
    revenueModelSection,
    totalRevenueSection,
    hubspotSection,
    employeesSection,
    costsSection,
    budgetSection,
    balanceSheetSection,
  ],
};
