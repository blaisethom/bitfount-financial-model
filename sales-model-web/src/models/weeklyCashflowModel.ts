// Engine model for the weekly cashflow forecast.
//
// Data is split into two time periods:
//   actuals_t          — weeks 0–34 (historical). All rows baked in as a
//                        literal — these are closed-period facts, not assumptions.
//   forecast_items_t   — weeks 35–97 (forecast). Individual line items only,
//                        as a `manual` source so users can edit assumptions.
//
// The engine then computes forecast totals and the running closing balance:
//   total_inflow  = groupBy sum of inflow line items per week
//   total_outflows = groupBy sum of outflow line items per week
//   closing_balance = last_actual_closing + running_sum(net_flow + capital_events)
//   opening_balance  = closing_balance − net_flow
//
// Shaped computed rows are unioned with actuals + forecast_items to produce
// `cashflow_t`, which the YAML report consumes unchanged.

import {
  defineModel, literal, manual, ops, agg, col, lit, eq, or, sub, add, coalesce,
} from '../engine';
import type { Column, Expr, ModelDef } from '../engine';
import cashflowRaw from '../weekly_cashflow_data.json';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  label: string;
  kind: string;
  indent: number;
  values?: (number | null)[];
}

// ── Build week calendar ───────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const weekRows = (cashflowRaw.weeks as string[]).map((isoDate, idx) => {
  const [yyyy, mm, dd] = isoDate.split('-');
  return {
    month_idx: idx,
    date: `${parseInt(dd, 10)} ${MONTH_ABBR[parseInt(mm, 10) - 1]}`,
    year: parseInt(yyyy, 10),
  };
});

// ── Build long-format cashflow rows ───────────────────────────────────────────

const LONG_SCHEMA_COLS: Column[] = [
  { name: 'row_id', type: 'string' },
  { name: 'row_label', type: 'string' },
  { name: 'row_kind', type: 'string' },
  { name: 'row_indent', type: 'number' },
  { name: 'month_idx', type: 'number' },
  { name: 'value', type: 'number' },
];

type LongRow = {
  row_id: string;
  row_label: string;
  row_kind: string;
  row_indent: number;
  month_idx: number;
  value: number;
};

const allCashflowRows: LongRow[] = [];
for (const row of cashflowRaw.rows as RawRow[]) {
  if (!row.values) continue;
  for (let i = 0; i < row.values.length; i++) {
    allCashflowRows.push({
      row_id: row.id,
      row_label: row.label,
      row_kind: row.kind,
      row_indent: row.indent,
      month_idx: i,
      value: row.values[i] ?? 0,
    });
  }
}

// ── Cutoff and anchor values ──────────────────────────────────────────────────

// Week 35 is the first forecast week (2026-06-19). Weeks 0–34 are historical actuals.
const CUTOFF = 35;

// The closing balance at the end of week 34 (last historical week). This is the
// anchor from which the running forecast balance is computed.
const LAST_ACTUAL_CLOSING =
  allCashflowRows.find(r => r.row_id === 'closing_balance' && r.month_idx === CUTOFF - 1)?.value ?? 0;

// The opening balance for week 35 from the original Excel model includes a
// planned capital injection (fundraise). We seed capital_events_t with this.
const FORECAST_OPENING =
  allCashflowRows.find(r => r.row_id === 'opening_balance' && r.month_idx === CUTOFF)?.value ?? LAST_ACTUAL_CLOSING;
const INITIAL_CAPITAL = FORECAST_OPENING - LAST_ACTUAL_CLOSING;

// ── Rows excluded from the editable forecast source ───────────────────────────
// These are derived/computed: the engine produces them via aggregation steps.
const SUMMARY_IDS = new Set([
  'opening_balance', 'total_inflow', 'total_outflows', 'closing_balance', 'closing_prior',
]);

// ── Expression helper ─────────────────────────────────────────────────────────

function inRowIds(ids: string[]): Expr {
  if (ids.length === 1) return eq(col('row_id'), lit(ids[0]));
  return or(eq(col('row_id'), lit(ids[0])), inRowIds(ids.slice(1)));
}

// ── Row ID lists ──────────────────────────────────────────────────────────────

// Line-item IDs used for groupBy computation (total rows excluded — those are computed).
const INFLOW_LINE_IDS = [
  'inv_character', 'inv_bi', 'inv_bi2', 'inv_bi3', 'inv_bi4',
  'us_commission', 'ltd_deposit', 'rd_tax', 'invest_income', 'vat',
];
const OUTFLOW_LINE_IDS = [
  'altris_commission', 'computers',
  'uk_salaries', 'uk_pension', 'uk_salary_tax', 'uk_psa', 'uk_commission',
  'us_salaries', 'us_cust_success', 'us_pension', 'us_salary_tax', 'us_medical', 'us_travel', 'us_other',
  'ga_accountants', 'ga_grenke', 'ga_cf', 'ga_fora', 'ga_insurance', 'ga_bank',
  'ga_baker_tilley', 'ga_it_hw', 'ga_it_sec', 'ga_ikites', 'ga_legal_edge',
  'ga_hr_lawyers', 'ga_ip_lawyers', 'ga_recruitment', 'ga_welfare', 'ga_travel',
  'ga_bluejay', 'ga_ppd_repay', 'ga_general', 'ga_insure', 'ga_coaching', 'ga_consultant',
  'sm_advertising', 'sm_exhibitions', 'emr_altris',
  'fr_sidecar', 'fr_v2s', 'fr_alex',
];

// For downstream report display filters (includes the computed total row).
const INFLOW_IDS = [...INFLOW_LINE_IDS, 'total_inflow'];
const OUTFLOW_IDS = [...OUTFLOW_LINE_IDS, 'total_outflows'];
const BANK_IDS = [
  'bank_us', 'bank_hsbc_usd', 'bank_hsbc_gbp', 'bank_revolut_usd',
  'bank_telleroo', 'bank_revolut_gbp', 'bank_barclays',
  'bank_total', 'bank_diff', 'insignis',
];

// ── Model ─────────────────────────────────────────────────────────────────────

export const weeklyCashflowModel: ModelDef = defineModel({
  defaultAxis: 'month_idx',
  outputs: [],

  sources: {
    weeks_t: literal({
      description: 'Week calendar — index (month_idx) → compact date label + calendar year.',
      schema: {
        columns: [
          { name: 'month_idx', type: 'number' },
          { name: 'date', type: 'string' },
          { name: 'year', type: 'number' },
        ],
      },
      rows: weekRows,
    }),

    actuals_t: literal({
      description:
        `Historical cashflow actuals for weeks 0–${CUTOFF - 1} (through the last closed week). ` +
        'All line items plus pre-computed totals and balances. These are immutable historical facts.',
      schema: { columns: LONG_SCHEMA_COLS },
      rows: allCashflowRows.filter(r => r.month_idx < CUTOFF),
    }),

    forecast_items_t: manual({
      description:
        `Editable forecast assumptions for weeks ${CUTOFF}–${cashflowRaw.weeks.length - 1}. ` +
        'Contains individual inflow, outflow, and bank line items only. ' +
        'Totals (total_inflow, total_outflows) and balances (opening_balance, closing_balance) ' +
        'are computed automatically by the engine steps below.',
      schema: { columns: LONG_SCHEMA_COLS },
      defaults: allCashflowRows.filter(
        r => r.month_idx >= CUTOFF && !SUMMARY_IDS.has(r.row_id),
      ),
    }),

    capital_events_t: manual({
      description:
        'Planned capital injections — fundraises, loans, or other one-time cash events. ' +
        'Each row is one event: the week index (month_idx), a description, and the GBP amount. ' +
        'Multiple events in the same week are summed.',
      schema: {
        columns: [
          { name: 'month_idx', type: 'number' },
          { name: 'description', type: 'string' },
          { name: 'amount', type: 'number' },
        ],
      },
      defaults: INITIAL_CAPITAL !== 0
        ? [{ month_idx: CUTOFF, description: 'Fundraise', amount: Math.round(INITIAL_CAPITAL) }]
        : [],
    }),
  },

  steps: [
    // ─── Forecast: aggregate inflows per week ────────────────────────────────

    {
      id: 'fi_inflow_raw_t',
      name: 'Forecast inflow items',
      description: 'Filter the editable forecast to individual inflow line items, excluding the computed total row.',
      input: 'forecast_items_t',
      op: ops.filter(inRowIds(INFLOW_LINE_IDS)),
    },
    {
      id: 'fi_inflow_weekly_t',
      name: 'Forecast inflow total per week',
      description: 'Sum all forecast inflow line items by week — this becomes the total_inflow row for forecast weeks.',
      input: 'fi_inflow_raw_t',
      op: ops.groupBy(['month_idx'], { total_inflow: agg.sum('value') }),
    },

    // ─── Forecast: aggregate outflows per week ───────────────────────────────

    {
      id: 'fi_outflow_raw_t',
      name: 'Forecast outflow items',
      description: 'Filter the editable forecast to individual outflow line items, excluding the computed total row.',
      input: 'forecast_items_t',
      op: ops.filter(inRowIds(OUTFLOW_LINE_IDS)),
    },
    {
      id: 'fi_outflow_weekly_t',
      name: 'Forecast outflow total per week',
      description: 'Sum all forecast outflow line items by week — this becomes the total_outflows row for forecast weeks.',
      input: 'fi_outflow_raw_t',
      op: ops.groupBy(['month_idx'], { total_outflows: agg.sum('value') }),
    },

    // ─── Net flow = inflow − outflows ────────────────────────────────────────

    {
      id: 'fi_net_raw_t',
      name: 'Join weekly inflow and outflow totals',
      description: 'Inner join to produce one row per forecast week with both total_inflow and total_outflows.',
      input: 'fi_inflow_weekly_t',
      op: ops.join('fi_outflow_weekly_t', [{ left: 'month_idx', right: 'month_idx' }], 'inner'),
    },

    // ─── Capital events ──────────────────────────────────────────────────────

    {
      id: 'fi_capital_weekly_t',
      name: 'Capital events by week',
      description: 'Aggregate capital injection amounts by week. Multiple events in the same week are summed into capital_total.',
      input: 'capital_events_t',
      op: ops.groupBy(['month_idx'], { capital_total: agg.sum('amount') }),
    },
    {
      id: 'fi_with_capital_t',
      name: 'Add capital events to net flow',
      description: 'Left join capital events into the weekly net flow table. Weeks with no capital event get capital_total = null (treated as 0 in the next step).',
      input: 'fi_net_raw_t',
      op: ops.join('fi_capital_weekly_t', [{ left: 'month_idx', right: 'month_idx' }], 'left'),
    },

    // ─── Compute net flow and adjusted net (includes capital) ─────────────────

    {
      id: 'fi_net1_t',
      name: 'Compute net flow and capital adjustment',
      description:
        'net_flow = total_inflow − total_outflows. ' +
        'capital_adj = capital event amount for this week (0 if none).',
      input: 'fi_with_capital_t',
      op: ops.map({
        net_flow: sub(col('total_inflow'), col('total_outflows')),
        capital_adj: coalesce(col('capital_total'), lit(0)),
      }),
    },
    {
      id: 'fi_adj_t',
      name: 'Adjusted net flow',
      description: 'adjusted_net = net_flow + capital_adj. The per-week change to total cash position, including any planned capital injections.',
      input: 'fi_net1_t',
      op: ops.map({ adjusted_net: add(col('net_flow'), col('capital_adj')) }),
    },

    // ─── Running balance ─────────────────────────────────────────────────────

    {
      id: 'fi_cumulative_t',
      name: 'Cumulative adjusted net flow',
      description:
        `Running sum of adjusted_net from week ${CUTOFF} onwards. ` +
        `When added to the last actual closing balance (${Math.round(LAST_ACTUAL_CLOSING).toLocaleString()}), gives the forecast closing balance for each week.`,
      input: 'fi_adj_t',
      op: ops.window({
        partitionBy: [],
        orderBy: 'month_idx',
        range: { preceding: 9999, following: 0 },
        derive: { cumulative_adj: agg.sum('adjusted_net') },
      }),
    },
    {
      id: 'fi_balances_t',
      name: 'Forecast closing and opening balance',
      description:
        `closing_balance = ${Math.round(LAST_ACTUAL_CLOSING).toLocaleString()} + cumulative_adj. ` +
        'opening_balance = closing_balance − net_flow (cash position before this week\'s transactions).',
      input: 'fi_cumulative_t',
      op: ops.map({
        closing_balance: add(lit(LAST_ACTUAL_CLOSING), col('cumulative_adj')),
        opening_balance: sub(add(lit(LAST_ACTUAL_CLOSING), col('cumulative_adj')), col('net_flow')),
      }),
    },

    // ─── Shape computed totals into long-format rows ──────────────────────────

    {
      id: 'fi_tinflow_map_t',
      name: 'Shape total_inflow rows (map)',
      description: 'Add long-format identity columns to the computed weekly inflow total.',
      input: 'fi_inflow_weekly_t',
      op: ops.map({
        row_id: lit('total_inflow'),
        row_label: lit('Total Inflow'),
        row_kind: lit('total'),
        row_indent: lit(0),
        value: col('total_inflow'),
      }),
    },
    {
      id: 'fi_tinflow_long_t',
      name: 'Shape total_inflow rows (select)',
      description: 'Trim to the standard long-format schema: (row_id, row_label, row_kind, row_indent, month_idx, value).',
      input: 'fi_tinflow_map_t',
      op: ops.select(['row_id', 'row_label', 'row_kind', 'row_indent', 'month_idx', 'value']),
    },

    {
      id: 'fi_toutflows_map_t',
      name: 'Shape total_outflows rows (map)',
      description: 'Add long-format identity columns to the computed weekly outflow total.',
      input: 'fi_outflow_weekly_t',
      op: ops.map({
        row_id: lit('total_outflows'),
        row_label: lit('Total Outflows'),
        row_kind: lit('total'),
        row_indent: lit(0),
        value: col('total_outflows'),
      }),
    },
    {
      id: 'fi_toutflows_long_t',
      name: 'Shape total_outflows rows (select)',
      description: 'Trim to the standard long-format schema.',
      input: 'fi_toutflows_map_t',
      op: ops.select(['row_id', 'row_label', 'row_kind', 'row_indent', 'month_idx', 'value']),
    },

    {
      id: 'fi_closing_map_t',
      name: 'Shape closing_balance rows (map)',
      description: 'Add long-format identity columns to the computed weekly closing balance.',
      input: 'fi_balances_t',
      op: ops.map({
        row_id: lit('closing_balance'),
        row_label: lit('Closing cash balance'),
        row_kind: lit('balance'),
        row_indent: lit(0),
        value: col('closing_balance'),
      }),
    },
    {
      id: 'fi_closing_long_t',
      name: 'Shape closing_balance rows (select)',
      description: 'Trim to the standard long-format schema.',
      input: 'fi_closing_map_t',
      op: ops.select(['row_id', 'row_label', 'row_kind', 'row_indent', 'month_idx', 'value']),
    },

    {
      id: 'fi_opening_map_t',
      name: 'Shape opening_balance rows (map)',
      description: 'Add long-format identity columns to the computed weekly opening balance.',
      input: 'fi_balances_t',
      op: ops.map({
        row_id: lit('opening_balance'),
        row_label: lit('Opening cash balance'),
        row_kind: lit('balance'),
        row_indent: lit(0),
        value: col('opening_balance'),
      }),
    },
    {
      id: 'fi_opening_long_t',
      name: 'Shape opening_balance rows (select)',
      description: 'Trim to the standard long-format schema.',
      input: 'fi_opening_map_t',
      op: ops.select(['row_id', 'row_label', 'row_kind', 'row_indent', 'month_idx', 'value']),
    },

    // ─── Combine into the unified cashflow table ──────────────────────────────

    {
      id: 'cashflow_t',
      name: 'Combined cashflow table',
      description:
        `Union of historical actuals (weeks 0–${CUTOFF - 1}), ` +
        `editable forecast line items (weeks ${CUTOFF}–${cashflowRaw.weeks.length - 1}), ` +
        'and computed forecast totals and balances. This is the table all report sections consume.',
      input: 'actuals_t',
      op: ops.union([
        'forecast_items_t',
        'fi_tinflow_long_t',
        'fi_toutflows_long_t',
        'fi_closing_long_t',
        'fi_opening_long_t',
      ]),
    },

    // ─── Downstream filter steps (used by report chart refs and display) ──────

    {
      id: 'closing_balance_weekly',
      name: 'Closing Balance',
      description: 'Weekly closing cash balance — drives the cash runway chart and the summary table.',
      input: 'cashflow_t',
      op: ops.filter(eq(col('row_id'), lit('closing_balance'))),
    },
    {
      id: 'opening_balance_weekly',
      name: 'Opening Balance',
      description: 'Weekly opening cash balance — historical actuals for closed weeks, model-computed for forecast weeks.',
      input: 'cashflow_t',
      op: ops.filter(eq(col('row_id'), lit('opening_balance'))),
    },
    {
      id: 'inflows_weekly',
      name: 'Inflows',
      description: 'All inflow line items plus the computed weekly total — used for the Inflows report section.',
      input: 'cashflow_t',
      op: ops.filter(inRowIds(INFLOW_IDS)),
    },
    {
      id: 'outflows_weekly',
      name: 'Outflows',
      description: 'All outflow line items plus the computed weekly total — used for the Outflows report section.',
      input: 'cashflow_t',
      op: ops.filter(inRowIds(OUTFLOW_IDS)),
    },
    {
      id: 'bank_accounts_weekly',
      name: 'Bank Accounts',
      description: 'Bank account balances — actual for closed weeks, manual projections for forecast weeks.',
      input: 'cashflow_t',
      op: ops.filter(inRowIds(BANK_IDS)),
    },
  ],
});
