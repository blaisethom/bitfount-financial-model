import type {
  HubSpotData, HubSpotSyncAssumptions, HubSpotTAAllocation, CloseDateMode,
} from './types';

// Stages where the predicted close date is just the actual close (no shift),
// regardless of `closeDateMode`. These deals are already closed.
const STAGES_NO_DATE_SHIFT = new Set(['Closed Won', 'Closed Lost', 'CO Closed Won', 'CO Closed Lost']);

export type { CloseDateMode };

interface SyncResponse {
  ok: boolean;
  error?: string;
  fetchedAt: string;
  pipelines: Record<string, { id: string; label: string; stages: Record<string, string> }>;
  deals: Array<{
    id: string;
    properties: Record<string, string | null>;
    lineItems: Array<Record<string, string | null>>;
  }>;
  counts: { sales: number; changeOrders: number; lineItems: number };
}

export interface PerDealLineItem {
  name: string;
  unitPrice: number;
  quantity: number;
  /** unitPrice × quantity — the pre-discount list value. */
  listValue: number;
  /** Discount applied (listValue − value). Positive = discount given. Zero
   *  when no discount was entered on the HubSpot line item. */
  discount: number;
  /** Final billable value (post-discount). Sourced from HubSpot's `amount`
   *  field on the line item when present, else falls back to `listValue`. */
  value: number;
}

export interface PerDealSummary {
  id: string;
  name: string;
  pipelineLabel: string;
  stageLabel: string;
  /** Therapeutic area this deal is allocated to. Resolved via
   *  `HubSpotSyncAssumptions.taAllocation` — manual override > rule match
   *  > default. Used to bucket the deal's pipeline value into per-TA
   *  monthly arrays. */
  therapeuticArea: string;
  /** Sum of post-discount line-item values (Σ lineItems[i].value). */
  amountReported: number;
  /** Sum of pre-discount list values (Σ lineItems[i].listValue). Equal to
   *  `amountReported + discountTotal`. */
  listTotal: number;
  /** Total discount applied across line items (Σ lineItems[i].discount). */
  discountTotal: number;
  /** Raw deal-level `amount` property from HubSpot — the value shown on the
   *  HubSpot deal record itself. May differ from `amountReported` when the
   *  HubSpot amount is set manually or when line items are missing/stale. */
  hubspotAmount: number | null;
  /** Per-high-level-type sum of post-discount line-item values. Keys =
   *  highLevelType(li.name). */
  amountByType: Record<string, number>;
  /** Raw per-line-item rows on this deal — preserved so the Pricing view can
   *  pivot deals × line items. */
  lineItems: PerDealLineItem[];
  /** Deal create date as YYYY-MM-DD, or null. */
  createDate: string | null;
  /** Raw HubSpot closedate as YYYY-MM-DD, or null if absent. */
  closeDateHubSpot: string | null;
  /** closedate + remainingDays for the deal's stage (null if no close date). */
  closeDatePredicted: string | null;
  closeProbability: number;
  /** amountReported × closeProbability (the model-weighted booking). */
  expectedAmount: number;
  durationMonths: number;
  /** True if the deal is still in the pipeline (not Closed Won / Closed Lost). */
  isOpen: boolean;
  status: 'applied' | 'skipped';
  skipReason?: string;
}

/** Roll a HubSpot line item name up to a high-level type by trimming after " - " or "-". */
export function highLevelType(name: string): string {
  const a = name.indexOf(' - ');
  const b = name.indexOf('-');
  const cut = a !== -1 ? a : b;
  return cut === -1 ? name.trim() : name.slice(0, cut).trim();
}

/** Resolve a deal to a TA using the configured allocation rules.
 *  Order of precedence:
 *    1. `perDeal[dealId]` override (set by manual user assignment)
 *    2. First matching `rules[i].pattern` against the deal name (case-insensitive)
 *    3. `defaultTA`
 */
export function resolveDealTA(
  dealId: string,
  dealName: string | null,
  allocation: HubSpotTAAllocation,
): string {
  const override = allocation.perDeal[dealId];
  if (override) return override;
  if (dealName) {
    for (const rule of allocation.rules) {
      try {
        const re = new RegExp(rule.pattern, 'i');
        if (re.test(dealName)) return rule.ta;
      } catch {
        // Invalid regex — skip, fall through to next rule / default
      }
    }
  }
  return allocation.defaultTA;
}

export interface SyncResult {
  hubspot: HubSpotData;
  meta: {
    fetchedAt: string;
    counts: { sales: number; changeOrders: number; lineItems: number };
    dealsApplied: number;
    dealsSkipped: number;
    skipReasons: Record<string, number>;
    newLineItemNames: string[];
    unknownStages: string[];
    unknownLineItemNames: string[];
    deals: PerDealSummary[];
  };
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function addMonths(y: number, m1: number, n: number): { year: number; month: number } {
  const idx = y * 12 + (m1 - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

const ym = (y: number, m1: number) => `${y}-${String(m1).padStart(2, '0')}`;

export function transformDealsToHubSpotData(
  resp: SyncResponse,
  modelDates: string[],
  existingLineItemNames: string[],
  assumptions: HubSpotSyncAssumptions,
): SyncResult {
  const monthIndex: Record<string, number> = {};
  modelDates.forEach((d, i) => { monthIndex[d] = i; });
  const months = modelDates.length;

  const allNames = new Set<string>(existingLineItemNames);
  for (const deal of resp.deals) for (const li of deal.lineItems) if (li.name) allNames.add(li.name);
  const lineItems: Record<string, number[]> = {};
  for (const name of allNames) lineItems[name] = new Array(months).fill(0);

  // Per-(TA, line_item) monthly arrays. Same keys as `lineItems` but bucketed
  // by the deal's resolved therapeutic area. TAs are created lazily as deals
  // get allocated.
  const byTALineItems: Record<string, Record<string, number[]>> = {};
  const ensureTABucket = (ta: string, lineName: string): number[] => {
    let byLine = byTALineItems[ta];
    if (!byLine) {
      byLine = {};
      byTALineItems[ta] = byLine;
    }
    let arr = byLine[lineName];
    if (!arr) {
      arr = new Array(months).fill(0);
      byLine[lineName] = arr;
    }
    return arr;
  };

  const meta: SyncResult['meta'] = {
    fetchedAt: resp.fetchedAt,
    counts: resp.counts,
    dealsApplied: 0,
    dealsSkipped: 0,
    skipReasons: {},
    newLineItemNames: [...allNames].filter((n) => !existingLineItemNames.includes(n)).sort(),
    unknownStages: [],
    unknownLineItemNames: [],
    deals: [],
  };
  const unknownStagesSet = new Set<string>();
  const unknownLISet = new Set<string>();

  const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

  for (const deal of resp.deals) {
    const stageId = deal.properties.dealstage;
    const pipelineId = deal.properties.pipeline;
    const pipelineLabel = pipelineId ? resp.pipelines[pipelineId]?.label ?? '?' : '?';
    const stageLabel = stageId && pipelineId ? resp.pipelines[pipelineId]?.stages[stageId] ?? null : null;
    const closeDate = parseDate(deal.properties.closedate);
    const createDate = parseDate(deal.properties.createdate);
    const lineItemList = deal.lineItems.filter((li) => li.name);
    const amountByType: Record<string, number> = {};
    const dealLineItems: PerDealLineItem[] = [];
    let amountReported = 0;
    let listTotal = 0;
    let discountTotal = 0;
    for (const li of lineItemList) {
      const unitPrice = parseFloat(li.price ?? '0') || 0;
      const quantity = parseFloat(li.quantity ?? '0') || 0;
      const listValue = unitPrice * quantity;
      // HubSpot's `amount` on a line item is the calculated post-discount
      // total. Prefer it when set; otherwise fall back to list value (no
      // discount).
      const rawAmount = li.amount;
      const parsedAmount = rawAmount != null && rawAmount !== '' ? parseFloat(rawAmount) : NaN;
      const value = isNaN(parsedAmount) ? listValue : parsedAmount;
      const discount = listValue - value;
      amountReported += value;
      listTotal += listValue;
      discountTotal += discount;
      const t = highLevelType(li.name!);
      amountByType[t] = (amountByType[t] || 0) + value;
      dealLineItems.push({ name: li.name!, unitPrice, quantity, listValue, discount, value });
    }
    const isOpenDeal = !!stageLabel && !STAGES_NO_DATE_SHIFT.has(stageLabel);
    const durStr = deal.properties.project_duration__months_;
    const duration = durStr
      ? Math.max(1, Math.round(parseFloat(durStr)))
      : assumptions.defaultDurationMonths;

    const therapeuticArea = resolveDealTA(
      deal.id,
      deal.properties.dealname ?? null,
      assumptions.taAllocation,
    );

    const recordSummary = (
      status: 'applied' | 'skipped',
      closeProbability: number,
      predictedClose: Date | null,
      skipReason?: string,
    ) => {
      const rawAmount = deal.properties.amount;
      const hubspotAmount = rawAmount == null || rawAmount === '' ? null : parseFloat(rawAmount);
      meta.deals.push({
        id: deal.id,
        name: deal.properties.dealname ?? `(deal ${deal.id})`,
        pipelineLabel,
        stageLabel: stageLabel ?? '(unknown stage)',
        therapeuticArea,
        amountReported,
        listTotal,
        discountTotal,
        hubspotAmount: hubspotAmount != null && isNaN(hubspotAmount) ? null : hubspotAmount,
        amountByType,
        lineItems: dealLineItems,
        createDate: isoDate(createDate),
        closeDateHubSpot: isoDate(closeDate),
        closeDatePredicted: isoDate(predictedClose),
        closeProbability,
        expectedAmount: amountReported * closeProbability,
        durationMonths: duration,
        isOpen: isOpenDeal,
        status,
        skipReason,
      });
      if (status === 'applied') meta.dealsApplied += 1;
      else {
        meta.dealsSkipped += 1;
        const r = skipReason ?? 'unknown';
        meta.skipReasons[r] = (meta.skipReasons[r] || 0) + 1;
      }
    };

    if (!stageLabel) { recordSummary('skipped', 0, null, 'unknown stage'); continue; }

    const stageDef = assumptions.stages[stageLabel];
    if (!stageDef) {
      unknownStagesSet.add(stageLabel);
      recordSummary('skipped', 0, null, `unknown stage: ${stageLabel}`);
      continue;
    }
    if (stageDef.closeProbability === 0) {
      recordSummary('skipped', 0, closeDate, 'prob=0 (lost)');
      continue;
    }
    if (!closeDate) { recordSummary('skipped', stageDef.closeProbability, null, 'no close date'); continue; }

    const shiftDays =
      assumptions.closeDateMode === 'hubspot' || STAGES_NO_DATE_SHIFT.has(stageLabel)
        ? 0
        : stageDef.remainingDays;
    const predicted = new Date(closeDate.getTime() + shiftDays * 86400000);
    const py = predicted.getUTCFullYear();
    const pm = predicted.getUTCMonth() + 1;

    if (lineItemList.length === 0) {
      recordSummary('skipped', stageDef.closeProbability, predicted, 'no line items');
      continue;
    }

    let applied = false;
    // Iterate over the parsed PerDealLineItem rows so the per-month schedule
    // allocation uses the post-discount value, matching `amountReported`.
    for (const dli of dealLineItems) {
      const name = dli.name;
      const schedule = assumptions.paymentSchedules[name];
      if (!schedule) {
        unknownLISet.add(name);
        continue;
      }
      const totalValue = dli.value * stageDef.closeProbability;
      if (totalValue === 0) continue;

      const arr = lineItems[name];
      const taArr = ensureTABucket(therapeuticArea, name);
      const put = (year: number, month: number, v: number) => {
        const idx = monthIndex[ym(year, month)];
        if (idx !== undefined) {
          arr[idx] += v;
          taArr[idx] += v;
          applied = true;
        }
      };

      if (schedule === 'Annual') {
        const points = Math.ceil(duration / 12);
        const valuePerPayment = totalValue / points;
        for (let p = 0; p < points; p++) {
          const { year, month } = addMonths(py, pm, p * 12);
          put(year, month, valuePerPayment);
        }
      } else if (schedule === 'Uniform') {
        const valuePerMonth = totalValue / duration;
        for (let m = 1; m <= duration; m++) {
          const { year, month } = addMonths(py, pm, m);
          put(year, month, valuePerMonth);
        }
      } else if (schedule === 'Start') {
        put(py, pm, totalValue);
      } else if (schedule === 'End') {
        const { year, month } = addMonths(py, pm, duration);
        put(year, month, totalValue);
      }
    }
    if (applied) recordSummary('applied', stageDef.closeProbability, predicted);
    else recordSummary('skipped', stageDef.closeProbability, predicted, 'all months out of model range');
  }

  meta.unknownStages = [...unknownStagesSet].sort();
  meta.unknownLineItemNames = [...unknownLISet].sort();

  const grandTotal = new Array(months).fill(0);
  for (const name of Object.keys(lineItems)) {
    for (let i = 0; i < months; i++) grandTotal[i] += lineItems[name][i];
  }

  return { hubspot: { lineItems, byTALineItems, grandTotal }, meta };
}

// ─── Aggregation helpers used by UI and Excel export ───

export function annualSummaryByType(
  hubspot: HubSpotData,
  dates: string[],
): { types: string[]; years: number[]; data: Record<string, Record<number, number>> } {
  const typeSet = new Set<string>();
  const yearSet = new Set<number>();
  const data: Record<string, Record<number, number>> = {};
  for (const name of Object.keys(hubspot.lineItems)) {
    const t = highLevelType(name);
    typeSet.add(t);
    if (!data[t]) data[t] = {};
    hubspot.lineItems[name].forEach((v, i) => {
      const y = parseInt(dates[i].slice(0, 4), 10);
      yearSet.add(y);
      data[t][y] = (data[t][y] || 0) + v;
    });
  }
  return {
    types: [...typeSet].sort(),
    years: [...yearSet].sort((a, b) => a - b),
    data,
  };
}

function quarterKey(isoDate: string): string {
  const y = parseInt(isoDate.slice(0, 4), 10);
  const m = parseInt(isoDate.slice(5, 7), 10);
  const q = Math.floor((m - 1) / 3) + 1;
  return `${y} Q${q}`;
}

function compareQuarter(a: string, b: string): number {
  // "YYYY Q#" — lexical works because YYYY is 4 digits and Q#-ordering aligns with quarter ordering for 1-4.
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface QuarterlyPivot {
  quarters: string[];
  types: string[];
  data: Record<string, Record<string, number>>; // data[quarter][type]
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grandTotal: number;
}

export function quarterlyPivot(
  deals: PerDealSummary[],
  opts: { weighted: boolean; openOnly: boolean },
): QuarterlyPivot {
  const data: Record<string, Record<string, number>> = {};
  const typeSet = new Set<string>();
  const quarterSet = new Set<string>();
  for (const d of deals) {
    if (opts.openOnly && !d.isOpen) continue;
    if (!opts.openOnly && d.closeProbability === 0) continue;
    if (!d.closeDatePredicted) continue;
    const q = quarterKey(d.closeDatePredicted);
    quarterSet.add(q);
    if (!data[q]) data[q] = {};
    const factor = opts.weighted ? d.closeProbability : 1;
    for (const [t, v] of Object.entries(d.amountByType)) {
      typeSet.add(t);
      data[q][t] = (data[q][t] || 0) + v * factor;
    }
  }
  const types = [...typeSet].sort();
  const quarters = [...quarterSet].sort(compareQuarter);
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  let grandTotal = 0;
  for (const q of quarters) {
    let rt = 0;
    for (const t of types) {
      const v = data[q]?.[t] || 0;
      rt += v;
      colTotals[t] = (colTotals[t] || 0) + v;
      grandTotal += v;
    }
    rowTotals[q] = rt;
  }
  return { quarters, types, data, rowTotals, colTotals, grandTotal };
}

export interface ContractValueHistoryRow {
  monthStart: string; // YYYY-MM-01
  liveCount: number;
  totalCV: number;
}

export function contractValueHistory(deals: PerDealSummary[]): ContractValueHistoryRow[] {
  // A deal is "live" at the start of month M if createDate <= M-01 AND closeDateHubSpot > M-01.
  // (For deals not yet closed in HubSpot, closedate is the expected close — we treat them as live until expected.)
  const earliest = deals.reduce<string | null>(
    (acc, d) => (d.createDate && (!acc || d.createDate < acc) ? d.createDate : acc),
    null,
  );
  if (!earliest) return [];
  const today = new Date().toISOString().slice(0, 10);
  // Iterate month-starts from earliest createDate to current month
  const [sy, sm] = earliest.slice(0, 7).split('-').map((s) => parseInt(s, 10));
  const [ey, em] = today.slice(0, 7).split('-').map((s) => parseInt(s, 10));
  const rows: ContractValueHistoryRow[] = [];
  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
    let count = 0;
    let total = 0;
    for (const d of deals) {
      if (!d.createDate || d.createDate > monthStart) continue;
      if (!d.closeDateHubSpot) continue;
      if (d.closeDateHubSpot <= monthStart) continue;
      count += 1;
      total += d.amountReported;
    }
    rows.push({ monthStart, liveCount: count, totalCV: total });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return rows;
}

export async function syncHubSpot(
  modelDates: string[],
  existingLineItemNames: string[],
  assumptions: HubSpotSyncAssumptions,
): Promise<SyncResult> {
  const res = await fetch('/api/hubspot/sync');
  const data: SyncResponse = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return transformDealsToHubSpotData(data, modelDates, existingLineItemNames, assumptions);
}
