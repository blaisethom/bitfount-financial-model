// Run the v2 sales model against a v1 ModelInput. Flattens the input into
// engine source tables and evaluates the full DAG.

import type { ModelInput } from '../types';
import type { EvalResult } from '../engine';
import { evaluateModel, getSourceAdapter } from '../engine';
import type { HubSpotPipelineConfig } from '../engine/sources/hubspot';
import { flattenModelInput } from './flatten';
import { salesModel } from './salesModel';

export function evaluateSalesModel(input: ModelInput): EvalResult {
  const { tables } = flattenModelInput(input);
  return evaluateModel(salesModel, { prefetchedSources: tables });
}

/**
 * Same as {@link evaluateSalesModel}, but replaces the manual
 * `hubspot_pipeline_t` table with one fetched live via the `hubspot_pipeline`
 * adapter (registered in `main.tsx`). Used by the engine view's
 * "sync HubSpot via adapter" path.
 */
export async function evaluateSalesModelWithLiveHubSpot(input: ModelInput): Promise<EvalResult> {
  const { tables } = flattenModelInput(input);
  const adapter = getSourceAdapter('hubspot_pipeline');
  if (!adapter) throw new Error('hubspot_pipeline adapter not registered');

  const config: HubSpotPipelineConfig = {
    modelDates: input.dates,
    existingLineItemNames: Object.keys(input.hubspot.lineItems),
    assumptions: input.hubspotSync,
  };
  const hubspotPipeline = await adapter.fetch(config, salesModel.sources.hubspot_pipeline_t.schema);

  return evaluateModel(salesModel, {
    prefetchedSources: { ...tables, hubspot_pipeline_t: hubspotPipeline },
  });
}
