// Identity-column inference for engine tables.
//
// Every table has an "identity" — the column tuple that uniquely identifies
// a row. Sources declare it; step outputs inherit and transform it based on
// the producing step's op (select/rename project, groupBy replaces with
// keys, map/window/cross/join pass through; cross extends with the right
// table's identity columns).
//
// Both the Excel renderer and the React renderer use this to address rows
// (e.g. "row in ta_monthly_total where ta='Ophthalmology' AND month_idx=5").

import type { ModelDef, TableOp } from '../engine';

/** Identity columns per source table in the sales model. */
export const SOURCE_IDENTITY: Record<string, string[]> = {
  month_indices: ['month_idx'],
  pricing_t: ['type'],
  schedule_t: ['ta', 'type', 'month_idx'],
  hubspot_pipeline_t: ['ta', 'line_item', 'month_idx'],
  hubspot_ta_rules_t: ['idx'],
  revenue_adjustments_t: ['idx'],
  revenue_adjustment_per_ta_monthly_t: ['ta', 'month_idx'],
  modeller_commission_adjustments_t: ['idx'],
  modeller_commission_adjustment_per_month_t: ['month_idx'],
  sales_commission_overrides_t: ['month_idx'],
  employees_t: ['id'],
  employee_assumptions_t: [],
  commission_t: [],
  cost_line_items_t: ['dept', 'line_name', 'month_idx'],
  depreciation_t: ['month_idx'],
  rd_tax_credit_t: ['month_idx'],
  interest_income_t: ['month_idx'],
  dept_to_tab_t: ['employee_dept'],
  // Balance Sheet inputs (single-row assumption tables)
  opening_bs_t: [],
  bs_assumptions_t: [],
  // Per-month BS schedule: capex, loan repayments, WC trajectories (TC/OD/VAT/OC)
  bs_monthly_schedule_t: ['month_idx'],
  // Employees with optional end_date + sales-cap flag (extended schema)
  // (employees_t identity already defined above as ['id'])
  // Actuals overlays (one row per month_idx, optionally per cost_dept)
  pnl_monthly_actuals_t: ['month_idx'],
  cost_dept_monthly_actuals_t: ['cost_dept', 'month_idx'],
  bs_monthly_actuals_t: ['month_idx'],
  // Per-employee salary adjustments
  employee_adjustments_sparse_t: ['employee_id', 'month_idx'],
  employee_factors_t: ['employee_id', 'month_idx'],
};

export class IdentityResolver {
  private cache = new Map<string, string[]>();
  private model: ModelDef;
  constructor(model: ModelDef) { this.model = model; }

  for(tableRef: string): string[] {
    const cached = this.cache.get(tableRef);
    if (cached) return cached;
    const result = this.compute(tableRef);
    this.cache.set(tableRef, result);
    return result;
  }

  private compute(tableRef: string): string[] {
    if (SOURCE_IDENTITY[tableRef] !== undefined) return SOURCE_IDENTITY[tableRef];
    const step = this.model.steps.find((s) => s.output === tableRef);
    if (!step) return [];
    const inputId = this.for(step.input);
    switch (step.op.op) {
      case 'map':
        return inputId;
      case 'select':
        return inputId.filter((c) => (step.op as { columns: string[] }).columns.includes(c));
      case 'rename': {
        const renames = (step.op as { renames: Record<string, string> }).renames;
        return inputId.map((c) => renames[c] ?? c);
      }
      case 'groupBy':
        return (step.op as { keys: string[] }).keys;
      case 'window':
        return inputId;
      case 'join': {
        const opJ = step.op as Extract<TableOp, { op: 'join' }>;
        if (opJ.type === 'cross') {
          const rightId = this.for(opJ.right);
          return [...inputId, ...rightId.filter((c) => !inputId.includes(c))];
        }
        return inputId;
      }
      case 'union':
      case 'sort':
      case 'limit':
      case 'filter':
        return inputId;
    }
  }
}
