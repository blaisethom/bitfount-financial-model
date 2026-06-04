// HubSpot source adapters — fetch deals from `/api/hubspot/sync` and produce
// engine-shaped tables. Two adapters live here:
//
//   1. `hubspotAdapter` (id: 'hubspot') — raw `deals` or `line_items` shape.
//      Useful for ad-hoc analysis where you want every property exposed.
//   2. `hubspotPipelineAdapter` (id: 'hubspot_pipeline') — long-format
//      `(line_item, month_idx, value)` rows ready to drop in as the
//      `hubspot_pipeline_t` source in the main sales model. Applies the same
//      stage probability + payment-schedule + duration logic as the v1
//      `syncHubSpot` path so numbers match the main app.
//
// Both call `/api/hubspot/sync` once per fetch and share the response parser.
//
// Registration (typically once at app startup, e.g. in main.tsx):
//
//   import { registerSourceAdapter } from './engine/sources';
//   import { hubspotAdapter, hubspotPipelineAdapter } from './engine/sources/hubspot';
//   registerSourceAdapter(hubspotAdapter);
//   registerSourceAdapter(hubspotPipelineAdapter);

import type { HubSpotSyncAssumptions } from '../../types';
import { transformDealsToHubSpotData } from '../../hubspot';
import type { Row, Table, TableSchema } from '../types';
import type { SourceAdapter } from './index';

interface HubSpotSyncResponse {
  ok: boolean;
  error?: string;
  fetchedAt: string;
  deals: Array<{
    id: string;
    properties: Record<string, string | null>;
    lineItems: Array<Record<string, string | null>>;
  }>;
  pipelines: Record<string, { id: string; label: string; stages: Record<string, string> }>;
  counts: { sales: number; changeOrders: number; lineItems: number };
}

async function fetchSync(): Promise<HubSpotSyncResponse> {
  const r = await fetch('/api/hubspot/sync');
  const data = (await r.json()) as HubSpotSyncResponse;
  if (!data.ok) throw new Error(data.error ?? `HubSpot sync failed (HTTP ${r.status})`);
  return data;
}

// ─── Adapter 1: raw deals / line_items ────────────────────────────────────

export interface HubSpotSourceConfig {
  entity: 'deals' | 'line_items';
}

export const hubspotAdapter: SourceAdapter<HubSpotSourceConfig> = {
  id: 'hubspot',
  async fetch(config: HubSpotSourceConfig, schema: TableSchema): Promise<Table> {
    const data = await fetchSync();

    if (config.entity === 'deals') {
      const rows: Row[] = data.deals.map((deal) => {
        const pipelineId = deal.properties.pipeline ?? '';
        const stageId = deal.properties.dealstage ?? '';
        const pipeline = data.pipelines[pipelineId];
        const stageLabel = pipeline?.stages[stageId] ?? null;
        const enriched: Record<string, string | number | null> = {
          ...deal.properties,
          id: deal.id,
          pipeline_label: pipeline?.label ?? null,
          stage_label: stageLabel,
        };
        return projectRow(enriched, schema);
      });
      return { schema, rows };
    }

    // line_items: flatten one row per line item, carrying its deal id
    const rows: Row[] = [];
    for (const deal of data.deals) {
      for (const li of deal.lineItems) {
        rows.push(projectRow({ ...li, deal_id: deal.id }, schema));
      }
    }
    return { schema, rows };
  },
};

// ─── Adapter 2: salesModel's hubspot_pipeline_t ───────────────────────────

export interface HubSpotPipelineConfig {
  /** YYYY-MM strings — the model's monthly calendar. Required so the
   *  transform knows where each deal lands. */
  modelDates: string[];
  /** Line item names already known to the model. Pre-seeds the wide table so
   *  emerging-but-unmapped lines still produce zero rows; omit for "discover
   *  all line items from the response". */
  existingLineItemNames?: string[];
  /** Stage probabilities, payment schedules, default duration, etc. — same
   *  shape the v1 `syncHubSpot` consumes. */
  assumptions: HubSpotSyncAssumptions;
}

export const hubspotPipelineAdapter: SourceAdapter<HubSpotPipelineConfig> = {
  id: 'hubspot_pipeline',
  async fetch(config: HubSpotPipelineConfig, schema: TableSchema): Promise<Table> {
    const data = await fetchSync();
    const { hubspot } = transformDealsToHubSpotData(
      // transformDealsToHubSpotData expects the v1-shaped response — we have
      // the same fields by construction; the cast is only because that
      // function's input type is internal.
      data as unknown as Parameters<typeof transformDealsToHubSpotData>[0],
      config.modelDates,
      config.existingLineItemNames ?? [],
      config.assumptions,
    );

    // Wide → long: one row per (line_item, month_idx). Skip strict zeros so
    // the table size stays comparable to the manual / flatten path.
    const rows: Row[] = [];
    for (const [lineName, arr] of Object.entries(hubspot.lineItems)) {
      arr.forEach((value, monthIdx) => {
        rows.push({ line_item: lineName, month_idx: monthIdx, value });
      });
    }
    return { schema, rows };
  },
};

function projectRow(raw: Record<string, string | number | null | undefined>, schema: TableSchema): Row {
  const out: Row = {};
  for (const c of schema.columns) {
    const v = raw[c.name];
    if (v == null) { out[c.name] = null; continue; }
    if (c.type === 'number') {
      const n = typeof v === 'number' ? v : parseFloat(v);
      out[c.name] = Number.isFinite(n) ? n : null;
    } else if (c.type === 'boolean') {
      out[c.name] = v === 'true' || v === '1' || v === 1;
    } else {
      out[c.name] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}
