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
  };
}

const TA_NAMES = [
  'Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5',
  'TA6', 'TA7', 'TA8', 'TA9', 'TA10', 'TA11', 'TA12',
];

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
  const hubspot: HubSpotData = {
    lineItems: { ...(hsRaw.lineItems as Record<string, number[]>) },
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
      depreciation: [...(costsRaw.costOfSales.depreciation as number[])],
    },
  };

  const commission: CommissionAssumptions = {
    rate: 0.8,
    capPerMonth: 30000,
    salesPerClient: 6000,
    salesInvoiceRate: 0.12,
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
