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
  /** Line-item label → 72-month values aligned with `dates`. */
  lineItems: Record<string, number[]>;
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
  /** Annual base salary in USD. */
  salary: number;
}

export interface EmployeeAssumptions {
  niRate: number;
  pensionRate: number;
  /** Annual inflation step applied each fiscal year. */
  annualInflationRate: number;
  /** Year and month (1-12) when inflation begins; before this, factor = 1. */
  inflationStartYear: number;
  inflationStartMonth: number;
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

export interface ModelInput {
  taNames: string[];
  dates: string[];
  pricing: Pricing;
  schedule: Schedule;
  hubspot: HubSpotData;
  employees: Employee[];
  employeeAssumptions: EmployeeAssumptions;
  costs: CostsData;
  commission: CommissionAssumptions;
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
