// Manual classification of every known HubSpot line item.
//
// Each entry decides:
//   - `unit`   — what the quantity on the line item means (sites / patients /
//               flat / a per-month basis). Drives the "Sites" and "Patients"
//               columns in the Pricing view.
//   - `order`  — column ordering in the Pricing view (lower = leftmost).
//   - `short`  — compact header label used in the table. Falls back to the
//               full name on hover.
//
// When a new line item appears in HubSpot that isn't here, `getLineItemConfig`
// returns a sentinel "unknown" entry. The Pricing view surfaces these in a
// warning hint so they can be classified.

export type LineItemUnit = 'site' | 'patient' | 'flat' | 'unknown';

export interface LineItemConfig {
  unit: LineItemUnit;
  order: number;
  short: string;
}

export const LINE_ITEM_CONFIG: Record<string, LineItemConfig> = {
  // ── Project Configuration — flat intake fees, paid Start ─────────────
  'Project Configuration':                                     { unit: 'flat',    order: 10, short: 'Project Config' },
  'Project Configuration-Layer 1 Build':                       { unit: 'flat',    order: 11, short: 'PC · L1 Build' },
  'Project Configuration-Layer 2a Geographic Enrichment':      { unit: 'flat',    order: 12, short: 'PC · L2a Geo' },
  'Project Configuration-Layer 2b Data Enrichments':           { unit: 'flat',    order: 13, short: 'PC · L2b Data' },
  'Project Configuration-Layer 3 Activation':                  { unit: 'flat',    order: 14, short: 'PC · L3 Activation' },
  'Project Configuration-Proof of Concept':                    { unit: 'flat',    order: 15, short: 'PC · PoC' },

  // ── Site-level fees ───────────────────────────────────────────────────
  'Site Setup':                                                { unit: 'site',    order: 20, short: 'Site Setup' },
  'Patient Identification - Site Setup Fee':                   { unit: 'site',    order: 21, short: 'PI · Site Setup' },
  'Patient Identification - Site level fixed fee':             { unit: 'site',    order: 22, short: 'PI · Site fixed' },
  'Site Fee - Site level fixed fee':                           { unit: 'site',    order: 23, short: 'Site Fee · fixed' },
  'Bitfount License - Commercial Patient Finding Per Site':    { unit: 'site',    order: 24, short: 'BL · CPF / site' },

  // ── Patient-level fees ────────────────────────────────────────────────
  'Patient Identification - Site level per patient fee':       { unit: 'patient', order: 30, short: 'PI · per patient' },
  'Patient Identification - Site level per patient fee (Copy)':{ unit: 'patient', order: 31, short: 'PI · per patient (Copy)' },
  'Bitfount License - Commercial Patient Finding per Patient': { unit: 'patient', order: 32, short: 'BL · CPF / patient' },

  // ── Licenses (annual, treated as flat per-deal lines) ─────────────────
  'Bitfount License':                                          { unit: 'flat',    order: 40, short: 'BL · base' },
  'Bitfount License - Patient Pre-Screening':                  { unit: 'flat',    order: 41, short: 'BL · Pre-Screening' },
  'Bitfount License - InSite Insights':                        { unit: 'flat',    order: 42, short: 'BL · InSite' },
  'Bitfount License - Data Transfer':                          { unit: 'flat',    order: 43, short: 'BL · Data Transfer' },
  'Bitfount License - Model Development/Validation':           { unit: 'flat',    order: 44, short: 'BL · Model Dev/Val' },
  'Altris Model License':                                      { unit: 'flat',    order: 45, short: 'Altris Model' },

  // ── Ongoing ───────────────────────────────────────────────────────────
  'Project Management':                                        { unit: 'flat',    order: 50, short: 'PM' },
  'Project Support':                                           { unit: 'flat',    order: 51, short: 'Project Support' },

  // ── End-of-project ────────────────────────────────────────────────────
  'Screen Failure Reduction':                                  { unit: 'flat',    order: 60, short: 'Screen Fail Reduction' },
};

const UNKNOWN: LineItemConfig = { unit: 'unknown', order: 9999, short: '' };

export function getLineItemConfig(name: string): LineItemConfig {
  return LINE_ITEM_CONFIG[name] ?? { ...UNKNOWN, short: name };
}

export function isClassified(name: string): boolean {
  return name in LINE_ITEM_CONFIG;
}
