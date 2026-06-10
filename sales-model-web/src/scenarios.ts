// Scenario management: a scenario is a named set of *overrides* layered on top
// of the base model assumptions (`loadInitialInput()`). Overrides are stored
// per top-level ModelInput field — every edit in the report replaces a whole
// top-level field (see applyEdit.ts), so a field-level diff against the base
// captures exactly "what this scenario changes". Switching scenarios is just
// `{ ...base, ...overrides }`, so overrides float on top of the *current* base.

import type { ModelInput } from './types';

export interface Scenario {
  id: string;
  name: string;
  /** Top-level ModelInput fields that differ from the base. */
  overrides: Partial<ModelInput>;
}

export interface ScenarioStore {
  scenarios: Scenario[];
  activeId: string;
}

const STORAGE_KEY = 'bitfount-model.scenarios.v1';

/** Human-friendly labels for the assumption fields a scenario can override. */
export const FIELD_LABELS: Partial<Record<keyof ModelInput, string>> = {
  pricing: 'Pricing',
  schedule: 'Trial schedule (starts per TA)',
  hubspot: 'HubSpot pipeline data',
  hubspotSync: 'HubSpot sync assumptions',
  employees: 'Employees',
  employeeAssumptions: 'Employee assumptions',
  costs: 'Cost line items',
  commission: 'Commission assumptions',
  openingBs: 'Opening balance sheet',
  bsAssumptions: 'Balance-sheet assumptions',
  bsMonthlySchedule: 'BS monthly schedule (capex / WC / loans)',
  actuals: 'Actuals overrides',
  employeeCostAdjustments: 'Employee cost adjustments',
  revenueAdjustments: 'Revenue adjustments',
  modellerCommissionAdjustments: 'Modeller commission adjustments',
  salesCommissionOverrides: 'Sales commission overrides',
  rdTaxCredit: 'R&D tax credit',
  interestIncome: 'Interest income',
};

// Fields that are not really "assumptions" the user tweaks — excluded from the
// override diff so identical structural data never shows up as a difference.
const IGNORED_FIELDS: (keyof ModelInput)[] = ['taNames', 'dates'];

const ALL_FIELDS = Object.keys(FIELD_LABELS) as (keyof ModelInput)[];

function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Diff `input` against `base`, returning only the top-level fields that differ. */
export function computeOverrides(base: ModelInput, input: ModelInput): Partial<ModelInput> {
  const out: Partial<ModelInput> = {};
  for (const key of ALL_FIELDS) {
    if (IGNORED_FIELDS.includes(key)) continue;
    if (!stableEqual(base[key], input[key])) {
      // structuredClone keeps the stored override independent of the live input.
      (out as Record<string, unknown>)[key] = structuredClone(input[key]);
    }
  }
  return out;
}

/** Materialize a scenario's full ModelInput by layering its overrides on base. */
export function applyOverrides(base: ModelInput, overrides: Partial<ModelInput>): ModelInput {
  return { ...base, ...structuredClone(overrides) };
}

/** The list of fields a scenario overrides, with friendly labels, for display. */
export function overrideSummary(scenario: Scenario): { key: keyof ModelInput; label: string }[] {
  return (Object.keys(scenario.overrides) as (keyof ModelInput)[]).map((key) => ({
    key,
    label: FIELD_LABELS[key] ?? key,
  }));
}

export function overrideCount(scenario: Scenario): number {
  return Object.keys(scenario.overrides).length;
}

let idCounter = 0;
export function newId(): string {
  // Avoid Date.now()/Math.random() reliance in tests; monotonic per session is
  // fine since ids only need to be unique within the stored set.
  idCounter += 1;
  return `s${idCounter}-${idCounter * 2654435761 % 1_000_000}`;
}

export const BASE_SCENARIO_NAME = 'Base case';

export function defaultStore(): ScenarioStore {
  const base: Scenario = { id: 'base', name: BASE_SCENARIO_NAME, overrides: {} };
  return { scenarios: [base], activeId: base.id };
}

export function loadStore(): ScenarioStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as ScenarioStore;
    if (!parsed.scenarios?.length || !parsed.activeId) return defaultStore();
    // Defend against a stored activeId that no longer exists.
    if (!parsed.scenarios.some((s) => s.id === parsed.activeId)) {
      parsed.activeId = parsed.scenarios[0].id;
    }
    return parsed;
  } catch {
    return defaultStore();
  }
}

export function saveStore(store: ScenarioStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage may be unavailable (private mode / quota) — fail silently;
    // scenarios still work for the session, just won't persist.
  }
}
