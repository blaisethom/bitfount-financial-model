import type {
  ModelInput,
  ModelOutput,
  Pricing,
  TrialType,
  PerTypeMonthly,
  TAMonthly,
  Employee,
  EmployeeAssumptions,
  EmployeeMonthly,
  BudgetPL,
  CostDept,
  DeptCostMonthly,
} from './types';

const TYPES: TrialType[] = ['A', 'B', 'C'];

export function platformPricePerYear(p: Pricing, t: TrialType): number {
  return (p[t].bitfountLicense + p[t].aiLicense) * p[t].sites;
}

function computeActive(starts: number[]): number[] {
  // A trial is active for exactly 12 months starting in its start month.
  const n = starts.length;
  const active = new Array(n).fill(0);
  for (let m = 0; m < n; m++) {
    const s = starts[m];
    if (!s) continue;
    for (let k = 0; k < 12 && m + k < n; k++) {
      active[m + k] += s;
    }
  }
  return active;
}

function computePerType(starts: number[], pricing: Pricing, t: TrialType): PerTypeMonthly {
  const active = computeActive(starts);
  const platYear = platformPricePerYear(pricing, t);
  const platform = active.map((a) => (a * platYear) / 12);
  const project = starts.map((s) => s * pricing[t].projectFee);
  const pm = active.map((a) => a * pricing[t].pmFee);
  return { starts, active, platform, project, pm };
}

export function computeModel(input: ModelInput): ModelOutput {
  const months = input.dates.length;
  const perTA: Record<string, TAMonthly> = {};
  const totals = {
    platform: new Array(months).fill(0),
    project: new Array(months).fill(0),
    pm: new Array(months).fill(0),
    total: new Array(months).fill(0),
  };
  const hs = input.hubspot.grandTotal;
  const grandTotal = new Array(months).fill(0);

  for (const ta of input.taNames) {
    const sched = input.schedule[ta];
    const byType = {
      A: computePerType(sched.A, input.pricing, 'A'),
      B: computePerType(sched.B, input.pricing, 'B'),
      C: computePerType(sched.C, input.pricing, 'C'),
    };
    const platform = sumArrs(byType.A.platform, byType.B.platform, byType.C.platform);
    const project = sumArrs(byType.A.project, byType.B.project, byType.C.project);
    const pm = sumArrs(byType.A.pm, byType.B.pm, byType.C.pm);
    const total = sumArrs(platform, project, pm);
    perTA[ta] = { byType, platform, project, pm, total };

    for (let i = 0; i < months; i++) {
      totals.platform[i] += platform[i];
      totals.project[i] += project[i];
      totals.pm[i] += pm[i];
      totals.total[i] += total[i];
    }
  }

  for (let i = 0; i < months; i++) grandTotal[i] = totals.total[i] + hs[i];

  // Yearly aggregation (calendar years from dates)
  const years = uniqueYears(input.dates);
  const yearly = {
    perTA: {} as Record<string, { platform: number[]; project: number[]; pm: number[]; total: number[] }>,
    totals: {
      platform: years.map(() => 0),
      project: years.map(() => 0),
      pm: years.map(() => 0),
      total: years.map(() => 0),
    },
    hubspot: years.map(() => 0),
    grandTotal: years.map(() => 0),
  };

  for (const ta of input.taNames) {
    const ytaPlat = years.map(() => 0);
    const ytaProj = years.map(() => 0);
    const ytaPm = years.map(() => 0);
    const ytaTot = years.map(() => 0);
    for (let i = 0; i < months; i++) {
      const y = parseInt(input.dates[i].slice(0, 4), 10);
      const yi = years.indexOf(y);
      ytaPlat[yi] += perTA[ta].platform[i];
      ytaProj[yi] += perTA[ta].project[i];
      ytaPm[yi] += perTA[ta].pm[i];
      ytaTot[yi] += perTA[ta].total[i];
    }
    yearly.perTA[ta] = { platform: ytaPlat, project: ytaProj, pm: ytaPm, total: ytaTot };
    for (let yi = 0; yi < years.length; yi++) {
      yearly.totals.platform[yi] += ytaPlat[yi];
      yearly.totals.project[yi] += ytaProj[yi];
      yearly.totals.pm[yi] += ytaPm[yi];
      yearly.totals.total[yi] += ytaTot[yi];
    }
  }

  for (let i = 0; i < months; i++) {
    const yi = years.indexOf(parseInt(input.dates[i].slice(0, 4), 10));
    yearly.hubspot[yi] += hs[i];
  }
  for (let yi = 0; yi < years.length; yi++) {
    yearly.grandTotal[yi] = yearly.totals.total[yi] + yearly.hubspot[yi];
  }

  const employees = computeEmployees(input.employees, input.employeeAssumptions, input.dates, years);
  const budget = computeBudget(input, perTA, employees, grandTotal, years);

  return { perTA, totals, grandTotal, years, yearly, employees, budget };
}

function computeBudget(
  input: ModelInput,
  perTA: Record<string, TAMonthly>,
  employees: EmployeeMonthly,
  grandTotal: number[],
  years: number[],
): BudgetPL {
  const months = input.dates.length;
  const revenue = grandTotal.slice();
  const modeledRevenue = new Array(months).fill(0);
  const hubspot = input.hubspot.grandTotal.slice();

  for (let i = 0; i < months; i++) modeledRevenue[i] = grandTotal[i] - hubspot[i];

  // Modeller Commission (per TA, per month) =
  //   MIN(rate × Σ_t active_t × ai_license_t × sites_t / 12,  capPerMonth)
  // Sum across TAs.
  const { rate, capPerMonth } = input.commission;
  const modellerCommissionByTA: Record<string, number[]> = {};
  const modellerCommission = new Array(months).fill(0);
  for (const ta of input.taNames) {
    const taOut = perTA[ta];
    const arr = new Array(months).fill(0);
    for (let i = 0; i < months; i++) {
      let aiRev = 0;
      for (const t of TYPES) {
        aiRev += (taOut.byType[t].active[i] * input.pricing[t].aiLicense * input.pricing[t].sites) / 12;
      }
      const c = Math.min(rate * aiRev, capPerMonth);
      arr[i] = c;
      modellerCommission[i] += c;
    }
    modellerCommissionByTA[ta] = arr;
  }

  const depreciation = input.costs.costOfSales.depreciation.slice();
  const costOfSales = sumArrs(modellerCommission, depreciation);
  const grossProfit = revenue.map((r, i) => r - costOfSales[i]);

  // Sales commission (S&M):
  //   sales(m) = perClient × Σ_TA Σ_t starts_t(m) + invoiceRate × revenue(m)
  const salesCommission = new Array(months).fill(0);
  for (let i = 0; i < months; i++) {
    let starts = 0;
    for (const ta of input.taNames) {
      const sched = input.schedule[ta];
      starts += (sched.A[i] || 0) + (sched.B[i] || 0) + (sched.C[i] || 0);
    }
    salesCommission[i] = input.commission.salesPerClient * starts + input.commission.salesInvoiceRate * revenue[i];
  }

  // Per-dept costs
  const perDept = {} as Record<CostDept, DeptCostMonthly>;
  for (const dept of input.costs.depts) {
    // Staff comes from the Employees tab via the dept-key→tab mapping (reverse lookup).
    const empDeptKey = Object.keys(input.costs.deptToTab).find(
      (k) => input.costs.deptToTab[k] === dept,
    );
    const staff = empDeptKey && employees.perDepartment[empDeptKey]
      ? employees.perDepartment[empDeptKey].slice()
      : new Array(months).fill(0);
    const nonStaff = new Array(months).fill(0);
    const items = input.costs.lineItems[dept] || {};
    for (const [name, arr] of Object.entries(items)) {
      // Skip the static Commission line item; replaced by the derived `salesCommission` below.
      if (dept === 'Sales and Marketing' && name === 'Commission') continue;
      for (let i = 0; i < months; i++) nonStaff[i] += arr[i];
    }
    const derived: Record<string, number[]> = {};
    if (dept === 'Sales and Marketing') {
      derived['Sales Commission (modeled)'] = salesCommission;
    }
    const total = staff.map((s, i) => {
      let t = s + nonStaff[i];
      for (const arr of Object.values(derived)) t += arr[i];
      return t;
    });
    perDept[dept] = { staff, nonStaff, derived, total };
  }

  const totalOpex = new Array(months).fill(0);
  for (const dept of input.costs.depts) {
    for (let i = 0; i < months; i++) totalOpex[i] += perDept[dept].total[i];
  }
  const ebitda = grossProfit.map((g, i) => g - totalOpex[i]);

  // Yearly
  const yearly = {
    revenue: years.map(() => 0),
    costOfSales: years.map(() => 0),
    grossProfit: years.map(() => 0),
    totalOpex: years.map(() => 0),
    ebitda: years.map(() => 0),
    perDept: {} as Record<CostDept, { staff: number[]; nonStaff: number[]; total: number[] }>,
  };
  for (let i = 0; i < months; i++) {
    const yi = years.indexOf(parseInt(input.dates[i].slice(0, 4), 10));
    if (yi < 0) continue;
    yearly.revenue[yi] += revenue[i];
    yearly.costOfSales[yi] += costOfSales[i];
    yearly.grossProfit[yi] += grossProfit[i];
    yearly.totalOpex[yi] += totalOpex[i];
    yearly.ebitda[yi] += ebitda[i];
  }
  for (const dept of input.costs.depts) {
    const dy = { staff: years.map(() => 0), nonStaff: years.map(() => 0), total: years.map(() => 0) };
    for (let i = 0; i < months; i++) {
      const yi = years.indexOf(parseInt(input.dates[i].slice(0, 4), 10));
      if (yi < 0) continue;
      dy.staff[yi] += perDept[dept].staff[i];
      dy.nonStaff[yi] += perDept[dept].nonStaff[i];
      dy.total[yi] += perDept[dept].total[i];
    }
    yearly.perDept[dept] = dy;
  }

  return {
    revenue,
    hubspot,
    modeledRevenue,
    modellerCommission,
    modellerCommissionByTA,
    depreciation,
    costOfSales,
    grossProfit,
    perDept,
    totalOpex,
    ebitda,
    yearly,
  };
}

export function loadedSalary(salary: number, a: EmployeeAssumptions): number {
  return salary * (1 + a.niRate + a.pensionRate);
}

export function inflationFactor(yearMonth: string, a: EmployeeAssumptions): number {
  const y = parseInt(yearMonth.slice(0, 4), 10);
  const m = parseInt(yearMonth.slice(5, 7), 10);
  if (y < a.inflationStartYear) return 1;
  if (y === a.inflationStartYear && m < a.inflationStartMonth) return 1;
  const steps = (y - a.inflationStartYear) + (m >= a.inflationStartMonth ? 1 : 0);
  return Math.pow(1 + a.annualInflationRate, steps);
}

function isEmployeeActive(e: Employee, yearMonth: string): boolean {
  if (e.startDate === 'Current') return true;
  if (!e.startDate) return false;
  return yearMonth >= e.startDate;
}

function computeEmployees(
  employees: Employee[],
  a: EmployeeAssumptions,
  dates: string[],
  years: number[],
): EmployeeMonthly {
  const months = dates.length;
  const perEmployee: Record<string, number[]> = {};
  const perDepartment: Record<string, number[]> = {};
  const total = new Array(months).fill(0);

  for (const emp of employees) {
    const loaded = loadedSalary(emp.salary, a);
    const arr = new Array(months).fill(0);
    for (let i = 0; i < months; i++) {
      if (!isEmployeeActive(emp, dates[i])) continue;
      arr[i] = (loaded / 12) * inflationFactor(dates[i], a);
    }
    perEmployee[emp.id] = arr;
    if (!perDepartment[emp.department]) perDepartment[emp.department] = new Array(months).fill(0);
    for (let i = 0; i < months; i++) {
      perDepartment[emp.department][i] += arr[i];
      total[i] += arr[i];
    }
  }

  // Yearly
  const yearlyPerDept: Record<string, number[]> = {};
  const yearlyTotal = years.map(() => 0);
  for (const dept of Object.keys(perDepartment)) {
    const yarr = years.map(() => 0);
    for (let i = 0; i < months; i++) {
      const yi = years.indexOf(parseInt(dates[i].slice(0, 4), 10));
      if (yi >= 0) yarr[yi] += perDepartment[dept][i];
    }
    yearlyPerDept[dept] = yarr;
  }
  for (let i = 0; i < months; i++) {
    const yi = years.indexOf(parseInt(dates[i].slice(0, 4), 10));
    if (yi >= 0) yearlyTotal[yi] += total[i];
  }

  return {
    perEmployee,
    perDepartment,
    total,
    yearly: { perDepartment: yearlyPerDept, total: yearlyTotal },
  };
}

function sumArrs(...arrs: number[][]): number[] {
  const n = arrs[0].length;
  const out = new Array(n).fill(0);
  for (const a of arrs) for (let i = 0; i < n; i++) out[i] += a[i];
  return out;
}

function uniqueYears(dates: string[]): number[] {
  const ys = new Set<number>();
  for (const d of dates) ys.add(parseInt(d.slice(0, 4), 10));
  return Array.from(ys).sort((a, b) => a - b);
}

export { TYPES };
