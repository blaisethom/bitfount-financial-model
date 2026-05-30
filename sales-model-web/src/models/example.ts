// Example model: probability-weighted HubSpot pipeline rollup.
//
// Proves the engine handles the four most-used capabilities end-to-end:
//   1. literal sources with typed schemas
//   2. cell-level `map` with arithmetic expressions
//   3. groupBy + sum aggregation
//   4. multiple named outputs surfaced for renderers
//
// Real models will swap the literal `deals` source for an `apiSource({ adapter:
// 'hubspot', config: { entity: 'deals' }, ... })` once the v1 UI consumes the
// engine in production. The shape of the model stays identical.

import {
  defineModel, literal, step, ops, agg,
  col, mul,
} from '../engine';

export const exampleModel = defineModel({
  sources: {
    deals: literal({
      description: 'Sample HubSpot-shaped deals — replace with apiSource adapter in production.',
      schema: {
        columns: [
          { name: 'id', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'type', type: 'string', description: 'High-level revenue type' },
          { name: 'closeQuarter', type: 'string' },
          { name: 'amount', type: 'number' },
          { name: 'closeProbability', type: 'number' },
        ],
      },
      rows: [
        { id: 'd1', name: 'Alcon Ph3 AMD', type: 'Bitfount License',       closeQuarter: '2026 Q3', amount: 240000, closeProbability: 0.22 },
        { id: 'd2', name: 'Astellas Ph1b GA', type: 'Project Configuration', closeQuarter: '2026 Q2', amount: 50000,  closeProbability: 0.44 },
        { id: 'd3', name: 'Astellas Ph3 GA #1', type: 'Bitfount License',  closeQuarter: '2026 Q4', amount: 280000, closeProbability: 0.22 },
        { id: 'd4', name: 'Character Bio Obs', type: 'Bitfount License',   closeQuarter: '2026 Q1', amount: 605000, closeProbability: 1.0  },
        { id: 'd5', name: 'PPD Annexon P3 GA', type: 'Project Management', closeQuarter: '2026 Q1', amount: 18000,  closeProbability: 1.0  },
        { id: 'd6', name: 'Adverum Ph2 GA',    type: 'Project Configuration', closeQuarter: '2026 Q3', amount: 25000,  closeProbability: 0.37 },
      ],
    }),
  },
  steps: [
    step({
      id: 'weight_deals',
      name: 'Apply close probability',
      description:
        'For each deal, multiply the gross amount by its close probability ' +
        'to get the expected (forecast) booking value.',
      input: 'deals',
      op: ops.map({
        expected: mul(col('amount'), col('closeProbability')),
      }),
      output: 'weighted_deals',
    }),
    step({
      id: 'roll_by_type',
      name: 'Roll up by revenue type',
      description:
        'Group weighted deals by high-level revenue type and sum the expected ' +
        'amounts. Counts deals contributing to each type for context.',
      input: 'weighted_deals',
      op: ops.groupBy(['type'], {
        expected_total: agg.sum('expected'),
        deal_count: agg.count(null),
      }),
      output: 'by_type',
    }),
    step({
      id: 'roll_by_quarter',
      name: 'Roll up by close quarter',
      description:
        'Group weighted deals by predicted close quarter — the canonical ' +
        'time-bucketing for the forecast booking forecast.',
      input: 'weighted_deals',
      op: ops.groupBy(['closeQuarter'], {
        expected_total: agg.sum('expected'),
      }),
      output: 'by_quarter',
    }),
  ],
  outputs: [
    {
      ref: 'weighted_deals',
      label: 'Deals with expected amount',
      description: 'Raw deals augmented with `expected = amount × closeProbability`.',
    },
    {
      ref: 'by_type',
      label: 'Expected revenue by type',
      description: 'Forecast booking total per high-level revenue type.',
    },
    {
      ref: 'by_quarter',
      label: 'Expected revenue by quarter',
      description: 'Forecast booking total per predicted close quarter.',
    },
  ],
});
