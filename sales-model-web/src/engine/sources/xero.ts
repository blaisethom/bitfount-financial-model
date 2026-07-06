// Xero source adapters. The `xero_actuals` adapter fetches P&L / cost-dept /
// BS actuals from Xero's Reports API via the server-side /api/xero/sync
// endpoint. The `xero_cost_line` adapter fetches per-(dept, line_name) actuals
// at individual cost-line granularity (travel, software, etc.).
//
// Both adapters are stubs — they call the same /api/xero/sync endpoint and
// transform the response into the appropriate engine Table schema. Auth uses
// Xero OAuth 2.0 tokens held server-side; clients never touch the token.
//
// Sync flow:
//   1. User clicks "Sync from xero_actuals" in the engine explorer.
//   2. App calls runXeroSync() which hits /api/xero/sync.
//   3. buildActualsFromXero() transforms the response into ModelInput.actuals.
//   4. flattenModelInput() expands actuals into the three *_actuals_t tables and
//      cost_line_actuals_t, which are passed as prefetchedSources.
//
// These adapters exist so the YAML model can express "this table is sourced from
// Xero" with kind: api / adapter: xero_actuals, rather than kind: manual.
// materializeApiSources() is NOT used for these — the sync runs through App.tsx
// so model state can be saved as a new scenario.

import type { Table, TableSchema } from '../types';
import type { SourceAdapter } from './index';

export interface XeroActualsConfig {
  /** Which Xero entity to fetch ('pnl' | 'cost_dept' | 'bs'). Passed at sync time. */
  entity?: 'pnl' | 'cost_dept' | 'bs';
}

export interface XeroCostLineConfig {
  /** Optional date range filter (YYYY-MM). */
  dateRange?: { from: string; to: string };
}

export const xeroActualsAdapter: SourceAdapter<XeroActualsConfig> = {
  id: 'xero_actuals',
  async fetch(_config: XeroActualsConfig, schema: TableSchema): Promise<Table> {
    const res = await fetch('/api/xero/sync');
    if (!res.ok) throw new Error(`Xero sync failed: ${res.statusText}`);
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Xero sync error: ${data.error}`);
    // Full transformation happens in buildActualsFromXero (xero.ts) via App.tsx.
    // If called directly, return empty — use runXeroSync() in App to update state.
    return { schema, rows: [] };
  },
};

export const xeroCostLineAdapter: SourceAdapter<XeroCostLineConfig> = {
  id: 'xero_cost_line',
  async fetch(_config: XeroCostLineConfig, schema: TableSchema): Promise<Table> {
    const res = await fetch('/api/xero/sync');
    if (!res.ok) throw new Error(`Xero cost-line sync failed: ${res.statusText}`);
    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Xero cost-line sync error: ${data.error}`);
    // Full transformation happens in buildActualsFromXero (xero.ts) via App.tsx.
    return { schema, rows: [] };
  },
};
