// HubSpot source adapter — wraps the existing /api/hubspot/sync endpoint and
// normalizes deals + line items into Table rows according to the requested
// schema.
//
// Config shape:
//   { entity: 'deals' | 'line_items' }
//
// Schema is honored: only declared columns are emitted on each row. Columns
// the adapter doesn't recognize are written as null.

import type { Table, TableSchema, Row } from '../types';
import type { SourceAdapter } from './index';

interface HubSpotSyncResponse {
  ok: boolean;
  error?: string;
  deals: Array<{
    id: string;
    properties: Record<string, string | null>;
    lineItems: Array<Record<string, string | null>>;
  }>;
  pipelines: Record<string, { id: string; label: string; stages: Record<string, string> }>;
}

export interface HubSpotSourceConfig {
  entity: 'deals' | 'line_items';
}

export const hubspotAdapter: SourceAdapter<HubSpotSourceConfig> = {
  id: 'hubspot',
  async fetch(config: HubSpotSourceConfig, schema: TableSchema): Promise<Table> {
    const r = await fetch('/api/hubspot/sync');
    const data = (await r.json()) as HubSpotSyncResponse;
    if (!data.ok) throw new Error(data.error ?? `HubSpot sync failed (HTTP ${r.status})`);

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

// Caller is expected to register this once at app startup:
//   import { registerSourceAdapter } from './engine/sources';
//   import { hubspotAdapter } from './engine/sources/hubspot';
//   registerSourceAdapter(hubspotAdapter);
