import raw from './sales_data.json';
import hsRaw from './hubspot_data.json';
import empRaw from './employees_data.json';
import costsRaw from './costs_data.json';
import type {
  ModelInput,
  Schedule,
  Pricing,
  HubSpotData,
  HubSpotSyncAssumptions,
  Employee,
  EmployeeAssumptions,
  CostsData,
  CostDept,
  CommissionAssumptions,
  OpeningBalanceSheet,
  BalanceSheetAssumptions,
  Actuals,
  EmployeeCostAdjustment,
  RevenueAdjustment,
  ModellerCommissionAdjustment,
  SalesCommissionOverride,
  BalanceSheetMonthlySchedule,
} from './types';

export function defaultHubSpotSyncAssumptions(): HubSpotSyncAssumptions {
  return {
    stages: {
      Discovery: { closeProbability: 0.203, remainingDays: 104.5 },
      Qualification: { closeProbability: 0.222, remainingDays: 104.5 },
      Interact: { closeProbability: 0.368, remainingDays: 104.5 },
      Proposal: { closeProbability: 0.438, remainingDays: 29 },
      'Commit/Negotiate': { closeProbability: 0.737, remainingDays: 30 },
      'Out for Signature': { closeProbability: 0.933, remainingDays: 30 },
      'Closed Won': { closeProbability: 1.0, remainingDays: 0 },
      'Closed Lost': { closeProbability: 0, remainingDays: 0 },
      'CO Requested': { closeProbability: 1.0, remainingDays: 0 },
      'CO Proposal': { closeProbability: 1.0, remainingDays: 0 },
      'CO In Signature Process': { closeProbability: 1.0, remainingDays: 0 },
      'CO Closed Won': { closeProbability: 1.0, remainingDays: 0 },
      'CO Closed Lost': { closeProbability: 0, remainingDays: 0 },
    },
    paymentSchedules: {
      'Altris Model License': 'Annual',
      'Bitfount License': 'Annual',
      'Bitfount License - Patient Pre-Screening': 'Annual',
      'Bitfount License - InSite Insights': 'Annual',
      'Bitfount License - Data Transfer': 'Annual',
      'Bitfount License - Model Development/Validation': 'Annual',
      'Bitfount License - Commercial Patient Finding Per Site': 'Annual',
      'Bitfount License - Commercial Patient Finding per Patient': 'Annual',
      'Patient Identification - Site level fixed fee': 'Start',
      'Patient Identification - Site level per patient fee': 'End',
      'Patient Identification - Site level per patient fee (Copy)': 'End',
      'Patient Identification - Site Setup Fee': 'Start',
      'Project Configuration': 'Start',
      'Project Configuration-Layer 1 Build': 'Start',
      'Project Configuration-Layer 2a Geographic Enrichment': 'Start',
      'Project Configuration-Layer 2b Data Enrichments': 'Start',
      'Project Configuration-Layer 3 Activation': 'Start',
      'Project Configuration-Proof of Concept': 'Start',
      'Project Management': 'Uniform',
      'Project Support': 'Uniform',
      'Screen Failure Reduction': 'End',
      'Site Setup': 'Start',
      'Site Fee - Site level fixed fee': 'Start',
    },
    defaultDurationMonths: 12,
    closeDateMode: 'predicted',
    // Deal name → TA rules. Tested in order; first match wins. Ophthalmology
    // catch-all sweeps up every disease term seen in the existing pipeline
    // (WetAMD / GA / DME / DR / Glaucoma / cataract / OCT / fundus / retina /
    // InSite Insights). Non-ophthalmology examples sit below for reference —
    // edit / add rules to fan deals out as more TAs come online.
    taAllocation: {
      rules: [
        // Ophthalmology — broad catch (case-insensitive)
        {
          pattern:
            '\\b(?:wet\\s*amd|n\\s*amd|w\\s*amd|m\\s*amd|i\\s*amd|int\\s*amd|amd|' +
            'geographic\\s+atrophy|ga\\b|dry\\s*amd|' +
            'diabetic|dme|drss|\\bdr\\b|' +
            'glaucoma|cataract|retina|retinal|rvo|' +
            'oct|fundus|insite|ophthalm|eye|ocular|lasik|biomarker|altris)\\b',
          ta: 'Ophthalmology',
          note: 'Ophthalmology catch-all: AMD subtypes, GA, diabetic retinopathy/DME, glaucoma, cataract, OCT/fundus imaging, retinal studies',
        },
        // Hepatology — liver / MASH / NASH deals
        { pattern: '\\b(liver|mash|hepatic|nash)\\b', ta: 'TA3', note: 'Hepatology' },
        // Other non-ophthalmology examples (commented out — uncomment / edit
        // when additional TAs come online):
        // { pattern: '\\b(alzheimer|psychosis|psychiatry|adept)\\b', ta: 'TA2', note: 'Neuro / psychiatry' },
        // { pattern: '\\b(ckd|kidney|renal)\\b',                    ta: 'TA4', note: 'Nephrology' },
        // { pattern: '\\b(ms\\b|ppms|multiple\\s*sclerosis)\\b',    ta: 'TA5', note: 'Neurology / MS' },
      ],
      // Fallback for unmatched deals — explicit "Unallocated" bucket so they
      // surface in the deal list rather than silently rolling into Ophthalmology.
      defaultTA: 'Unallocated',
      perDeal: {},
    },
  };
}

const TA_NAMES = [
  'Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5',
  'TA6', 'TA7', 'TA8', 'TA9', 'TA10', 'TA11', 'TA12',
];

// Capital depreciation per month (72 values, Jan-2026 → Dec-2031), lifted from
// v4-model.xlsx "Capital Purchases"!row155. Drives Tangible Assets writedown and
// the below-EBITDA depreciation expense. Replaces the stale costs_data.json
// series (the xlsx extract never touched the Capital Purchases sheet).
const V4_DEPRECIATION_MONTHLY: number[] = [2373.9050, 2873.9050, 3373.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 3873.9050, 5123.9050, 5540.5717, 5957.2383, 11373.9050, 11790.5717, 12623.9050, 13040.5717, 13040.5717, 13457.2383, 13873.9050, 13873.9050, 13873.9050, 12333.3333, 12250.0000, 12166.6667, 12500.0000, 12916.6667, 13333.3333, 13750.0000, 14166.6667, 14583.3333, 19583.3333, 22500.0000, 22500.0000, 26666.6667, 28333.3333, 32500.0000, 28333.3333, 28416.6667, 28083.3333, 28166.6667, 28666.6667, 28250.0000, 27833.3333, 27833.3333, 27833.3333, 27000.0000, 26583.3333, 26166.6667, 25333.3333, 26166.6667, 26166.6667, 26166.6667, 31166.6667, 31166.6667, 27000.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000, 24500.0000];

export function loadInitialInput(): ModelInput {
  const dates = raw.dates as string[];
  const schedule: Schedule = {};
  for (const ta of TA_NAMES) {
    const s = (raw.schedule as Record<string, { A: number[]; B: number[]; C: number[] }>)[ta];
    schedule[ta] = {
      A: s ? [...s.A] : new Array(dates.length).fill(0),
      B: s ? [...s.B] : new Array(dates.length).fill(0),
      C: s ? [...s.C] : new Array(dates.length).fill(0),
    };
  }
  const pricing = raw.pricing as Pricing;
  // Initial HubSpot data comes from extract — pre-sync, every dollar lives in
  // the legacy `lineItems` bucket. We seed `byTALineItems` with the same
  // values under "Ophthalmology" since that's the only modeled TA today (and
  // also the default TA in `defaultHubSpotSyncAssumptions().taAllocation`).
  // The first call to `syncHubSpot` overwrites this with a freshly-bucketed
  // version computed from the rule set.
  const hsLineItems = { ...(hsRaw.lineItems as Record<string, number[]>) };
  const hubspot: HubSpotData = {
    lineItems: hsLineItems,
    byTALineItems: { Ophthalmology: Object.fromEntries(
      Object.entries(hsLineItems).map(([k, v]) => [k, [...v]]),
    ) },
    grandTotal: [...(hsRaw.grandTotal as number[])],
  };
  const employees: Employee[] = (empRaw.employees as Omit<Employee, 'id'>[]).map((e, i) => ({
    ...e,
    id: `emp-${i}`,
  }));
  const employeeAssumptions = empRaw.assumptions as EmployeeAssumptions;

  const costsLineItems = costsRaw.lineItems as Record<CostDept, Record<string, number[]>>;
  const costs: CostsData = {
    depts: ['Sales and Marketing', 'G&A', 'Engineering', 'Product Support'],
    lineItems: {
      'Sales and Marketing': { ...costsLineItems['Sales and Marketing'] },
      'G&A': { ...costsLineItems['G&A'] },
      Engineering: { ...costsLineItems['Engineering'] },
      'Product Support': { ...costsLineItems['Product Support'] },
    },
    deptToTab: costsRaw.deptToTab as Record<string, CostDept>,
    costOfSales: {
      // Capital depreciation per month, refreshed from v4-model.xlsx's
      // "Capital Purchases"!row155 (the per-asset straight-line schedule that
      // writes down Tangible Assets). v4 books this in Cost of Sales
      // ("Computer", row23) rather than the P&L Depreciation line (row49,
      // which it leaves blank after Mar 2026 — see BUG note in the PR/summary);
      // we book it below EBITDA. Either placement hits profit identically, so
      // Current Earnings still reconciles to v4. Sum ≈ $1,316,474 over 6y.
      depreciation: V4_DEPRECIATION_MONTHLY,
    },
  };

  const commission: CommissionAssumptions = {
    rate: 0.8,
    capPerMonth: 30000,
    salesPerClient: 6000,
    salesInvoiceRate: 0.12,
  };

  // Opening balance sheet — v4 2025-12 *closing* values (same as 2026-01
  // opening for the forecast). Pulled directly from Budgets col F. v4 splits
  // historical retained earnings into BFWD (pre-2025: -$7,539,789) plus
  // "current earnings" rolling (-$3,994,378 of 2025 actuals at t=0). Our
  // engine sums those into `bfwdRetainedEarnings` since our `current_earnings`
  // is reset to zero at the forecast start. No `otherReserve` plug needed —
  // BFWD = -$11,534,167 makes Net Assets = Total Equity exactly at t=0.
  const openingBs: OpeningBalanceSheet = {
    openingCash: 1_112_772,
    openingTangibleAssets: 45_635,
    openingIntangibleAssets: 0,
    openingTradeDebtors: 119_540,
    openingOtherDebtors: 126_214,
    openingVat: 48_313,
    openingTradeCreditors: -72_330,
    openingDeferredRevenue: 0,
    openingOtherCreditors: -381_704,
    openingLoans: -217_680,
    shareCapital: 246,
    sharePremium: 12_316_680,
    otherReserve: 0,
    bfwdRetainedEarnings: -11_536_167,
    // v4's *reported* opening BFWD (Budgets!G91 = −8,437,292 GBP × 1.32). It is
    // £398,942 less negative than our arithmetically-correct figure above —
    // v4 rebases opening retained earnings at Jan-2026 by an amount that does
    // not reconcile to its own Dec-2025 close (BFWD −7,539,789 + 2025 earnings
    // −3,996,378 = −11,536,167). Drives the BS "Net Assets (v4 basis)"
    // reconciliation line only; changes no modeled balance. See the Excel-bug
    // notes. v4's overstatement is what puts v4's Net Assets ~£417k above ours.
    v4ReportedBfwdRetainedEarnings: -11_137_225,
  };

  const bsAssumptions: BalanceSheetAssumptions = {
    arDays: 60,
    apDays: 30,
    monthlyLoanRepayment: 0,
  };

  // v4 per-month BS schedule, refreshed from v4-model.xlsx.
  //  • capex          — Capital Purchases!row65 monthly totals (gross asset
  //                     additions). $3,600 in Jan-2026 then $0 until the 2027
  //                     ramp; sums to $1,081,600 over 6y.
  //  • loanRepayment  — clears the $217,680 opening BlueJay loan on v4's path:
  //                     $23,640 in Jan-2026 (the Dec-25→Jan-26 actual paydown,
  //                     which takes the balance to v4's flat -$194,040), then
  //                     $0 until Apr-2027 (m=15), $12,000/mo to Jul-2028, and a
  //                     final $2,040 in Aug-2028 (m=31) to reach zero.
  //  • otherDebtors   — Budgets!row73 (from 'Revenue Model auto' deferred
  //                     costs) for m≥3; m0-2 kept as the prior small ramp
  //                     rather than v4's £-actuals (570k/562k/147k).
  //  • tradeCreditors / vat / otherCreditors — Budgets rows 78 / 74 / 80
  //                     closing balances (unchanged; these already tie to v4
  //                     year-end exactly).
  const bsMonthlySchedule: BalanceSheetMonthlySchedule[] = [
    { monthIdx: 0, capex: 3600.00, loanRepayment: 23640.00, tradeCreditors: -38925.81, otherDebtors: 6400.00, vat: 8773.87, otherCreditors: -42164.87 },
    { monthIdx: 1, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -44229.81, otherDebtors: 12800.00, vat: 13075.87, otherCreditors: -146466.87 },
    { monthIdx: 2, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -56625.81, otherDebtors: 19200.00, vat: 17839.87, otherCreditors: -251230.87 },
    { monthIdx: 3, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -93669.81, otherDebtors: 12800.00, vat: 8516.00, otherCreditors: -447907.00 },
    { monthIdx: 4, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -43605.81, otherDebtors: 19200.00, vat: 12480.00, otherCreditors: -451871.00 },
    { monthIdx: 5, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -117717.81, otherDebtors: 47200.00, vat: 15542.00, otherCreditors: -454933.00 },
    { monthIdx: 6, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -67605.81, otherDebtors: 47200.00, vat: 4416.00, otherCreditors: -426640.33 },
    { monthIdx: 7, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -34005.81, otherDebtors: 47200.00, vat: 5331.40, otherCreditors: -410389.07 },
    { monthIdx: 8, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -58065.81, otherDebtors: 47200.00, vat: 9118.40, otherCreditors: -342509.40 },
    { monthIdx: 9, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -58185.81, otherDebtors: 47200.00, vat: 7869.00, otherCreditors: -341260.00 },
    { monthIdx: 10, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -34185.81, otherDebtors: 47200.00, vat: 8531.00, otherCreditors: -341922.00 },
    { monthIdx: 11, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -46185.81, otherDebtors: 47200.00, vat: 8673.00, otherCreditors: -342064.00 },
    { monthIdx: 12, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -160301.61, otherDebtors: 115950.00, vat: 10046.48, otherCreditors: -343437.48 },
    { monthIdx: 13, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -154301.61, otherDebtors: 132616.67, vat: 14239.43, otherCreditors: -347630.43 },
    { monthIdx: 14, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -119561.61, otherDebtors: 147200.00, vat: 22415.84, otherCreditors: -355806.84 },
    { monthIdx: 15, capex: 130000.00, loanRepayment: 12000.00, tradeCreditors: -375401.61, otherDebtors: 330716.67, vat: 18421.84, otherCreditors: -351812.84 },
    { monthIdx: 16, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -389081.61, otherDebtors: 305033.33, vat: 36465.19, otherCreditors: -369856.19 },
    { monthIdx: 17, capex: 20000.00, loanRepayment: 12000.00, tradeCreditors: -155741.61, otherDebtors: 300950.00, vat: 50814.35, otherCreditors: -384205.35 },
    { monthIdx: 18, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -130061.61, otherDebtors: 291783.33, vat: 22799.68, otherCreditors: -356190.68 },
    { monthIdx: 19, capex: 0.00, loanRepayment: 12000.00, tradeCreditors: -96461.61, otherDebtors: 257616.67, vat: 28098.53, otherCreditors: -361489.53 },
    { monthIdx: 20, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -168461.61, otherDebtors: 246366.67, vat: 44965.29, otherCreditors: -378356.29 },
    { monthIdx: 21, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -152981.61, otherDebtors: 233033.33, vat: 28302.70, otherCreditors: -361693.70 },
    { monthIdx: 22, capex: 0.00, loanRepayment: 12000.00, tradeCreditors: -98981.61, otherDebtors: 194700.00, vat: 34692.38, otherCreditors: -368083.38 },
    { monthIdx: 23, capex: 0.00, loanRepayment: 12000.00, tradeCreditors: -80981.61, otherDebtors: 156366.67, vat: 37930.40, otherCreditors: -371321.40 },
    { monthIdx: 24, capex: 20000.00, loanRepayment: 12000.00, tradeCreditors: -189640.20, otherDebtors: 188866.67, vat: 14376.12, otherCreditors: -347767.12 },
    { monthIdx: 25, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -313120.20, otherDebtors: 269283.33, vat: 20203.39, otherCreditors: -353594.39 },
    { monthIdx: 26, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -397180.20, otherDebtors: 297616.67, vat: 35023.58, otherCreditors: -368414.58 },
    { monthIdx: 27, capex: 20000.00, loanRepayment: 12000.00, tradeCreditors: -373180.20, otherDebtors: 421783.33, vat: 20890.38, otherCreditors: -354281.38 },
    { monthIdx: 28, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -489580.20, otherDebtors: 540866.67, vat: 23606.82, otherCreditors: -356997.82 },
    { monthIdx: 29, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -409300.20, otherDebtors: 563866.67, vat: 31951.17, otherCreditors: -365342.17 },
    { monthIdx: 30, capex: 10000.00, loanRepayment: 12000.00, tradeCreditors: -281020.20, otherDebtors: 581783.33, vat: 17333.29, otherCreditors: -350724.29 },
    { monthIdx: 31, capex: 10000.00, loanRepayment: 2040.00, tradeCreditors: -253420.20, otherDebtors: 597616.67, vat: 20981.40, otherCreditors: -354372.40 },
    { monthIdx: 32, capex: 10000.00, loanRepayment: 0.00, tradeCreditors: -355420.20, otherDebtors: 636366.67, vat: 35339.92, otherCreditors: -368730.92 },
    { monthIdx: 33, capex: 120000.00, loanRepayment: 0.00, tradeCreditors: -463420.20, otherDebtors: 782616.67, vat: 21566.21, otherCreditors: -354957.21 },
    { monthIdx: 34, capex: 70000.00, loanRepayment: 0.00, tradeCreditors: -403420.20, otherDebtors: 743450.00, vat: 27444.31, otherCreditors: -360835.32 },
    { monthIdx: 35, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -175420.20, otherDebtors: 677200.00, vat: 36605.75, otherCreditors: -369996.75 },
    { monthIdx: 36, capex: 130000.00, loanRepayment: 0.00, tradeCreditors: -209699.72, otherDebtors: 660950.00, vat: 20185.34, otherCreditors: -353576.34 },
    { monthIdx: 37, capex: 50000.00, loanRepayment: 0.00, tradeCreditors: -497699.72, otherDebtors: 829283.33, vat: 30187.17, otherCreditors: -363578.17 },
    { monthIdx: 38, capex: 110000.00, loanRepayment: 0.00, tradeCreditors: -551759.72, otherDebtors: 812200.00, vat: 46377.74, otherCreditors: -379768.74 },
    { monthIdx: 39, capex: 30000.00, loanRepayment: 0.00, tradeCreditors: -407759.72, otherDebtors: 854700.00, vat: 30859.06, otherCreditors: -364250.06 },
    { monthIdx: 40, capex: 12000.00, loanRepayment: 0.00, tradeCreditors: -494159.72, otherDebtors: 892116.67, vat: 48099.63, otherCreditors: -381490.63 },
    { monthIdx: 41, capex: 12000.00, loanRepayment: 0.00, tradeCreditors: -389759.72, otherDebtors: 835533.33, vat: 63184.79, otherCreditors: -396575.79 },
    { monthIdx: 42, capex: 12000.00, loanRepayment: 0.00, tradeCreditors: -303419.72, otherDebtors: 798866.67, vat: 33536.98, otherCreditors: -366927.98 },
    { monthIdx: 43, capex: 12000.00, loanRepayment: 0.00, tradeCreditors: -347819.72, otherDebtors: 773866.67, vat: 51255.47, otherCreditors: -384646.47 },
    { monthIdx: 44, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -389819.72, otherDebtors: 748866.67, vat: 69813.96, otherCreditors: -403204.96 },
    { monthIdx: 45, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -497819.72, otherDebtors: 823866.67, vat: 35071.56, otherCreditors: -368462.56 },
    { monthIdx: 46, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -407819.72, otherDebtors: 723866.67, vat: 51134.63, otherCreditors: -384525.63 },
    { monthIdx: 47, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -179819.72, otherDebtors: 598866.67, vat: 65992.29, otherCreditors: -399383.29 },
    { monthIdx: 48, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -292250.21, otherDebtors: 598866.67, vat: 31094.47, otherCreditors: -364485.47 },
    { monthIdx: 49, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -562250.21, otherDebtors: 698866.67, vat: 46881.28, otherCreditors: -380272.28 },
    { monthIdx: 50, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -574250.21, otherDebtors: 698866.67, vat: 63118.09, otherCreditors: -396509.09 },
    { monthIdx: 51, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -472250.21, otherDebtors: 723866.67, vat: 31523.62, otherCreditors: -364914.62 },
    { monthIdx: 52, capex: 30000.00, loanRepayment: 0.00, tradeCreditors: -588650.21, otherDebtors: 820866.67, vat: 44705.01, otherCreditors: -378096.01 },
    { monthIdx: 53, capex: 10000.00, loanRepayment: 0.00, tradeCreditors: -514250.21, otherDebtors: 773866.67, vat: 58336.41, otherCreditors: -391727.41 },
    { monthIdx: 54, capex: 10000.00, loanRepayment: 0.00, tradeCreditors: -325850.21, otherDebtors: 723866.67, vat: 25607.37, otherCreditors: -358998.37 },
    { monthIdx: 55, capex: 130000.00, loanRepayment: 0.00, tradeCreditors: -292250.21, otherDebtors: 648866.67, vat: 37133.35, otherCreditors: -370524.35 },
    { monthIdx: 56, capex: 10000.00, loanRepayment: 0.00, tradeCreditors: -394250.21, otherDebtors: 673866.67, vat: 49259.32, otherCreditors: -382650.32 },
    { monthIdx: 57, capex: 20000.00, loanRepayment: 0.00, tradeCreditors: -592250.21, otherDebtors: 773866.67, vat: 24201.95, otherCreditors: -357592.95 },
    { monthIdx: 58, capex: 10000.00, loanRepayment: 0.00, tradeCreditors: -442250.21, otherDebtors: 673866.67, vat: 35827.93, otherCreditors: -369218.93 },
    { monthIdx: 59, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -184250.21, otherDebtors: 548866.67, vat: 47903.91, otherCreditors: -381294.91 },
    { monthIdx: 60, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -304850.21, otherDebtors: 548866.67, vat: 60929.88, otherCreditors: -394320.88 },
    { monthIdx: 61, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -544850.21, otherDebtors: 623866.67, vat: 73505.86, otherCreditors: -406896.86 },
    { monthIdx: 62, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -574850.21, otherDebtors: 648866.67, vat: 85224.33, otherCreditors: -418615.33 },
    { monthIdx: 63, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -514850.21, otherDebtors: 673866.67, vat: 96942.81, otherCreditors: -430333.81 },
    { monthIdx: 64, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -544850.21, otherDebtors: 723866.67, vat: 112124.20, otherCreditors: -445515.20 },
    { monthIdx: 65, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -484850.21, otherDebtors: 698866.67, vat: 125236.85, otherCreditors: -458627.85 },
    { monthIdx: 66, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -394850.21, otherDebtors: 673866.67, vat: 138799.49, otherCreditors: -472190.49 },
    { monthIdx: 67, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -334850.21, otherDebtors: 598866.67, vat: 155136.30, otherCreditors: -488527.30 },
    { monthIdx: 68, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -394850.21, otherDebtors: 623866.67, vat: 169556.44, otherCreditors: -502947.44 },
    { monthIdx: 69, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -604850.21, otherDebtors: 723866.67, vat: 184774.50, otherCreditors: -518165.50 },
    { monthIdx: 70, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -454850.21, otherDebtors: 623866.67, vat: 200161.31, otherCreditors: -533552.31 },
    { monthIdx: 71, capex: 0.00, loanRepayment: 0.00, tradeCreditors: -184850.21, otherDebtors: 498866.67, vat: 218842.29, otherCreditors: -552233.29 },
  ];

  // Per-employee monthly cost adjustments. Pre-populated with the two
  // v4 spreadsheet hand-edits we identified (Blaise's two-step trajectory
  // and Naaman's pay cut). Factors multiply the cleanly-computed monthly
  // cost and *carry forward* until the next entry for the same employee.
  const findId = (first: string, last: string): string | undefined =>
    employees.find((e) => e.firstName === first && e.surname === last)?.id;
  const blaiseId = findId('Blaise', 'Thomson');
  const naamanId = findId('Naaman', 'Tammuz');
  const employeeCostAdjustments: EmployeeCostAdjustment[] = [];
  if (naamanId) {
    employeeCostAdjustments.push({
      employeeId: naamanId,
      monthIdx: 3, // Apr 2026
      factor: 0.8,
      note: 'v4: ×0.8 pay cut from Apr 2026 (Apr 2026 formula =$N61*$O$1*0.8); persists onward',
    });
  }
  if (blaiseId) {
    employeeCostAdjustments.push(
      {
        employeeId: blaiseId,
        monthIdx: 3, // Apr 2026
        factor: 0.66,
        note: 'v4: ×0.66 multiplier from Apr 2026 (Apr 2026 formula =$N41*$O$1*0.66)',
      },
      {
        employeeId: blaiseId,
        monthIdx: 15, // Apr 2027
        // 17,588.34 / (5,971.35 × 1.05) ≈ 2.8052 — gets Blaise's monthly cost
        // to match Naaman's Apr 2027 value (v4 formula =AA61 references
        // Naaman, then both inflate together).
        factor: 2.8052,
        note: 'v4: Apr 2027 onwards salary tracks Naaman Tammuz (CPO) — factor that yields the same monthly cost',
      },
    );
  }

  // Reproduce v4's six 2026 Ophthalmology budget tweaks. Jan/Feb/Mar are
  // built into the Budgets sheet's per-cell formulas (e.g. G6 =
  // Revenue!L19 + (33165 × 1.32 − 8000)); Oct/Nov/Dec are hardcoded into
  // Revenue!row 19 itself (no formula — manually pasted values that exceed
  // the HubSpot Pivot total for those months by exactly $50,000 each).
  // Together these adjustments add $217,998 to v4's 2026 Ophthalmology row.
  const revenueAdjustments: RevenueAdjustment[] = [
    { monthIdx: 0,  ta: 'Ophthalmology', value: 35778,
      note: 'v4 Jan 2026 Budgets!G6: + (33,165 × 1.32 − 8,000)' },
    { monthIdx: 1,  ta: 'Ophthalmology', value: 16987,
      note: 'v4 Feb 2026 Budgets!H6: + (12,869 × 1.32)' },
    { monthIdx: 2,  ta: 'Ophthalmology', value: 15233,
      note: 'v4 Mar 2026 Budgets!I6: + (31,919 × 1.32) − 26,900' },
    { monthIdx: 9,  ta: 'Ophthalmology', value: 50000,
      note: 'v4 Oct 2026 Revenue!U19: hardcoded value $50k above HubSpot Pivot' },
    { monthIdx: 10, ta: 'Ophthalmology', value: 50000,
      note: 'v4 Nov 2026 Revenue!V19: hardcoded value $50k above HubSpot Pivot' },
    { monthIdx: 11, ta: 'Ophthalmology', value: 50000,
      note: 'v4 Dec 2026 Revenue!W19: hardcoded value $50k above HubSpot Pivot' },
  ];

  // Reproduce v4's four 2026 manual modeller-commission entries in
  // Budgets!row 22 (Jan/Feb/Mar formulas + May pasted value). Our row-304-
  // equivalent calculation evaluates to 0 in these months (no AI-licence
  // revenue yet), but v4 carries historic commitments — likely modeller fees
  // for ongoing work that pre-dates the new revenue ramp. Values are positive
  // here (cost amount) and become negative in the P&L as cost-of-sales.
  const modellerCommissionAdjustments: ModellerCommissionAdjustment[] = [
    { monthIdx: 0, value: 9449.88,
      note: 'v4 Jan 2026 Budgets!G22: -7,159 × 1.32 (historic commitment, USD/GBP-scaled)' },
    { monthIdx: 1, value: 2943.60,
      note: 'v4 Feb 2026 Budgets!H22: -2,230 × 1.32' },
    { monthIdx: 2, value: 3344.88,
      note: 'v4 Mar 2026 Budgets!I22: -2,534 × 1.32' },
    // Apr 2026 has no v4 override — leaves the modelled 0 in place.
    { monthIdx: 4, value: 5000,
      note: 'v4 May 2026 Budgets!K22: hardcoded -$5,000 (no formula)' },
  ];

  // Per-month sales commission overrides. v4's S&M Commission line is fully
  // hardcoded — every monthly cell is a pasted value (see
  // costs_data.json → Sales and Marketing → Commission). Our formula
  // `min(6k × starts + 12% × revenue, 1.5 × Total Sales Salary)` diverges
  // from those numbers in later years (the v4 hardcoded values plateau
  // around $145k/month from 2029 onward, lower than our cap-based result).
  // Pre-populating overrides with the v4 monthly values gives a perfect
  // alignment out of the box; set any cell to null to fall back to the formula.
  const v4SmCommission = (costsRaw.lineItems as Record<CostDept, Record<string, number[]>>)['Sales and Marketing']['Commission'] ?? new Array(dates.length).fill(0);
  const salesCommissionOverrides: SalesCommissionOverride[] = v4SmCommission.map((value, monthIdx): SalesCommissionOverride => ({
    monthIdx,
    value,
    note: '', // v4 monthly value from costs_data.json
  }));

  // v4 manually subtracts $2,642 / $2,506 / $4,410 from the G&A Salaries line
  // for Jan/Feb/Mar 2026 (cells G&A!G5/H5/I5 use formulas like
  // `=Employees!L51-2642` rather than pulling Employees!L51 directly). These
  // look like "actual-paid vs modelled" budget reconciliations for the first
  // three months. Our employee model gives the un-reconciled $24,707.43/mo for
  // these months (matching Employees!L51), so we pre-populate staff actuals to
  // match v4's adjusted values. The per-dept total auto-recomputes
  // (staff_actual + non_staff_modelled + derived_modelled) to match v4 G&A!*27.
  // R&D tax credit per month. v4 books the full annual credit in a single month
  // (April of each year). 2026 is $0 in v4 (the previously-used $437k was from
  // an older spreadsheet version). Apr 2027 (month 15) and Apr 2028 (month 27)
  // each receive the $330k credit as a lump sum (Budgets!row 53).
  const rdTaxCredit: number[] = new Array(dates.length).fill(0);
  rdTaxCredit[15] = 330_000; // Apr 2027
  rdTaxCredit[27] = 330_000; // Apr 2028

  // Interest income on cash, booked between EBITDA and operating profit. v4
  // carries actual interest only in Q1-2026 (Budgets!G48 = 16,648 × 1.32;
  // H48 = 1,196 × 1.32) and nothing thereafter. Reproduced here so 2026
  // operating profit / PaT ties to v4; set later months to model interest on
  // the cash balance if/when that's wanted.
  const interestIncome: number[] = new Array(dates.length).fill(0);
  interestIncome[0] = 16_648 * 1.32; // Jan 2026 = 21,975.36
  interestIncome[1] = 1_196 * 1.32;  // Feb 2026 = 1,578.72

  const actuals: Actuals = {
    pnlMonthly: {},
    costDeptMonthly: {
      'Sales and Marketing': {},
      'G&A': {
        0: { staff: 22065.43 }, // Jan 2026: -$2,642 v4 adjustment
        1: { staff: 22201.43 }, // Feb 2026: -$2,506 v4 adjustment
        2: { staff: 20297.43 }, // Mar 2026: -$4,410 v4 adjustment
      },
      Engineering: {},
      'Product Support': {},
    },
    bsMonthly: {},
  };

  return {
    taNames: TA_NAMES,
    dates,
    pricing,
    schedule,
    hubspot,
    hubspotSync: defaultHubSpotSyncAssumptions(),
    employees,
    employeeAssumptions,
    costs,
    commission,
    openingBs,
    bsAssumptions,
    bsMonthlySchedule,
    actuals,
    employeeCostAdjustments,
    revenueAdjustments,
    modellerCommissionAdjustments,
    salesCommissionOverrides,
    rdTaxCredit,
    interestIncome,
  };
}

export function emptyInput(): ModelInput {
  const init = loadInitialInput();
  for (const ta of init.taNames) {
    init.schedule[ta].A.fill(0);
    init.schedule[ta].B.fill(0);
    init.schedule[ta].C.fill(0);
  }
  return init;
}

export const EXPECTED_TOTALS = (raw as { expected_totals: Record<string, { platform: number; project: number; pm: number; total: number }> }).expected_totals;
