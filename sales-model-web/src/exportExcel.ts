import ExcelJS from 'exceljs';
import type { ModelInput, ModelOutput, TrialType, CostDept } from './types';
import type { PerDealSummary } from './hubspot';
import { annualSummaryByType, contractValueHistory, quarterlyPivot } from './hubspot';

const TYPE_LABEL: Record<TrialType, string> = {
  A: 'Type A (Small)',
  B: 'Type B (Medium)',
  C: 'Type C (Large)',
};
const TYPES: TrialType[] = ['A', 'B', 'C'];

const MONEY = '"$"#,##0';
const COUNT = '0';
const PCT = '0.00%';
const MONTH_COL = 2;

function colLetter(col: number): string {
  let s = '';
  while (col > 0) {
    col--;
    s = String.fromCharCode(65 + (col % 26)) + s;
    col = Math.floor(col / 26);
  }
  return s;
}
const cellAddr = (r: number, c: number) => `${colLetter(c)}${r}`;
const absAddr = (r: number, c: number) => `$${colLetter(c)}$${r}`;
const ext = (sheet: string, addr: string) => `'${sheet.replace(/'/g, "''")}'!${addr}`;
const rng = (r: number, c1: number, c2: number) => `${colLetter(c1)}${r}:${colLetter(c2)}${r}`;

interface YearRange { year: number; startCol: number; endCol: number; }
function yearRanges(dates: string[]): YearRange[] {
  const out: YearRange[] = [];
  dates.forEach((d, i) => {
    const y = parseInt(d.slice(0, 4), 10);
    const last = out[out.length - 1];
    if (!last || last.year !== y) out.push({ year: y, startCol: MONTH_COL + i, endCol: MONTH_COL + i });
    else last.endCol = MONTH_COL + i;
  });
  return out;
}

type CellSpec = number | string | { f: string };
function setCell(row: ExcelJS.Row, col: number, v: CellSpec, fmt?: string, bold?: boolean) {
  const c = row.getCell(col);
  if (typeof v === 'object' && v !== null && 'f' in v) {
    c.value = { formula: v.f };
  } else {
    c.value = v;
  }
  if (fmt) c.numFmt = fmt;
  if (bold) c.font = { ...(c.font || {}), bold: true };
}

function addTitle(sheet: ExcelJS.Worksheet, text: string, size = 13): number {
  const row = sheet.addRow([text]);
  row.getCell(1).font = { bold: true, size };
  return row.number;
}
function addSubtitle(sheet: ExcelJS.Worksheet, text: string): number {
  const row = sheet.addRow([text]);
  row.getCell(1).font = { bold: true, size: 11 };
  return row.number;
}
function addBlank(sheet: ExcelJS.Worksheet, n = 1) {
  for (let i = 0; i < n; i++) sheet.addRow([]);
}
function addMonthHeader(sheet: ExcelJS.Worksheet, dates: string[], firstCol = ''): number {
  const row = sheet.addRow([firstCol, ...dates]);
  row.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  row.getCell(1).alignment = { horizontal: 'left' };
  return row.number;
}
function addYearHeader(
  sheet: ExcelJS.Worksheet,
  years: number[],
  firstCol = '',
  totalLabel = '6-yr Total',
): number {
  const row = sheet.addRow([firstCol, ...years.map(String), totalLabel]);
  row.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  row.getCell(1).alignment = { horizontal: 'left' };
  return row.number;
}
function addDataRow(
  sheet: ExcelJS.Worksheet,
  label: string,
  values: CellSpec[],
  fmt: string = MONEY,
  bold = false,
  startCol = MONTH_COL,
): number {
  const row = sheet.addRow([label]);
  for (let i = 0; i < values.length; i++) setCell(row, startCol + i, values[i], fmt, bold);
  if (bold) row.getCell(1).font = { ...(row.getCell(1).font || {}), bold: true };
  return row.number;
}
function setColumnWidths(sheet: ExcelJS.Worksheet, firstWidth: number, restWidth: number, count: number) {
  sheet.getColumn(1).width = firstWidth;
  for (let i = 2; i <= count + 1; i++) sheet.getColumn(i).width = restWidth;
}

function yearlyRowFormulas(rowIdx: number, yrs: YearRange[], months: number): CellSpec[] {
  return [
    ...yrs.map((yr) => ({ f: `SUM(${rng(rowIdx, yr.startCol, yr.endCol)})` } as CellSpec)),
    { f: `SUM(${rng(rowIdx, MONTH_COL, MONTH_COL + months - 1)})` },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue Model
// ─────────────────────────────────────────────────────────────────────────────

interface RMRefs {
  sheet: string;
  pricing: Record<TrialType, { sites: string; bitfount: string; ai: string; project: string; pm: string }>;
  commission: { rate: string; cap: string; salesPerClient: string; salesInvoiceRate: string };
  perTA: Record<string, {
    startsRow: Record<TrialType, number>;
    activeRow: Record<TrialType, number>;
    activeTotalRow: number;
    platformRow: number;
    projectRow: number;
    pmRow: number;
    totalRow: number;
    modellerCommRow: number;
  }>;
  totalStartsRow: number;
  totalModellerCommRow: number;
  activeTANames: string[];
}

function buildRevenueModel(wb: ExcelJS.Workbook, input: ModelInput, output: ModelOutput): RMRefs {
  const sheetName = 'Revenue Model';
  const sheet = wb.addWorksheet(sheetName);
  const dates = input.dates;
  const months = dates.length;
  const yrs = yearRanges(dates);

  addTitle(sheet, 'Pricing assumptions');
  const ph = sheet.addRow(['Type', 'Sites', 'Bitfount License', 'AI License', 'Project Fee', 'PM Fee']);
  ph.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
  const pricing = {} as RMRefs['pricing'];
  for (const t of TYPES) {
    const p = input.pricing[t];
    const r = sheet.addRow([TYPE_LABEL[t], p.sites, p.bitfountLicense, p.aiLicense, p.projectFee, p.pmFee]);
    [3, 4, 5, 6].forEach((c) => (r.getCell(c).numFmt = MONEY));
    pricing[t] = {
      sites: absAddr(r.number, 2),
      bitfount: absAddr(r.number, 3),
      ai: absAddr(r.number, 4),
      project: absAddr(r.number, 5),
      pm: absAddr(r.number, 6),
    };
  }

  addBlank(sheet);
  addTitle(sheet, 'Commission assumptions');
  const ch = sheet.addRow(['Parameter', 'Value']);
  ch.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
  const addCommRow = (label: string, value: number, fmt: string) => {
    const r = sheet.addRow([label, value]);
    r.getCell(2).numFmt = fmt;
    return absAddr(r.number, 2);
  };
  const commission = {
    rate: addCommRow('Modeller commission rate', input.commission.rate, PCT),
    cap: addCommRow('Modeller cap (per TA / month)', input.commission.capPerMonth, MONEY),
    salesPerClient: addCommRow('Sales commission per new client', input.commission.salesPerClient, MONEY),
    salesInvoiceRate: addCommRow('Sales commission invoice rate', input.commission.salesInvoiceRate, PCT),
  };

  addBlank(sheet, 2);
  addTitle(sheet, 'Per-therapeutic-area monthly detail');

  const activeTANames = input.taNames.filter((n) => output.yearly.perTA[n].total.some((v) => v > 0));
  const perTA = {} as RMRefs['perTA'];

  for (const ta of activeTANames) {
    addBlank(sheet);
    addSubtitle(sheet, ta);

    addSubtitle(sheet, `${ta} — client starts per month`);
    addMonthHeader(sheet, dates, 'Type');
    const startsRow = {} as Record<TrialType, number>;
    for (const t of TYPES) {
      startsRow[t] = addDataRow(sheet, TYPE_LABEL[t], input.schedule[ta][t], COUNT);
    }

    addSubtitle(sheet, `${ta} — active trials per month`);
    addMonthHeader(sheet, dates, 'Type');
    const activeRow = {} as Record<TrialType, number>;
    for (const t of TYPES) {
      const formulas: CellSpec[] = dates.map((_, i) => {
        const startC = MONTH_COL + Math.max(0, i - 11);
        const endC = MONTH_COL + i;
        return { f: `SUM(${rng(startsRow[t], startC, endC)})` };
      });
      activeRow[t] = addDataRow(sheet, TYPE_LABEL[t], formulas, COUNT);
    }
    const totalActiveFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      return { f: `${cellAddr(activeRow.A, c)}+${cellAddr(activeRow.B, c)}+${cellAddr(activeRow.C, c)}` };
    });
    const activeTotalRow = addDataRow(sheet, 'Total active', totalActiveFormulas, COUNT, true);

    addSubtitle(sheet, `${ta} — monthly revenue ($)`);
    addMonthHeader(sheet, dates, 'Line');
    const platFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      const parts = TYPES.map((t) => {
        const a = cellAddr(activeRow[t], c);
        const p = pricing[t];
        return `${a}*(${p.bitfount}+${p.ai})*${p.sites}/12`;
      });
      return { f: parts.join('+') };
    });
    const platformRow = addDataRow(sheet, 'Platform revenue', platFormulas);
    const projFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      return { f: TYPES.map((t) => `${cellAddr(startsRow[t], c)}*${pricing[t].project}`).join('+') };
    });
    const projectRow = addDataRow(sheet, 'Project revenue', projFormulas);
    const pmFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      return { f: TYPES.map((t) => `${cellAddr(activeRow[t], c)}*${pricing[t].pm}`).join('+') };
    });
    const pmRow = addDataRow(sheet, 'PM fee revenue', pmFormulas);
    const totFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      return { f: `${cellAddr(platformRow, c)}+${cellAddr(projectRow, c)}+${cellAddr(pmRow, c)}` };
    });
    const totalRow = addDataRow(sheet, 'Total', totFormulas, MONEY, true);

    addSubtitle(sheet, `${ta} — modeller commission ($)`);
    addMonthHeader(sheet, dates, 'Line');
    const commFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      const aiParts = TYPES.map(
        (t) => `${cellAddr(activeRow[t], c)}*${pricing[t].ai}*${pricing[t].sites}/12`,
      ).join('+');
      return { f: `MIN(${commission.rate}*(${aiParts}),${commission.cap})` };
    });
    const modellerCommRow = addDataRow(sheet, 'Modeller commission', commFormulas);

    perTA[ta] = { startsRow, activeRow, activeTotalRow, platformRow, projectRow, pmRow, totalRow, modellerCommRow };
    addBlank(sheet);
  }

  addBlank(sheet);
  addTitle(sheet, 'Aggregates (used by Costs / Budget)');
  addMonthHeader(sheet, dates, 'Line');
  const totalStartsFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    const parts: string[] = [];
    for (const ta of activeTANames) for (const t of TYPES) parts.push(cellAddr(perTA[ta].startsRow[t], c));
    return { f: parts.length ? parts.join('+') : '0' };
  });
  const totalStartsRow = addDataRow(sheet, 'Total client starts', totalStartsFormulas, COUNT, true);
  const totalCommFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    const parts = activeTANames.map((ta) => cellAddr(perTA[ta].modellerCommRow, c));
    return { f: parts.length ? parts.join('+') : '0' };
  });
  const totalModellerCommRow = addDataRow(sheet, 'Total modeller commission', totalCommFormulas, MONEY, true);

  addBlank(sheet, 2);
  addTitle(sheet, 'Yearly revenue summary (modeled)');
  addYearHeader(sheet, yrs.map((y) => y.year), 'Therapeutic Area');
  for (const ta of activeTANames) {
    addDataRow(sheet, ta, yearlyRowFormulas(perTA[ta].totalRow, yrs, months));
  }
  const grandYr: CellSpec[] = [
    ...yrs.map((yr) => ({
      f: activeTANames.map((ta) => `SUM(${rng(perTA[ta].totalRow, yr.startCol, yr.endCol)})`).join('+'),
    } as CellSpec)),
    {
      f: activeTANames
        .map((ta) => `SUM(${rng(perTA[ta].totalRow, MONTH_COL, MONTH_COL + months - 1)})`)
        .join('+'),
    },
  ];
  addDataRow(sheet, 'TOTAL', grandYr, MONEY, true);

  setColumnWidths(sheet, 32, 12, months);
  return { sheet: sheetName, pricing, commission, perTA, totalStartsRow, totalModellerCommRow, activeTANames };
}

// ─────────────────────────────────────────────────────────────────────────────
// Total Revenue
// ─────────────────────────────────────────────────────────────────────────────

interface TRRefs {
  sheet: string;
  hubSpotSubtotalRow: number;
  perTARow: Record<string, number>;
  modeledSubtotalRow: number;
  grandTotalRow: number;
}

function buildTotalRevenue(wb: ExcelJS.Workbook, input: ModelInput, rm: RMRefs): TRRefs {
  const sheetName = 'Total Revenue';
  const sheet = wb.addWorksheet(sheetName);
  const dates = input.dates;
  const months = dates.length;
  const yrs = yearRanges(dates);

  addTitle(sheet, 'Monthly revenue ($)');
  addMonthHeader(sheet, dates, 'Line');

  const hsRows: number[] = [];
  for (const name of Object.keys(input.hubspot.lineItems)) {
    const r = addDataRow(sheet, `HubSpot — ${name}`, input.hubspot.lineItems[name]);
    hsRows.push(r);
  }
  const hsSubFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    return { f: hsRows.length ? hsRows.map((r) => cellAddr(r, c)).join('+') : '0' };
  });
  const hubSpotSubtotalRow = addDataRow(sheet, 'HubSpot pipeline (subtotal)', hsSubFormulas, MONEY, true);

  addBlank(sheet);
  const perTARow: Record<string, number> = {};
  for (const name of rm.activeTANames) {
    const formulas: CellSpec[] = dates.map((_, i) => ({
      f: ext(rm.sheet, cellAddr(rm.perTA[name].totalRow, MONTH_COL + i)),
    }));
    perTARow[name] = addDataRow(sheet, name, formulas);
  }
  const modSubFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    const parts = rm.activeTANames.map((ta) => cellAddr(perTARow[ta], c));
    return { f: parts.length ? parts.join('+') : '0' };
  });
  const modeledSubtotalRow = addDataRow(sheet, 'Modeled TAs (subtotal)', modSubFormulas, MONEY, true);

  addBlank(sheet);
  const grandFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    return { f: `${cellAddr(hubSpotSubtotalRow, c)}+${cellAddr(modeledSubtotalRow, c)}` };
  });
  const grandTotalRow = addDataRow(sheet, 'Grand total (HubSpot + modeled)', grandFormulas, MONEY, true);

  addBlank(sheet, 2);
  addTitle(sheet, 'Yearly revenue summary');
  addYearHeader(sheet, yrs.map((y) => y.year), 'Line');
  addDataRow(sheet, 'HubSpot pipeline', yearlyRowFormulas(hubSpotSubtotalRow, yrs, months));
  for (const name of rm.activeTANames) addDataRow(sheet, name, yearlyRowFormulas(perTARow[name], yrs, months));
  addDataRow(sheet, 'Modeled subtotal', yearlyRowFormulas(modeledSubtotalRow, yrs, months));
  addDataRow(sheet, 'GRAND TOTAL', yearlyRowFormulas(grandTotalRow, yrs, months), MONEY, true);

  setColumnWidths(sheet, 36, 12, months);
  return { sheet: sheetName, hubSpotSubtotalRow, perTARow, modeledSubtotalRow, grandTotalRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Employees
// ─────────────────────────────────────────────────────────────────────────────

interface EmpRefs {
  sheet: string;
  perDeptRow: Record<string, number>;
  totalRow: number;
}

function buildEmployees(wb: ExcelJS.Workbook, input: ModelInput, output: ModelOutput): EmpRefs {
  const sheetName = 'Employees';
  const sheet = wb.addWorksheet(sheetName);
  const dates = input.dates;
  const months = dates.length;
  const yrs = yearRanges(dates);
  const a = input.employeeAssumptions;

  addTitle(sheet, 'Cost assumptions');
  const ah = sheet.addRow(['Parameter', 'Value']);
  ah.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
  const addAssRow = (label: string, value: number, fmt?: string) => {
    const r = sheet.addRow([label, value]);
    if (fmt) r.getCell(2).numFmt = fmt;
    return absAddr(r.number, 2);
  };
  const niRef = addAssRow('NI rate', a.niRate, PCT);
  const pensionRef = addAssRow('Pension rate', a.pensionRate, PCT);
  const rateRef = addAssRow('Annual inflation rate', a.annualInflationRate, PCT);
  addAssRow('Inflation start year', a.inflationStartYear);
  addAssRow('Inflation start month', a.inflationStartMonth);

  const steps: number[] = dates.map((d) => {
    const y = parseInt(d.slice(0, 4), 10);
    const m = parseInt(d.slice(5, 7), 10);
    if (y < a.inflationStartYear) return 0;
    if (y === a.inflationStartYear && m < a.inflationStartMonth) return 0;
    return (y - a.inflationStartYear) + (m >= a.inflationStartMonth ? 1 : 0);
  });

  addBlank(sheet, 2);
  addTitle(sheet, 'Employees — monthly cost');
  const metaHeaders = ['First Name', 'Surname', 'Position', 'Department', 'Location', 'Start', 'Salary'];
  const monthStartCol = metaHeaders.length + 1;
  const empHeader = sheet.addRow([...metaHeaders, ...dates]);
  empHeader.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  metaHeaders.forEach((_, i) => (empHeader.getCell(i + 1).alignment = { horizontal: 'left' }));

  const empListFirstRow = empHeader.number + 1;
  for (const emp of input.employees) {
    const row = sheet.addRow([
      emp.firstName, emp.surname, emp.position, emp.department, emp.location, emp.startDate, emp.salary,
    ]);
    row.getCell(7).numFmt = MONEY;
    const salaryCol = colLetter(7);
    for (let i = 0; i < months; i++) {
      const c = monthStartCol + i;
      const active = emp.startDate === 'Current' ? true : (!!emp.startDate && dates[i] >= emp.startDate);
      const cell = row.getCell(c);
      if (!active) {
        cell.value = 0;
      } else {
        cell.value = {
          formula: `$${salaryCol}${row.number}*(1+${niRef}+${pensionRef})/12*POWER(1+${rateRef},${steps[i]})`,
        };
      }
      cell.numFmt = MONEY;
    }
  }
  const empListLastRow = empListFirstRow + input.employees.length - 1;
  const deptCriteriaRange = `$D$${empListFirstRow}:$D$${empListLastRow}`;

  addBlank(sheet, 2);
  addTitle(sheet, 'Monthly cost by department');
  addMonthHeader(sheet, dates, 'Department');
  const departments = Object.keys(output.employees.perDepartment);
  const perDeptRow: Record<string, number> = {};
  for (const dept of departments) {
    const escaped = dept.replace(/"/g, '""');
    const formulas: CellSpec[] = dates.map((_, i) => {
      const c = monthStartCol + i;
      const sumRange = `${colLetter(c)}$${empListFirstRow}:${colLetter(c)}$${empListLastRow}`;
      return { f: `SUMIF(${deptCriteriaRange},"${escaped}",${sumRange})` };
    });
    perDeptRow[dept] = addDataRow(sheet, dept, formulas);
  }
  const totalFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    const parts = departments.map((d) => cellAddr(perDeptRow[d], c));
    return { f: parts.length ? parts.join('+') : '0' };
  });
  const totalRow = addDataRow(sheet, 'Total employee cost', totalFormulas, MONEY, true);

  addBlank(sheet, 2);
  addTitle(sheet, 'Yearly employee cost');
  addYearHeader(sheet, yrs.map((y) => y.year), 'Department');
  for (const dept of departments) {
    addDataRow(sheet, dept, yearlyRowFormulas(perDeptRow[dept], yrs, months));
  }
  addDataRow(sheet, 'TOTAL', yearlyRowFormulas(totalRow, yrs, months), MONEY, true);

  sheet.getColumn(1).width = 16;
  sheet.getColumn(2).width = 14;
  sheet.getColumn(3).width = 26;
  sheet.getColumn(4).width = 22;
  sheet.getColumn(5).width = 14;
  sheet.getColumn(6).width = 12;
  sheet.getColumn(7).width = 12;
  for (let i = 0; i < months; i++) sheet.getColumn(monthStartCol + i).width = 12;

  return { sheet: sheetName, perDeptRow, totalRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Costs
// ─────────────────────────────────────────────────────────────────────────────

interface CostsRefs {
  sheet: string;
  perDeptTotalRow: Record<CostDept, number>;
}

function buildCosts(
  wb: ExcelJS.Workbook,
  input: ModelInput,
  rm: RMRefs,
  emp: EmpRefs,
  tr: TRRefs,
): CostsRefs {
  const sheetName = 'Costs';
  const sheet = wb.addWorksheet(sheetName);
  const dates = input.dates;
  const months = dates.length;

  addTitle(sheet, 'Departmental cost detail');
  addBlank(sheet);

  const perDeptTotalRow = {} as Record<CostDept, number>;

  for (const dept of input.costs.depts) {
    addSubtitle(sheet, dept);
    addMonthHeader(sheet, dates, 'Line');

    const empDeptKey = Object.keys(input.costs.deptToTab).find(
      (k) => input.costs.deptToTab[k] === dept,
    );
    const empDeptRow = empDeptKey ? emp.perDeptRow[empDeptKey] : null;
    const staffFormulas: CellSpec[] = dates.map((_, i) => {
      if (!empDeptRow) return 0;
      const c = MONTH_COL + i;
      return { f: ext(emp.sheet, cellAddr(empDeptRow, c)) };
    });
    const staffRow = addDataRow(sheet, 'Staff Costs', staffFormulas);

    const derivedRows: number[] = [];
    if (dept === 'Sales and Marketing') {
      const salesPerClient = ext(rm.sheet, rm.commission.salesPerClient);
      const salesInvoiceRate = ext(rm.sheet, rm.commission.salesInvoiceRate);
      const formulas: CellSpec[] = dates.map((_, i) => {
        const c = MONTH_COL + i;
        return {
          f:
            `${salesPerClient}*${ext(rm.sheet, cellAddr(rm.totalStartsRow, c))}` +
            `+${salesInvoiceRate}*${ext(tr.sheet, cellAddr(tr.grandTotalRow, c))}`,
        };
      });
      derivedRows.push(addDataRow(sheet, 'Sales Commission (modeled)', formulas));
    }

    const lineItems = input.costs.lineItems[dept] || {};
    const itemRows: number[] = [];
    for (const name of Object.keys(lineItems)) {
      if (dept === 'Sales and Marketing' && name === 'Commission') continue;
      itemRows.push(addDataRow(sheet, name, lineItems[name]));
    }

    const totalFormulas: CellSpec[] = dates.map((_, i) => {
      const c = MONTH_COL + i;
      const parts = [
        cellAddr(staffRow, c),
        ...derivedRows.map((r) => cellAddr(r, c)),
        ...itemRows.map((r) => cellAddr(r, c)),
      ];
      return { f: parts.join('+') };
    });
    perDeptTotalRow[dept] = addDataRow(sheet, 'Total', totalFormulas, MONEY, true);
    addBlank(sheet, 2);
  }

  setColumnWidths(sheet, 32, 12, months);
  return { sheet: sheetName, perDeptTotalRow };
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget P&L
// ─────────────────────────────────────────────────────────────────────────────

function buildBudget(
  wb: ExcelJS.Workbook,
  input: ModelInput,
  rm: RMRefs,
  tr: TRRefs,
  costs: CostsRefs,
) {
  const sheetName = 'Budget P&L';
  const sheet = wb.addWorksheet(sheetName);
  const dates = input.dates;
  const months = dates.length;
  const yrs = yearRanges(dates);

  addTitle(sheet, 'Monthly P&L');
  addMonthHeader(sheet, dates, 'Line');

  const revFormulas: CellSpec[] = dates.map((_, i) => ({
    f: ext(tr.sheet, cellAddr(tr.grandTotalRow, MONTH_COL + i)),
  }));
  const revRow = addDataRow(sheet, 'Revenue (HubSpot + modeled)', revFormulas);

  const commFormulas: CellSpec[] = dates.map((_, i) => ({
    f: `-${ext(rm.sheet, cellAddr(rm.totalModellerCommRow, MONTH_COL + i))}`,
  }));
  const commRow = addDataRow(sheet, 'Modeller Commission', commFormulas);

  const deprArr = input.costs.costOfSales.depreciation.map((v) => -v);
  const deprRow = addDataRow(sheet, 'Capital Depreciation', deprArr);

  const gpFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    return { f: `${cellAddr(revRow, c)}+${cellAddr(commRow, c)}+${cellAddr(deprRow, c)}` };
  });
  const gpRow = addDataRow(sheet, 'Gross Profit', gpFormulas, MONEY, true);

  const deptRows = {} as Record<CostDept, number>;
  for (const dept of input.costs.depts) {
    const formulas: CellSpec[] = dates.map((_, i) => ({
      f: `-${ext(costs.sheet, cellAddr(costs.perDeptTotalRow[dept], MONTH_COL + i))}`,
    }));
    deptRows[dept] = addDataRow(sheet, dept, formulas);
  }
  const opexFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    return { f: input.costs.depts.map((d) => cellAddr(deptRows[d], c)).join('+') };
  });
  const opexRow = addDataRow(sheet, 'Total Opex', opexFormulas, MONEY, true);

  const ebitdaFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    return { f: `${cellAddr(gpRow, c)}+${cellAddr(opexRow, c)}` };
  });
  const ebitdaRow = addDataRow(sheet, 'EBITDA', ebitdaFormulas, MONEY, true);

  addBlank(sheet, 2);
  addTitle(sheet, 'Yearly P&L');
  addYearHeader(sheet, yrs.map((y) => y.year), 'Line');

  addDataRow(sheet, 'Revenue', yearlyRowFormulas(revRow, yrs, months));
  const cosFormulas: CellSpec[] = [
    ...yrs.map(
      (yr) =>
        ({
          f: `SUM(${rng(commRow, yr.startCol, yr.endCol)})+SUM(${rng(deprRow, yr.startCol, yr.endCol)})`,
        } as CellSpec),
    ),
    {
      f:
        `SUM(${rng(commRow, MONTH_COL, MONTH_COL + months - 1)})` +
        `+SUM(${rng(deprRow, MONTH_COL, MONTH_COL + months - 1)})`,
    },
  ];
  addDataRow(sheet, 'Cost of Sales', cosFormulas);
  addDataRow(sheet, 'Gross Profit', yearlyRowFormulas(gpRow, yrs, months), MONEY, true);
  for (const dept of input.costs.depts) addDataRow(sheet, dept, yearlyRowFormulas(deptRows[dept], yrs, months));
  addDataRow(sheet, 'Total Opex', yearlyRowFormulas(opexRow, yrs, months), MONEY, true);
  addDataRow(sheet, 'EBITDA', yearlyRowFormulas(ebitdaRow, yrs, months), MONEY, true);

  setColumnWidths(sheet, 32, 12, months);
}

// ─────────────────────────────────────────────────────────────────────────────

function buildHubSpotPipeline(wb: ExcelJS.Workbook, input: ModelInput) {
  const sheet = wb.addWorksheet('HubSpot Pipeline');
  const dates = input.dates;
  const months = dates.length;
  const yrs = yearRanges(dates);
  const names = Object.keys(input.hubspot.lineItems).sort();

  // ─── Annual summary by high-level type ───
  addTitle(sheet, 'Annual summary by revenue type');
  const summary = annualSummaryByType(input.hubspot, dates);
  const yearHeaderRow = sheet.addRow(['Revenue type', ...summary.years.map(String), '6-yr Total']);
  yearHeaderRow.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  yearHeaderRow.getCell(1).alignment = { horizontal: 'left' };
  for (const t of summary.types) {
    const yearVals = summary.years.map((y) => summary.data[t]?.[y] || 0);
    const total = yearVals.reduce((a, b) => a + b, 0);
    const r = sheet.addRow([t, ...yearVals, total]);
    for (let c = 2; c <= summary.years.length + 2; c++) r.getCell(c).numFmt = MONEY;
  }
  const totalsRow = sheet.addRow([
    'TOTAL',
    ...summary.years.map((y) => summary.types.reduce((s, t) => s + (summary.data[t]?.[y] || 0), 0)),
    summary.types.reduce(
      (s, t) => s + summary.years.reduce((s2, y) => s2 + (summary.data[t]?.[y] || 0), 0),
      0,
    ),
  ]);
  totalsRow.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
  for (let c = 2; c <= summary.years.length + 2; c++) totalsRow.getCell(c).numFmt = MONEY;

  addBlank(sheet, 2);
  addTitle(sheet, 'HubSpot pipeline by line item × month');
  addMonthHeader(sheet, dates, 'Line item');
  const lineRows: Record<string, number> = {};
  for (const name of names) {
    lineRows[name] = addDataRow(sheet, name, input.hubspot.lineItems[name]);
  }
  const totalFormulas: CellSpec[] = dates.map((_, i) => {
    const c = MONTH_COL + i;
    const parts = names.map((n) => cellAddr(lineRows[n], c));
    return { f: parts.length ? parts.join('+') : '0' };
  });
  const totalRow = addDataRow(sheet, 'Total', totalFormulas, MONEY, true);

  addBlank(sheet, 2);
  addTitle(sheet, 'Yearly pipeline');
  addYearHeader(sheet, yrs.map((y) => y.year), 'Line item');
  for (const name of names) {
    addDataRow(sheet, name, yearlyRowFormulas(lineRows[name], yrs, months));
  }
  addDataRow(sheet, 'TOTAL', yearlyRowFormulas(totalRow, yrs, months), MONEY, true);

  setColumnWidths(sheet, 50, 12, months);
}

function buildHubSpotDeals(wb: ExcelJS.Workbook, deals: PerDealSummary[]) {
  const sheet = wb.addWorksheet('HubSpot Deals');

  // ─── Total contract value over time ───
  addTitle(sheet, 'Total contract value over time (snapshot at start of each month)');
  const history = contractValueHistory(deals);
  const histHeader = sheet.addRow(['Month start', 'Live deals', 'Total CV']);
  histHeader.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  for (const row of history) {
    const r = sheet.addRow([row.monthStart, row.liveCount, row.totalCV]);
    r.getCell(3).numFmt = MONEY;
  }
  addBlank(sheet, 2);

  // ─── Current pipeline by close quarter × type (raw amounts, open deals only) ───
  const renderPivot = (title: string, hint: string, p: ReturnType<typeof quarterlyPivot>) => {
    addTitle(sheet, title);
    const hintRow = sheet.addRow([hint]);
    hintRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
    const header = sheet.addRow(['Quarter', ...p.types, 'Row total']);
    header.eachCell({ includeEmpty: false }, (c) => {
      c.font = { bold: true };
      c.alignment = { horizontal: 'center' };
    });
    header.getCell(1).alignment = { horizontal: 'left' };
    for (const q of p.quarters) {
      const vals = p.types.map((t) => p.data[q]?.[t] || 0);
      const r = sheet.addRow([q, ...vals, p.rowTotals[q]]);
      for (let c = 2; c <= p.types.length + 2; c++) r.getCell(c).numFmt = MONEY;
    }
    if (p.quarters.length > 0) {
      const tot = sheet.addRow(['TOTAL', ...p.types.map((t) => p.colTotals[t] || 0), p.grandTotal]);
      tot.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
      for (let c = 2; c <= p.types.length + 2; c++) tot.getCell(c).numFmt = MONEY;
    }
    addBlank(sheet, 2);
  };

  renderPivot(
    'Current pipeline by close quarter × revenue type',
    'Open deals only (stage not Closed Won/Lost), raw line-item amounts (unit × quantity), bucketed by predicted close quarter.',
    quarterlyPivot(deals, { weighted: false, openOnly: true }),
  );

  renderPivot(
    'Estimated closed pipeline by close quarter × revenue type',
    'All deals × close probability — Closed Won contributes at 100%, Closed Lost excluded.',
    quarterlyPivot(deals, { weighted: true, openOnly: false }),
  );

  // ─── Deals list ───
  addTitle(sheet, 'Deals');
  const headers = [
    'Deal Name', 'Pipeline', 'Stage', 'Amount', 'Close probability',
    'Expected amount', 'Close (HubSpot)', 'Close (predicted)', 'Duration (months)',
    'Status', 'Skip reason',
  ];
  const h = sheet.addRow(headers);
  const headerRowNumber = h.number;
  h.eachCell({ includeEmpty: false }, (c) => {
    c.font = { bold: true };
    c.alignment = { horizontal: 'center' };
  });
  for (const d of deals) {
    const r = sheet.addRow([
      d.name,
      d.pipelineLabel,
      d.stageLabel,
      d.amountReported,
      d.closeProbability,
      d.expectedAmount,
      d.closeDateHubSpot ?? '',
      d.closeDatePredicted ?? '',
      d.durationMonths,
      d.status,
      d.skipReason ?? '',
    ]);
    r.getCell(4).numFmt = MONEY;
    r.getCell(5).numFmt = PCT;
    r.getCell(6).numFmt = MONEY;
  }
  // Totals row
  const firstDealRow = headerRowNumber + 1;
  const lastDataRow = sheet.rowCount;
  const tot = sheet.addRow([
    'TOTAL', '', '',
    { formula: `SUM(D${firstDealRow}:D${lastDataRow})` }, '',
    { formula: `SUM(F${firstDealRow}:F${lastDataRow})` }, '', '', '', '', '',
  ]);
  tot.eachCell({ includeEmpty: false }, (c) => (c.font = { bold: true }));
  tot.getCell(4).numFmt = MONEY;
  tot.getCell(6).numFmt = MONEY;

  sheet.getColumn(1).width = 56;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 26;
  sheet.getColumn(4).width = 14;
  sheet.getColumn(5).width = 14;
  sheet.getColumn(6).width = 16;
  sheet.getColumn(7).width = 14;
  sheet.getColumn(8).width = 16;
  sheet.getColumn(9).width = 12;
  sheet.getColumn(10).width = 10;
  sheet.getColumn(11).width = 28;
}

export async function downloadModelAsExcel(
  input: ModelInput,
  output: ModelOutput,
  hubspotDeals?: PerDealSummary[],
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bitfount Sales Model';
  wb.created = new Date();

  const rm = buildRevenueModel(wb, input, output);
  const tr = buildTotalRevenue(wb, input, rm);
  const emp = buildEmployees(wb, input, output);
  const costs = buildCosts(wb, input, rm, emp, tr);
  buildBudget(wb, input, rm, tr, costs);
  buildHubSpotPipeline(wb, input);
  if (hubspotDeals && hubspotDeals.length) buildHubSpotDeals(wb, hubspotDeals);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `bitfount-sales-model-${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
