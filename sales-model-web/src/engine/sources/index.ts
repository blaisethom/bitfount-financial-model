// Source adapter registry. Adapters fetch + normalize external data into the
// engine's `Table` shape so they can be consumed identically to literal sources.

import type { ModelDef, Table, TableSchema } from '../types';

export interface SourceAdapter<TConfig = unknown> {
  /** Identifier matching `SourceDef.adapter` for kind `'api'`. */
  id: string;
  /** Fetch and normalize external data into a Table conforming to `schema`. */
  fetch(config: TConfig, schema: TableSchema): Promise<Table>;
}

const adapters = new Map<string, SourceAdapter>();

export function registerSourceAdapter(adapter: SourceAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getSourceAdapter(id: string): SourceAdapter | undefined {
  return adapters.get(id);
}

/**
 * Walk a model's sources and fetch every `api` source via its registered
 * adapter. Returns a `{ name → Table }` map suitable for `evaluateModel`'s
 * `prefetchedSources` option.
 */
export async function materializeApiSources(model: ModelDef): Promise<Record<string, Table>> {
  const out: Record<string, Table> = {};
  for (const [name, src] of Object.entries(model.sources)) {
    if (src.kind !== 'api') continue;
    const adapter = adapters.get(src.adapter);
    if (!adapter) throw new Error(`No adapter registered for "${src.adapter}" (source "${name}")`);
    out[name] = await adapter.fetch(src.config, src.schema);
  }
  return out;
}
