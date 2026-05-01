import type { ModelInput, TAMonthly, TrialType } from './types';
import { platformPricePerYear } from './model';

const TYPES: TrialType[] = ['A', 'B', 'C'];
const TYPE_LABEL: Record<TrialType, string> = { A: 'Type A', B: 'Type B', C: 'Type C' };

const money = (v: number) => '$' + Math.round(v).toLocaleString();
const moneyExact = (v: number) =>
  '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const EMPLOYEE_DEPT_ROW_TOOLTIP =
  [
    'Department employee cost (monthly):',
    'Sum of every active employee in this department for the month.',
    '',
    'formula:\ndept(m) = Σ_e in dept loaded(e) / 12 × inflation(m)\n          for employees with start_date ≤ m',
    '',
    'loaded(e) = salary(e) × (1 + NI + pension)',
    'inflation(m): compounded annually each April starting Apr 2027',
  ].join('\n');

export const EMPLOYEE_TOTAL_ROW_TOOLTIP =
  [
    'Total employee cost (monthly):',
    'Sum across every active employee in every department.',
    '',
    'formula:\ntotal(m) = Σ_dept dept(m)',
  ].join('\n');

export const HUBSPOT_ROW_TOOLTIP =
  'HubSpot pipeline (existing weighted opportunities):\n' +
  'Static data imported from the HubSpot Pivot tab of the source spreadsheet — represents revenue from deals already in the sales pipeline, not modeled trial revenue. Only spans Jan 2026 – Dec 2030 (the HubSpot tab does not cover 2031).';

export const TA_TOTAL_ROW_TOOLTIP =
  'Therapeutic-area total revenue:\n' +
  'Sum of platform + project + PM-fee revenue for this TA, derived from the client-start schedule and pricing assumptions.';

export const GRAND_TOTAL_ROW_TOOLTIP =
  [
    'Grand total revenue (HubSpot + modeled TAs):',
    'Sum of HubSpot pipeline plus all modeled-TA revenue for this month.',
    '',
    'formula:\ngrand(m) = hubspot(m) + Σ_TA total_TA(m)',
  ].join('\n');

export const ROW_TOOLTIPS = {
  activeType: (t: TrialType) =>
    [
      'Active trials in a month:',
      `${TYPE_LABEL[t]} active(m) = number of ${TYPE_LABEL[t]} trials currently within their 12-month run`,
      '',
      `formula:\nactive(m) = Σ starts(i) for i ∈ [m − 11, m]`,
      '',
      'Each trial counts as active for the calendar month it started in plus the next 11 months.',
    ].join('\n'),
  activeTotal:
    [
      'Total active trials this month:',
      'Sum of active trials across all three trial types.',
      '',
      'formula:\ntotal_active(m) = A_active(m) + B_active(m) + C_active(m)',
    ].join('\n'),
  platform:
    [
      'Platform license revenue (earned, monthly):',
      'For each active trial we recognise 1/12 of its annual platform license that month.',
      '',
      'formula:\nplatform(m) = Σ_t active_t(m) × (platform_yr_t / 12)\nplatform_yr_t = (bitfount_license + ai_license) × sites_t',
    ].join('\n'),
  project:
    [
      'Project configuration fee (earned, monthly):',
      'A one-time fee charged in the month a trial starts.',
      '',
      'formula:\nproject(m) = Σ_t starts_t(m) × project_fee_t',
    ].join('\n'),
  pm:
    [
      'Project management fee (earned, monthly):',
      'A flat monthly fee for every active trial.',
      '',
      'formula:\npm(m) = Σ_t active_t(m) × pm_fee_t',
    ].join('\n'),
  totalRev:
    [
      'Total monthly revenue:',
      'Sum of all three earned revenue streams for this therapeutic area.',
      '',
      'formula:\ntotal(m) = platform(m) + project(m) + pm(m)',
    ].join('\n'),
} as const;

export function activeTypeCellTooltip(
  t: TrialType,
  monthIdx: number,
  dates: string[],
  starts: number[],
  active: number,
): string {
  const dateLabel = dates[monthIdx];
  const startMonth = Math.max(0, monthIdx - 11);
  const contribs: string[] = [];
  for (let i = startMonth; i <= monthIdx; i++) {
    if (starts[i] > 0) contribs.push(`${starts[i]} from ${dates[i]}`);
  }
  const lines = [
    `${TYPE_LABEL[t]} active in ${dateLabel}:`,
    `active(${dateLabel}) = ${active}`,
    '',
    'this cell:',
  ];
  if (contribs.length === 0) {
    lines.push(`Σ starts in [${dates[startMonth]} … ${dateLabel}] = 0  (no trials started in that window)`);
  } else {
    lines.push(`Σ starts in [${dates[startMonth]} … ${dateLabel}]`);
    lines.push(`  = ${contribs.join(' + ')}`);
    lines.push(`  = ${active}`);
  }
  return lines.join('\n');
}

export function activeTotalCellTooltip(monthIdx: number, dates: string[], ta: TAMonthly): string {
  const a = ta.byType.A.active[monthIdx];
  const b = ta.byType.B.active[monthIdx];
  const c = ta.byType.C.active[monthIdx];
  return [
    `Total active in ${dates[monthIdx]}:`,
    `total = ${a + b + c}`,
    '',
    'this cell:',
    `total = A_active + B_active + C_active`,
    `      = ${a} + ${b} + ${c} = ${a + b + c}`,
  ].join('\n');
}

export function platformCellTooltip(monthIdx: number, dates: string[], ta: TAMonthly, input: ModelInput): string {
  const lines = [`Platform revenue in ${dates[monthIdx]}:`, `platform = ${money(ta.platform[monthIdx])}`, '', 'this cell:'];
  const parts: string[] = [];
  for (const t of TYPES) {
    const a = ta.byType[t].active[monthIdx];
    if (a === 0) continue;
    const yr = platformPricePerYear(input.pricing, t);
    parts.push(`  ${a} × ${money(yr)} / 12  = ${moneyExact((a * yr) / 12)}   (${TYPE_LABEL[t]})`);
  }
  if (parts.length === 0) {
    lines.push('  no active trials');
  } else {
    lines.push(...parts);
    lines.push(`  ─────`);
    lines.push(`  total = ${money(ta.platform[monthIdx])}`);
  }
  return lines.join('\n');
}

export function projectCellTooltip(
  monthIdx: number,
  dates: string[],
  ta: TAMonthly,
  input: ModelInput,
  taName: string,
): string {
  const lines = [`Project fee in ${dates[monthIdx]}:`, `project = ${money(ta.project[monthIdx])}`, '', 'this cell:'];
  const parts: string[] = [];
  for (const t of TYPES) {
    const s = input.schedule[taName][t][monthIdx];
    if (s === 0) continue;
    parts.push(`  ${s} × ${money(input.pricing[t].projectFee)}  = ${money(s * input.pricing[t].projectFee)}   (${TYPE_LABEL[t]})`);
  }
  if (parts.length === 0) {
    lines.push('  no trials started this month');
  } else {
    lines.push(...parts);
    lines.push(`  ─────`);
    lines.push(`  total = ${money(ta.project[monthIdx])}`);
  }
  return lines.join('\n');
}

export function pmCellTooltip(monthIdx: number, dates: string[], ta: TAMonthly, input: ModelInput): string {
  const lines = [`PM fee in ${dates[monthIdx]}:`, `pm = ${money(ta.pm[monthIdx])}`, '', 'this cell:'];
  const parts: string[] = [];
  for (const t of TYPES) {
    const a = ta.byType[t].active[monthIdx];
    if (a === 0) continue;
    parts.push(`  ${a} × ${money(input.pricing[t].pmFee)}  = ${money(a * input.pricing[t].pmFee)}   (${TYPE_LABEL[t]})`);
  }
  if (parts.length === 0) {
    lines.push('  no active trials');
  } else {
    lines.push(...parts);
    lines.push(`  ─────`);
    lines.push(`  total = ${money(ta.pm[monthIdx])}`);
  }
  return lines.join('\n');
}

export function hubspotLineCellTooltip(name: string, monthIdx: number, dates: string[], value: number): string {
  if (value === 0) {
    return [
      `${name} — ${dates[monthIdx]}:`,
      'No revenue recorded for this line item this month in the HubSpot pipeline.',
    ].join('\n');
  }
  return [
    `${name} — ${dates[monthIdx]}:`,
    `${money(value)} of weighted pipeline revenue (existing HubSpot opportunity).`,
    '',
    'Source: HubSpot Pivot tab of the source spreadsheet.',
  ].join('\n');
}

export function hubspotSubtotalCellTooltip(monthIdx: number, dates: string[], lineItems: Record<string, number[]>): string {
  const contribs: string[] = [];
  let sum = 0;
  for (const [name, vals] of Object.entries(lineItems)) {
    if (vals[monthIdx] === 0) continue;
    contribs.push(`  ${money(vals[monthIdx])}  (${name})`);
    sum += vals[monthIdx];
  }
  return [
    `HubSpot pipeline total — ${dates[monthIdx]}:`,
    `total = ${money(sum)}`,
    '',
    'this cell:',
    contribs.length ? contribs.join('\n') : '  no pipeline revenue this month',
  ].join('\n');
}

export function taTotalCellTooltip(taName: string, monthIdx: number, dates: string[], ta: TAMonthly): string {
  return [
    `${taName} — ${dates[monthIdx]}:`,
    `total = ${money(ta.total[monthIdx])}`,
    '',
    'this cell:',
    `total = platform + project + pm`,
    `      = ${money(ta.platform[monthIdx])} + ${money(ta.project[monthIdx])} + ${money(ta.pm[monthIdx])}`,
    `      = ${money(ta.total[monthIdx])}`,
  ].join('\n');
}

export function modeledSubtotalCellTooltip(
  monthIdx: number,
  dates: string[],
  perTA: Record<string, TAMonthly>,
  taNames: string[],
): string {
  const contribs: string[] = [];
  let sum = 0;
  for (const name of taNames) {
    const v = perTA[name].total[monthIdx];
    if (v === 0) continue;
    contribs.push(`  ${money(v)}  (${name})`);
    sum += v;
  }
  return [
    `Modeled-TAs total — ${dates[monthIdx]}:`,
    `total = ${money(sum)}`,
    '',
    'this cell:',
    contribs.length ? contribs.join('\n') : '  no modeled revenue this month',
  ].join('\n');
}

export function grandTotalCellTooltip(monthIdx: number, dates: string[], hsValue: number, modeledValue: number): string {
  return [
    `Grand total — ${dates[monthIdx]}:`,
    `grand = ${money(hsValue + modeledValue)}`,
    '',
    'this cell:',
    `grand = hubspot + modeled`,
    `      = ${money(hsValue)} + ${money(modeledValue)}`,
    `      = ${money(hsValue + modeledValue)}`,
  ].join('\n');
}

export function employeeDeptCellTooltip(
  dept: string,
  monthIdx: number,
  dates: string[],
  perEmployee: Record<string, number[]>,
  employees: { id: string; firstName: string; surname: string; position: string; department: string }[],
): string {
  const date = dates[monthIdx];
  const lines = [`${dept} — ${date}:`];
  let sum = 0;
  const contribs: string[] = [];
  for (const e of employees) {
    if (e.department !== dept) continue;
    const v = perEmployee[e.id]?.[monthIdx] || 0;
    if (v === 0) continue;
    const name = [e.firstName, e.surname].filter(Boolean).join(' ') || e.position || e.id;
    contribs.push(`  ${money(v)}  (${name})`);
    sum += v;
  }
  lines.push(`dept = ${money(sum)}`, '', 'this cell:');
  if (contribs.length === 0) {
    lines.push('  no active employees');
  } else if (contribs.length <= 12) {
    lines.push(...contribs);
    lines.push('  ─────', `  total = ${money(sum)}`);
  } else {
    // Too many: show first 10 and ellipsis
    lines.push(...contribs.slice(0, 10));
    lines.push(`  … +${contribs.length - 10} more active employees`);
    lines.push('  ─────', `  total = ${money(sum)}`);
  }
  return lines.join('\n');
}

export function employeeTotalCellTooltip(
  monthIdx: number,
  dates: string[],
  perDepartment: Record<string, number[]>,
): string {
  const lines = [`Total employee cost — ${dates[monthIdx]}:`];
  let sum = 0;
  const parts: string[] = [];
  for (const [d, arr] of Object.entries(perDepartment)) {
    const v = arr[monthIdx] || 0;
    if (v === 0) continue;
    parts.push(`  ${money(v)}  (${d})`);
    sum += v;
  }
  lines.push(`total = ${money(sum)}`, '', 'this cell:');
  if (parts.length === 0) lines.push('  no employee cost this month');
  else {
    lines.push(...parts);
    lines.push('  ─────', `  total = ${money(sum)}`);
  }
  return lines.join('\n');
}

export function totalRevCellTooltip(monthIdx: number, dates: string[], ta: TAMonthly): string {
  const p = ta.platform[monthIdx];
  const j = ta.project[monthIdx];
  const m = ta.pm[monthIdx];
  return [
    `Total revenue in ${dates[monthIdx]}:`,
    `total = ${money(ta.total[monthIdx])}`,
    '',
    'this cell:',
    `total = platform + project + pm`,
    `      = ${money(p)} + ${money(j)} + ${money(m)}`,
    `      = ${money(p + j + m)}`,
  ].join('\n');
}

