export type TrialType = 'A' | 'B' | 'C';

export interface TypePricing {
  sites: number;
  bitfountLicense: number;
  aiLicense: number;
  projectFee: number;
  pmFee: number;
}

export type Pricing = Record<TrialType, TypePricing>;

export type StartsByType = Record<TrialType, number[]>;

export type Schedule = Record<string, StartsByType>;

export interface HubSpotData {
  /** Line-item label → 72-month values aligned with `dates`.
   *  Sum across all therapeutic areas. */
  lineItems: Record<string, number[]>;
  /** Per-(TA, line_item, month) values. The transform allocates each deal
   *  to a TA using the rules in `HubSpotSyncAssumptions.taAllocation`, then
   *  buckets that deal's line-item monthly values under the resolved TA. */
  byTALineItems: Record<string, Record<string, number[]>>;
  /** Pre-summed grand total per month (= Σ lineItems). */
  grandTotal: number[];
}

export interface Employee {
  id: string;
  firstName: string;
  surname: string;
  position: string;
  department: string;
  location: string;
  /** "Current" for already-employed, or YYYY-MM for a future hire. */
  startDate: 'Current' | string;
  /** Optional YYYY-MM end date. Cost is zero from the month after `endDate`
   *  onwards — used for redundancies / departures in the v4 plan. `null`
   *  means the employee runs through the full forecast horizon. */
  endDate?: string | null;
  /** Annual base salary in USD. */
  salary: number;
  /** Whether this employee's monthly cost feeds the sales-commission cap
   *  (`1.5 × Total Sales Salary`). Set on Sales / Marketing / Therapeutic
   *  roles per the v4 spreadsheet — see SALES_CAP_ROWS in extract_xlsx.py. */
  salesCapEligible?: boolean;
}

/** A per-month override of the modelled sales commission. v4's S&M
 *  Commission line is **fully hardcoded** for all 72 months (every monthly
 *  cell pulls from a pasted value in the Sales & Marketing sheet) — there's
 *  no formula it follows. To match v4, we expose every month as an editable
 *  override; setting `value` to `null` (or omitting the entry) falls back to
 *  our `min(6k × starts + 12% × revenue, 1.5 × Total Sales Salary)` formula. */
export interface SalesCommissionOverride {
  monthIdx: number;
  /** `null` means use the modelled value; any number (including 0) replaces it. */
  value: number | null;
  note?: string;
}

/** A manual cost-side addition to the modelled modeller commission for a
 *  specific month. Used to reproduce v4's hand-entered Jan/Feb/Mar/May 2026
 *  entries in Budgets!row 22 (formulas like `-7159 × 1.32`) — historic
 *  commitments paid before the modelled AI-revenue ramp begins. Positive
 *  values add to monthly cost; the modelled row-304 calc continues to drive
 *  later months. */
export interface ModellerCommissionAdjustment {
  monthIdx: number;
  value: number;
  note?: string;
}

/** A manual revenue adjustment on top of the modeled + HubSpot per-TA total
 *  for a specific (ta, month_idx). Used to reproduce v4's hand-edited Budgets-
 *  sheet adjustments — the Jan/Feb/Mar 2026 Ophthalmology formulas with
 *  `+ (33165 × 1.32 − 8000)` etc., and the +$50k/month Oct–Dec 2026 hardcoded
 *  values pasted into Revenue!row 19. Positive values add to revenue. */
export interface RevenueAdjustment {
  monthIdx: number;
  ta: string;
  value: number;
  note?: string;
}

/** Per-(employee, month) salary adjustment. The factor multiplies the
 *  cleanly-computed monthly cost and *carries forward* until the next
 *  adjustment for the same employee. Used for v4's hand-edited per-cell
 *  multipliers (e.g. Naaman's ×0.8 cut from Apr 2026, Blaise's ×0.66 in
 *  Apr 2026 then jumping to track Naaman's salary in Apr 2027). */
export interface EmployeeCostAdjustment {
  employeeId: string;
  /** 0..71 — the month from which this factor applies. */
  monthIdx: number;
  factor: number;
  /** Optional human-readable explanation for the adjustment. */
  note?: string;
}

export interface EmployeeAssumptions {
  niRate: number;
  pensionRate: number;
  /** Annual inflation step applied each fiscal year. */
  annualInflationRate: number;
  /** Year and month (1-12) when inflation begins; before this, factor = 1. */
  inflationStartYear: number;
  inflationStartMonth: number;
  /** Cap on the number of inflation steps applied. v4 has a formula bug that
   *  skips the Apr 2031 step, so the maximum cycles applied is 4 (Apr 2027
   *  → Apr 2030). Set higher to "fix" the v4 bug. */
  maxInflationSteps: number;
  /** Whether to apply inflation steps to employees who haven't yet started
   *  (startDate ≠ "Current"). v4 has a formula bug that leaves future hires
   *  uninflated for the whole horizon. Set true to "fix" the v4 bug. */
  inflateFutureHires: boolean;
}

export type CostDept = 'Sales and Marketing' | 'G&A' | 'Engineering' | 'Product Support';

export interface CostsData {
  /** Per-department, per-line-item monthly arrays (excluding staff costs which come from the Employees tab). */
  lineItems: Record<CostDept, Record<string, number[]>>;
  /** Department names (a stable order). */
  depts: CostDept[];
  /** Mapping from Employees tab department key → cost tab name (used to pull staff costs as a derived row). */
  deptToTab: Record<string, CostDept>;
  costOfSales: {
    /** Capital depreciation pulled from the Capital Purchases sheet (computer assets etc.). */
    depreciation: number[];
  };
}

export type PaymentSchedule = 'Annual' | 'Uniform' | 'Start' | 'End';
export type CloseDateMode = 'predicted' | 'hubspot';

export interface HubSpotStageDef {
  closeProbability: number;
  remainingDays: number;
}

/** A single deal → TA matching rule. The pattern is a case-insensitive
 *  JavaScript regex tested against the deal name (and, in the future, other
 *  HubSpot properties). Rules are evaluated in order; the first matching
 *  rule's `ta` wins. If no rule matches, `HubSpotTAAllocation.defaultTA`
 *  is used. */
export interface HubSpotTAAllocationRule {
  pattern: string;
  ta: string;
  /** Optional human-readable note for the rule's purpose. */
  note?: string;
}

export interface HubSpotTAAllocation {
  rules: HubSpotTAAllocationRule[];
  /** TA assigned when no rule matches. */
  defaultTA: string;
  /** Per-deal override that beats the rule list. Key = HubSpot deal id,
   *  value = TA name. Set when the user manually re-assigns a deal in the
   *  HubSpot Deals view. */
  perDeal: Record<string, string>;
}

export interface HubSpotSyncAssumptions {
  /** Stage label → close probability + remaining days to predicted close. */
  stages: Record<string, HubSpotStageDef>;
  /** Line item name → payment schedule. */
  paymentSchedules: Record<string, PaymentSchedule>;
  /** Default project duration when HubSpot deal has no duration set. */
  defaultDurationMonths: number;
  /** Which close-date to use: HubSpot raw, or predicted (close + remaining stage days). */
  closeDateMode: CloseDateMode;
  /** Maps each HubSpot deal to a TA (therapeutic area). Drives the per-TA
   *  buckets in `HubSpotData.byTALineItems` and lets the modeled per-TA
   *  revenue include HubSpot pipeline directly. */
  taAllocation: HubSpotTAAllocation;
}

export interface CommissionAssumptions {
  /** Fraction of AI Model License revenue paid to the modeller as commission. */
  rate: number;
  /** Maximum modeller commission per therapeutic area per month ($). */
  capPerMonth: number;
  /** Sales commission paid per new client onboarded ($). */
  salesPerClient: number;
  /** Sales commission as a fraction of total revenue. */
  salesInvoiceRate: number;
}

/** Single-row opening balance sheet — drives every derived BS line.
 *  Liabilities (creditors, loans) stored as negative numbers. */
export interface OpeningBalanceSheet {
  openingCash: number;
  openingTangibleAssets: number;
  openingIntangibleAssets: number;
  openingTradeDebtors: number;
  openingOtherDebtors: number;
  openingVat: number;
  openingTradeCreditors: number;
  openingDeferredRevenue: number;
  openingOtherCreditors: number;
  openingLoans: number;
  shareCapital: number;
  sharePremium: number;
  otherReserve: number;
  bfwdRetainedEarnings: number;
  /** v4-model.xlsx's *reported* opening BFWD retained earnings (Budgets!G91 =
   *  −£11,137,225). It is ~£399k less negative than the arithmetically-correct
   *  roll of v4's own Dec-2025 figures (which is what `bfwdRetainedEarnings`
   *  holds): v4 rebases the opening at Jan-2026 by an amount that does not
   *  reconcile to its prior column. Used only to derive the explicit
   *  reconciliation line `net_assets_v4_basis` on the BS — it does NOT change
   *  any modeled balance. */
  v4ReportedBfwdRetainedEarnings: number;
}

/** Working-capital assumptions. */
export interface BalanceSheetAssumptions {
  /** Days sales outstanding — drives trade debtors balance. */
  arDays: number;
  /** Days payable outstanding — kept for legacy reference; trade creditors now
   *  uses the per-month schedule in `BalanceSheetMonthlySchedule`. */
  apDays: number;
  /** Single flat monthly loan repayment — kept for legacy reference; the new
   *  loan-repayment schedule lives per-month in `BalanceSheetMonthlySchedule`. */
  monthlyLoanRepayment: number;
}

/** Per-month balance-sheet inputs: capex spent, loan principal repaid, and
 *  closing balances for the four working-capital lines that v4 carries as
 *  explicit monthly trajectories (rather than days-based formulas). One row
 *  per month_idx 0..71. */
export interface BalanceSheetMonthlySchedule {
  monthIdx: number;
  /** Capital expenditure (positive = cash out, asset up). */
  capex: number;
  /** Loan principal repaid (positive = cash out, loan magnitude down). */
  loanRepayment: number;
  /** Closing trade-creditors balance (negative for liability). */
  tradeCreditors: number;
  /** Closing other-debtors balance. */
  otherDebtors: number;
  /** Closing VAT receivable balance. */
  vat: number;
  /** Closing other-creditors balance (negative for liability). */
  otherCreditors: number;
}

// ─── Actuals overrides ─────────────────────────────────────────────────────
//
// Sparse overrides keyed by year (and cost-dept where applicable). When a
// value is `undefined`, the modeled value is used; when set (including 0),
// the override replaces the modeled value at the corresponding row of the
// `*_with_actuals` engine output.

export type PnlMetric = 'revenue' | 'costOfSales' | 'grossProfit' | 'totalOpex' | 'ebitda';

export type CostDeptMetric = 'staff' | 'nonStaff' | 'total';

export type BsLine =
  | 'intangibleAssets' | 'tangibleAssets'
  | 'tradeDebtors' | 'otherDebtors' | 'vat' | 'cash'
  | 'tradeCreditors' | 'deferredRevenue' | 'otherCreditors'
  | 'loans'
  | 'shareCapital' | 'sharePremium' | 'otherReserve'
  | 'bfwdRetainedEarnings' | 'currentEarnings';

export interface Actuals {
  /** Monthly P&L overrides, keyed by month_idx (0–71). Yearly rollups derive from these. */
  pnlMonthly: Record<number, Partial<Record<PnlMetric, number>>>;
  /** Per-(dept, month_idx) opex overrides. */
  costDeptMonthly: Record<CostDept, Record<number, Partial<Record<CostDeptMetric, number>>>>;
  /** Monthly balance sheet overrides, keyed by month_idx. Yearly view picks end-of-year months. */
  bsMonthly: Record<number, Partial<Record<BsLine, number>>>;
}

export interface ModelInput {
  taNames: string[];
  dates: string[];
  pricing: Pricing;
  schedule: Schedule;
  hubspot: HubSpotData;
  hubspotSync: HubSpotSyncAssumptions;
  employees: Employee[];
  employeeAssumptions: EmployeeAssumptions;
  costs: CostsData;
  commission: CommissionAssumptions;
  openingBs: OpeningBalanceSheet;
  bsAssumptions: BalanceSheetAssumptions;
  /** Per-month capex / loans / working-capital schedules. */
  bsMonthlySchedule: BalanceSheetMonthlySchedule[];
  actuals: Actuals;
  /** Per-employee per-month salary adjustment factors. Sparse — each entry
   *  applies from its month_idx forward until the next entry for the same
   *  employee. */
  employeeCostAdjustments: EmployeeCostAdjustment[];
  /** Per-(TA, month) revenue adjustments added on top of modeled + HubSpot.
   *  Defaults reproduce v4's six 2026 Ophthalmology budget tweaks. */
  revenueAdjustments: RevenueAdjustment[];
  /** Per-month modeller commission additions on top of the row-304 modelled
   *  calculation. Defaults reproduce v4's four hand-entered Jan/Feb/Mar/May
   *  2026 Budgets!row 22 entries. */
  modellerCommissionAdjustments: ModellerCommissionAdjustment[];
  /** Per-month overrides for sales commission. `value=null` falls through to
   *  our modelled formula; any number replaces it. Defaults reproduce v4's
   *  fully-hardcoded S&M Commission line (72 monthly values from
   *  costs_data.json). */
  salesCommissionOverrides: SalesCommissionOverride[];
  /** Per-month R&D tax credit received (positive number = credit). Booked
   *  below operating profit in the P&L (operating_profit + rd_credit =
   *  profit_after_tax) and flows through to retained earnings + cash. */
  rdTaxCredit: number[];
  /** Per-month interest income (positive number = income). Booked between
   *  EBITDA and operating profit (operating_profit = ebitda − depreciation +
   *  interest_income) and flows through to retained earnings + cash. */
  interestIncome: number[];
}

export interface PerTypeMonthly {
  starts: number[];
  active: number[];
  platform: number[];
  project: number[];
  pm: number[];
}

export interface TAMonthly {
  byType: Record<TrialType, PerTypeMonthly>;
  platform: number[];
  project: number[];
  pm: number[];
  total: number[];
}

export interface DeptCostMonthly {
  /** Staff costs (from Employees tab) + non-staff line item totals + derived items. */
  staff: number[];
  nonStaff: number[];
  /** Per-month derived items (e.g. modeled sales commission), keyed by row label. */
  derived: Record<string, number[]>;
  total: number[];
}

export interface BudgetPL {
  revenue: number[];
  hubspot: number[];
  modeledRevenue: number[];
  modellerCommission: number[];
  /** Per-TA monthly commission (after the cap). */
  modellerCommissionByTA: Record<string, number[]>;
  depreciation: number[];
  costOfSales: number[];
  grossProfit: number[];
  perDept: Record<CostDept, DeptCostMonthly>;
  totalOpex: number[];
  ebitda: number[];
  yearly: {
    revenue: number[];
    costOfSales: number[];
    grossProfit: number[];
    totalOpex: number[];
    ebitda: number[];
    perDept: Record<CostDept, { staff: number[]; nonStaff: number[]; total: number[] }>;
  };
}

export interface EmployeeMonthly {
  /** Per-employee monthly cost arrays, keyed by employee id. */
  perEmployee: Record<string, number[]>;
  /** Per-department monthly cost arrays. */
  perDepartment: Record<string, number[]>;
  /** Total monthly employee cost across all employees. */
  total: number[];
  /** Yearly aggregates. */
  yearly: {
    perDepartment: Record<string, number[]>;
    total: number[];
  };
}

export interface ModelOutput {
  perTA: Record<string, TAMonthly>;
  totals: {
    platform: number[];
    project: number[];
    pm: number[];
    total: number[];
  };
  /** Modeled-TAs total + HubSpot pipeline grand total per month. */
  grandTotal: number[];
  years: number[];
  yearly: {
    perTA: Record<string, { platform: number[]; project: number[]; pm: number[]; total: number[] }>;
    totals: { platform: number[]; project: number[]; pm: number[]; total: number[] };
    hubspot: number[];
    grandTotal: number[];
  };
  employees: EmployeeMonthly;
  budget: BudgetPL;
}
