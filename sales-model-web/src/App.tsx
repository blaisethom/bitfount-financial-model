import { useMemo, useState } from 'react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './App.css';
import { computeModel } from './model';
import { loadInitialInput } from './data';
import type {
  ModelInput,
  TrialType,
  EmployeeAssumptions,
  CostDept,
  CommissionAssumptions,
} from './types';
import PricingGrid from './components/PricingGrid';
import MonthlyGrid from './components/MonthlyGrid';
import YearlySummary from './components/YearlySummary';
import EmployeeList from './components/EmployeeList';
import EmployeeAssumptionsGrid from './components/EmployeeAssumptionsGrid';
import CommissionGrid from './components/CommissionGrid';
import { useUndoable } from './useUndoable';
import {
  ROW_TOOLTIPS,
  activeTypeCellTooltip,
  activeTotalCellTooltip,
  platformCellTooltip,
  projectCellTooltip,
  pmCellTooltip,
  totalRevCellTooltip,
  HUBSPOT_ROW_TOOLTIP,
  TA_TOTAL_ROW_TOOLTIP,
  GRAND_TOTAL_ROW_TOOLTIP,
  hubspotLineCellTooltip,
  hubspotSubtotalCellTooltip,
  taTotalCellTooltip,
  modeledSubtotalCellTooltip,
  grandTotalCellTooltip,
  EMPLOYEE_DEPT_ROW_TOOLTIP,
  EMPLOYEE_TOTAL_ROW_TOOLTIP,
  employeeDeptCellTooltip,
  employeeTotalCellTooltip,
} from './tooltips';
import type { MonthlyRow } from './components/MonthlyGrid';

ModuleRegistry.registerModules([AllCommunityModule]);

const TYPE_LABEL: Record<TrialType, string> = {
  A: 'Type A (Small)',
  B: 'Type B (Medium)',
  C: 'Type C (Large)',
};

type View = 'model' | 'total' | 'employees' | 'costs' | 'budget';

export default function App() {
  const {
    state: input,
    set: setInput,
    reset: setReset,
    undo,
    redo,
    canUndo,
    canRedo,
    historyDepth,
  } = useUndoable<ModelInput>(loadInitialInput());
  const [view, setView] = useState<View>('total');
  const [activeTA, setActiveTA] = useState<string>('Ophthalmology');

  const output = useMemo(() => computeModel(input), [input]);

  const updatePricing = (next: ModelInput['pricing']) =>
    setInput((prev) => ({ ...prev, pricing: next }));

  const updateStart = (rowKey: string, monthIdx: number, value: number) => {
    const t = rowKey as TrialType;
    setInput((prev) => {
      const next = { ...prev, schedule: { ...prev.schedule } };
      const cur = prev.schedule[activeTA];
      const updated = { A: [...cur.A], B: [...cur.B], C: [...cur.C] };
      updated[t][monthIdx] = value;
      next.schedule[activeTA] = updated;
      return next;
    });
  };

  const updateEmployee = (
    id: string,
    field: 'salary' | 'startDate' | 'department' | 'position',
    value: string | number,
  ) => {
    setInput((prev) => {
      const idx = prev.employees.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const employees = [...prev.employees];
      const cur = employees[idx];
      if (field === 'salary') {
        const v = typeof value === 'string' ? parseFloat(value) : value;
        if (Number.isNaN(v)) return prev;
        employees[idx] = { ...cur, salary: v };
      } else if (field === 'startDate') {
        employees[idx] = { ...cur, startDate: String(value) };
      } else {
        employees[idx] = { ...cur, [field]: String(value) };
      }
      return { ...prev, employees };
    });
  };

  const updateEmployeeAssumptions = (next: EmployeeAssumptions) =>
    setInput((prev) => ({ ...prev, employeeAssumptions: next }));

  const updateCommission = (next: CommissionAssumptions) =>
    setInput((prev) => ({ ...prev, commission: next }));

  const updateCostLine = (dept: CostDept, lineName: string, monthIdx: number, value: number) => {
    setInput((prev) => {
      const items = prev.costs.lineItems[dept];
      if (!items?.[lineName]) return prev;
      const updated = [...items[lineName]];
      updated[monthIdx] = value;
      return {
        ...prev,
        costs: {
          ...prev.costs,
          lineItems: {
            ...prev.costs.lineItems,
            [dept]: { ...items, [lineName]: updated },
          },
        },
      };
    });
  };

  const updateHubSpot = (rowKey: string, monthIdx: number, value: number) => {
    if (!rowKey.startsWith('hs_')) return;
    const lineName = rowKey.slice(3);
    setInput((prev) => {
      if (!prev.hubspot.lineItems[lineName]) return prev;
      const lineItems = { ...prev.hubspot.lineItems };
      lineItems[lineName] = [...lineItems[lineName]];
      lineItems[lineName][monthIdx] = value;
      const grandTotal = new Array(prev.dates.length).fill(0);
      for (const vs of Object.values(lineItems)) {
        for (let i = 0; i < grandTotal.length; i++) grandTotal[i] += vs[i];
      }
      return { ...prev, hubspot: { lineItems, grandTotal } };
    });
  };

  const reset = () => setReset(loadInitialInput());

  const ta = output.perTA[activeTA];
  const taTotal6y = ta.total.reduce((a, b) => a + b, 0);
  const modeledTotal = output.totals.total.reduce((a, b) => a + b, 0);
  const hubspotTotal = input.hubspot.grandTotal.reduce((a, b) => a + b, 0);
  const grandTotal = modeledTotal + hubspotTotal;
  const employeeTotal = output.employees.total.reduce((a, b) => a + b, 0);
  const opexTotal = output.budget.totalOpex.reduce((a, b) => a + b, 0);
  const ebitdaTotal = output.budget.ebitda.reduce((a, b) => a + b, 0);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Bitfount Sales Model</h1>
        <div className="header-stats">
          <div className="stat">
            <div className="stat-label">6-year revenue (HubSpot + modeled)</div>
            <div className="stat-value">${Math.round(grandTotal).toLocaleString()}</div>
            <div className="stat-sub">
              ${Math.round(modeledTotal).toLocaleString()} modeled · ${Math.round(hubspotTotal).toLocaleString()} HubSpot
            </div>
          </div>
          <div className="undo-group">
            <button
              onClick={undo}
              disabled={!canUndo}
              className="btn icon-btn"
              title={`Undo (${navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'}) — ${historyDepth} change${historyDepth === 1 ? '' : 's'} back`}
              aria-label="Undo"
            >
              ↶
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              className="btn icon-btn"
              title={`Redo (${navigator.platform.includes('Mac') ? '⇧⌘Z' : 'Ctrl+Shift+Z'})`}
              aria-label="Redo"
            >
              ↷
            </button>
          </div>
          <button onClick={reset} className="btn">Reset to Excel defaults</button>
        </div>
      </header>

      <div className="view-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={view === 'model'}
          className={`view-tab ${view === 'model' ? 'active' : ''}`}
          onClick={() => setView('model')}
        >
          Revenue Model auto
          <span className="view-tab-sub">${(modeledTotal / 1e6).toFixed(1)}M modeled</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'total'}
          className={`view-tab ${view === 'total' ? 'active' : ''}`}
          onClick={() => setView('total')}
        >
          Total Revenue
          <span className="view-tab-sub">${(grandTotal / 1e6).toFixed(1)}M with HubSpot</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'employees'}
          className={`view-tab ${view === 'employees' ? 'active' : ''}`}
          onClick={() => setView('employees')}
        >
          Employees
          <span className="view-tab-sub">${(employeeTotal / 1e6).toFixed(1)}M cost · {input.employees.length} people</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'costs'}
          className={`view-tab ${view === 'costs' ? 'active' : ''}`}
          onClick={() => setView('costs')}
        >
          Costs
          <span className="view-tab-sub">${(opexTotal / 1e6).toFixed(1)}M total opex</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'budget'}
          className={`view-tab ${view === 'budget' ? 'active' : ''}`}
          onClick={() => setView('budget')}
        >
          Budget P&amp;L
          <span className="view-tab-sub">EBITDA ${(ebitdaTotal / 1e6).toFixed(1)}M · 6yr</span>
        </button>
      </div>

      {view === 'model' ? (
        <ModelView
          input={input}
          output={output}
          activeTA={activeTA}
          setActiveTA={setActiveTA}
          ta={ta}
          taTotal6y={taTotal6y}
          updateStart={updateStart}
          updatePricing={updatePricing}
          updateCommission={updateCommission}
        />
      ) : view === 'total' ? (
        <TotalView input={input} output={output} updateHubSpot={updateHubSpot} />
      ) : view === 'employees' ? (
        <EmployeesView
          input={input}
          output={output}
          updateEmployee={updateEmployee}
          updateAssumptions={updateEmployeeAssumptions}
        />
      ) : view === 'costs' ? (
        <CostsView input={input} output={output} updateCostLine={updateCostLine} />
      ) : (
        <BudgetView input={input} output={output} />
      )}

      <footer className="app-footer">
        <p>
          Modeled from <code>5-year-plan.xlsx</code>. <strong>Revenue Model auto</strong> reproduces the spreadsheet's
          per-TA totals exactly. <strong>HubSpot</strong> pipeline values come from the HubSpot Pivot tab and are editable
          here (only spans Jan 2026 – Dec 2030). <strong>Employees</strong>: 48 people, 5% inflation each April starting
          Apr 2027, compounded uniformly — the spreadsheet's Employees tab has formula bugs that omit inflation for
          future-start hires and skip the Apr 2031 step, so this engine reads ~$9M higher over 6 years ($40.1M vs
          $30.8M). Modeller commission and sales commission are <strong>derived from formulas</strong>, not the
          spreadsheet's static rows: modeller comm = <code>min(80% × AI revenue, $30k cap)</code> per TA per month,
          sales comm = <code>$6k × new clients + 12% × invoiced revenue</code>. Both rates and the cap are editable on
          the Revenue Model auto tab. The 12% formula matches the spreadsheet's first four months exactly ($960 = 12% ×
          $8k HubSpot in Jan/Feb 2026); later months in Excel drift from 12% due to hand-edited overrides which this
          engine ignores.
        </p>
      </footer>
    </div>
  );
}

interface ModelViewProps {
  input: ModelInput;
  output: ReturnType<typeof computeModel>;
  activeTA: string;
  setActiveTA: (s: string) => void;
  ta: NonNullable<ReturnType<typeof computeModel>['perTA'][string]>;
  taTotal6y: number;
  updateStart: (rowKey: string, monthIdx: number, value: number) => void;
  updatePricing: (next: ModelInput['pricing']) => void;
  updateCommission: (next: CommissionAssumptions) => void;
}

function ModelView({
  input,
  output,
  activeTA,
  setActiveTA,
  ta,
  taTotal6y,
  updateStart,
  updatePricing,
  updateCommission,
}: ModelViewProps) {
  return (
    <>
      <section>
        <h2>Pricing assumptions</h2>
        <p className="hint">
          Editable. Platform license per trial per year is derived: (Bitfount + AI license) × sites.
          All projects last 12 months from start.
        </p>
        <PricingGrid pricing={input.pricing} onChange={updatePricing} />

        <h3>Commission assumptions</h3>
        <p className="hint">
          Modeller commission (Cost of Sales) <code>= min(rate × Σ active × ai_license × sites / 12, cap)</code> per TA per month.
          Sales commission (S&amp;M opex) <code>= per_client × Σ new starts + invoice_rate × revenue</code>.
        </p>
        <div className="commission-grid">
          <CommissionGrid commission={input.commission} onChange={updateCommission} />
        </div>
      </section>

      <section>
        <h2>Yearly revenue summary <span className="hint">(modeled only)</span></h2>
        <YearlySummary output={output} taNames={input.taNames} variant="modeled" />
      </section>

      <section>
        <h2>Per-therapeutic-area detail</h2>
        <div className="ta-tabs">
          {input.taNames.map((name) => {
            const active = output.yearly.perTA[name].total.some((v) => v > 0);
            return (
              <button
                key={name}
                onClick={() => setActiveTA(name)}
                className={`tab ${name === activeTA ? 'active' : ''} ${active ? '' : 'empty'}`}
              >
                {name}
                {active && (
                  <span className="tab-total">
                    ${(output.yearly.perTA[name].total.reduce((a, b) => a + b, 0) / 1e6).toFixed(1)}M
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="ta-content">
          <div className="ta-summary">
            <span className="ta-name">{activeTA}</span>
            <span className="ta-total">6-yr total: ${Math.round(taTotal6y).toLocaleString()}</span>
          </div>

          <h3>Client starts per month <span className="hint">(editable)</span></h3>
          <MonthlyGrid
            dates={input.dates}
            editable
            onCellEdit={updateStart}
            format="count"
            rows={(['A', 'B', 'C'] as TrialType[]).map((t) => ({
              metric: TYPE_LABEL[t],
              rowKey: t,
              type: t,
              values: input.schedule[activeTA][t],
            }))}
            height={140}
          />

          <h3>
            Active trials per month{' '}
            <span className="hint">
              (derived: 12-month duration — hover any cell or row label for the formula)
            </span>
          </h3>
          <MonthlyGrid
            dates={input.dates}
            format="count"
            rows={[
              ...(['A', 'B', 'C'] as TrialType[]).map((t) => ({
                metric: TYPE_LABEL[t],
                rowKey: `active_${t}`,
                type: t,
                values: ta.byType[t].active,
                rowTooltip: ROW_TOOLTIPS.activeType(t),
                cellTooltip: (i: number, v: number) =>
                  activeTypeCellTooltip(t, i, input.dates, input.schedule[activeTA][t], v),
              })),
              {
                metric: 'Total active',
                rowKey: 'active_total',
                isTotal: true,
                values: ta.byType.A.active.map(
                  (_, i) => ta.byType.A.active[i] + ta.byType.B.active[i] + ta.byType.C.active[i],
                ),
                rowTooltip: ROW_TOOLTIPS.activeTotal,
                cellTooltip: (i: number) => activeTotalCellTooltip(i, input.dates, ta),
              },
            ]}
            height={170}
          />

          <h3>
            Monthly revenue ($){' '}
            <span className="hint">(hover any cell or row label for the formula)</span>
          </h3>
          <MonthlyGrid
            dates={input.dates}
            rows={[
              {
                metric: 'Platform revenue',
                rowKey: 'platform',
                values: ta.platform,
                rowTooltip: ROW_TOOLTIPS.platform,
                cellTooltip: (i: number) => platformCellTooltip(i, input.dates, ta, input),
              },
              {
                metric: 'Project revenue',
                rowKey: 'project',
                values: ta.project,
                rowTooltip: ROW_TOOLTIPS.project,
                cellTooltip: (i: number) => projectCellTooltip(i, input.dates, ta, input, activeTA),
              },
              {
                metric: 'PM fee revenue',
                rowKey: 'pm',
                values: ta.pm,
                rowTooltip: ROW_TOOLTIPS.pm,
                cellTooltip: (i: number) => pmCellTooltip(i, input.dates, ta, input),
              },
              {
                metric: 'Total',
                rowKey: 'total',
                isTotal: true,
                values: ta.total,
                rowTooltip: ROW_TOOLTIPS.totalRev,
                cellTooltip: (i: number) => totalRevCellTooltip(i, input.dates, ta),
              },
            ]}
            height={170}
          />
        </div>
      </section>
    </>
  );
}

interface EmployeesViewProps {
  input: ModelInput;
  output: ReturnType<typeof computeModel>;
  updateEmployee: (id: string, field: 'salary' | 'startDate' | 'department' | 'position', value: string | number) => void;
  updateAssumptions: (next: EmployeeAssumptions) => void;
}

function EmployeesView({ input, output, updateEmployee, updateAssumptions }: EmployeesViewProps) {
  const empOut = output.employees;
  const departments = Object.keys(empOut.perDepartment);
  const total6y = empOut.total.reduce((a, b) => a + b, 0);
  const yearlyTotals = empOut.yearly.total;

  const monthlyRows: MonthlyRow[] = [];
  for (const dept of departments) {
    monthlyRows.push({
      metric: dept,
      rowKey: `dept_${dept}`,
      values: empOut.perDepartment[dept],
      rowTooltip: EMPLOYEE_DEPT_ROW_TOOLTIP,
      cellTooltip: (i) => employeeDeptCellTooltip(dept, i, input.dates, empOut.perEmployee, input.employees),
    });
  }
  monthlyRows.push({
    metric: 'Total employee cost',
    rowKey: 'emp_total',
    isTotal: true,
    values: empOut.total,
    rowTooltip: EMPLOYEE_TOTAL_ROW_TOOLTIP,
    cellTooltip: (i) => employeeTotalCellTooltip(i, input.dates, empOut.perDepartment),
  });

  return (
    <>
      <section>
        <h2>Cost assumptions</h2>
        <p className="hint">
          Loaded salary = base salary × (1 + NI + pension). Annual inflation compounds each April starting at the
          configured year/month — applied uniformly to every active employee.
        </p>
        <div className="employee-assumptions">
          <EmployeeAssumptionsGrid assumptions={input.employeeAssumptions} onChange={updateAssumptions} />
        </div>
      </section>

      <section>
        <h2>Yearly employee cost</h2>
        <div className="yearly-emp">
          <table className="yearly-emp-table">
            <thead>
              <tr>
                <th>Department</th>
                {output.years.map((y) => <th key={y}>{y}</th>)}
                <th>6-yr Total</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => {
                const arr = empOut.yearly.perDepartment[d];
                const total = arr.reduce((a, b) => a + b, 0);
                return (
                  <tr key={d}>
                    <td>{d}</td>
                    {arr.map((v, i) => <td key={i}>{money(v)}</td>)}
                    <td className="bold">{money(total)}</td>
                  </tr>
                );
              })}
              <tr className="total-row">
                <td>TOTAL</td>
                {yearlyTotals.map((v, i) => <td key={i}>{money(v)}</td>)}
                <td className="bold">{money(total6y)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Monthly cost by department <span className="hint">(hover any cell or row for the formula)</span></h2>
        <MonthlyGrid
          dates={input.dates}
          rows={monthlyRows}
          height={28 + 30 * (monthlyRows.length + 1)}
        />
      </section>

      <section>
        <h2>Employees <span className="hint">({input.employees.length} people — Salary, Position, Dept, Start are editable)</span></h2>
        <EmployeeList
          employees={input.employees}
          assumptions={input.employeeAssumptions}
          onChange={updateEmployee}
        />
      </section>
    </>
  );
}

function money(v: number): string {
  if (!v) return '';
  return '$' + Math.round(v).toLocaleString();
}

interface CostsViewProps {
  input: ModelInput;
  output: ReturnType<typeof computeModel>;
  updateCostLine: (dept: CostDept, lineName: string, monthIdx: number, value: number) => void;
}

function CostsView({ input, output, updateCostLine }: CostsViewProps) {
  const [activeDept, setActiveDept] = useState<CostDept>('Sales and Marketing');
  const dept = activeDept;
  const deptOut = output.budget.perDept[dept];
  const lineItems = input.costs.lineItems[dept];
  // Skip the static Commission line for S&M — it's replaced by the derived row.
  const itemNames = Object.keys(lineItems).filter(
    (n) => !(dept === 'Sales and Marketing' && n === 'Commission'),
  );
  const derivedNames = Object.keys(deptOut.derived);

  const rows: MonthlyRow[] = [];
  rows.push({
    metric: 'Staff Costs',
    rowKey: 'staff',
    values: deptOut.staff,
    rowTooltip:
      'Staff Costs row pulls directly from the Employees tab — sum of every active employee in this department for the month, with annual inflation applied.',
    cellTooltip: (i) =>
      `${dept} staff cost — ${input.dates[i]}:\n${money(deptOut.staff[i])}\n\nDerived from the Employees tab. Edit individual salaries or start dates there.`,
  });
  for (const name of derivedNames) {
    const arr = deptOut.derived[name];
    rows.push({
      metric: name,
      rowKey: `derived_${name}`,
      values: arr,
      // editable explicitly false — derived row.
      editable: false,
      rowTooltip:
        [
          `${name}:`,
          'Derived; not directly editable. Adjust the parameters in the AI Modeller commission / Sales commission config table on the Revenue Model auto tab.',
          '',
          'formula:\nsales_comm(m) = $/client × Σ_TA Σ_t starts_t(m) + invoice_rate × revenue(m)',
          `current: $${input.commission.salesPerClient.toLocaleString()} per client + ${(input.commission.salesInvoiceRate * 100).toFixed(1)}% × revenue`,
        ].join('\n'),
      cellTooltip: (i) => {
        let starts = 0;
        for (const ta of input.taNames) {
          const s = input.schedule[ta];
          starts += (s.A[i] || 0) + (s.B[i] || 0) + (s.C[i] || 0);
        }
        const perClientPart = input.commission.salesPerClient * starts;
        const invoicePart = input.commission.salesInvoiceRate * output.budget.revenue[i];
        return [
          `${name} — ${input.dates[i]}:`,
          `total = ${money(arr[i])}`,
          '',
          'this cell:',
          `  ${money(perClientPart)}  ($${input.commission.salesPerClient.toLocaleString()} × ${starts} new clients)`,
          `  ${money(invoicePart)}  (${(input.commission.salesInvoiceRate * 100).toFixed(1)}% × ${money(output.budget.revenue[i])} revenue)`,
          '  ─────',
          `  total = ${money(arr[i])}`,
        ].join('\n');
      },
    });
  }
  for (const name of itemNames) {
    rows.push({
      metric: name,
      rowKey: `line_${name}`,
      values: lineItems[name],
      editable: true,
      rowTooltip:
        `${name}: editable monthly cost in the ${dept} budget. Imported from the spreadsheet's Budget section; change any cell to model an alternative.`,
    });
  }
  rows.push({
    metric: 'Total',
    rowKey: 'total',
    isTotal: true,
    values: deptOut.total,
    rowTooltip:
      [
        'Department total monthly cost:',
        '',
        'formula:\ntotal(m) = staff(m) + Σ derived(m) + Σ_line non-staff line items(m)',
      ].join('\n'),
    cellTooltip: (i) => {
      const lines: string[] = [
        `${dept} total — ${input.dates[i]}:`,
        `total = ${money(deptOut.total[i])}`,
        '',
        'this cell:',
        `  ${money(deptOut.staff[i])}  (Staff Costs)`,
      ];
      for (const name of derivedNames) {
        const v = deptOut.derived[name][i];
        if (v === 0) continue;
        lines.push(`  ${money(v)}  (${name})`);
      }
      for (const name of itemNames) {
        const v = lineItems[name][i];
        if (v === 0) continue;
        lines.push(`  ${money(v)}  (${name})`);
      }
      lines.push('  ─────', `  total = ${money(deptOut.total[i])}`);
      return lines.join('\n');
    },
  });

  return (
    <>
      <section>
        <h2>Departmental cost detail</h2>
        <p className="hint">
          Each department's total cost = Staff Costs (derived from the Employees tab) + the editable line
          items below. Yellow cells are editable; the Staff Costs row is read-only.
        </p>
        <div className="ta-tabs">
          {input.costs.depts.map((d) => {
            const t = output.budget.perDept[d].total.reduce((a, b) => a + b, 0);
            return (
              <button
                key={d}
                onClick={() => setActiveDept(d)}
                className={`tab ${d === activeDept ? 'active' : ''}`}
              >
                {d}
                <span className="tab-total">${(t / 1e6).toFixed(1)}M</span>
              </button>
            );
          })}
        </div>

        <div className="ta-content">
          <div className="ta-summary">
            <span className="ta-name">{dept}</span>
            <span className="ta-total">
              6-yr total: ${Math.round(deptOut.total.reduce((a, b) => a + b, 0)).toLocaleString()}{' '}
              <span className="hint">
                (= ${Math.round(deptOut.staff.reduce((a, b) => a + b, 0)).toLocaleString()} staff +{' '}
                ${Math.round(deptOut.nonStaff.reduce((a, b) => a + b, 0)).toLocaleString()} other)
              </span>
            </span>
          </div>

          <h3>Monthly cost <span className="hint">(hover any cell or row label for the formula)</span></h3>
          <MonthlyGrid
            dates={input.dates}
            rows={rows}
            onCellEdit={(rowKey, i, v) => {
              if (!rowKey.startsWith('line_')) return;
              updateCostLine(dept, rowKey.slice(5), i, v);
            }}
            height={28 + 30 * (rows.length + 1)}
          />
        </div>
      </section>
    </>
  );
}

interface BudgetViewProps {
  input: ModelInput;
  output: ReturnType<typeof computeModel>;
}

function BudgetView({ input, output }: BudgetViewProps) {
  const b = output.budget;
  const monthlyRows: MonthlyRow[] = [
    {
      metric: 'Revenue (HubSpot + modeled)',
      rowKey: 'rev',
      values: b.revenue,
      rowTooltip: 'Total revenue: HubSpot pipeline + modeled-TA revenue per month.',
      cellTooltip: (i) =>
        `Revenue ${input.dates[i]}:\n${money(b.revenue[i])}\n\n  ${money(b.modeledRevenue[i])} (modeled)\n+ ${money(b.hubspot[i])} (HubSpot)`,
    },
    {
      metric: 'Modeller Commission',
      rowKey: 'commission',
      values: b.modellerCommission.map((v) => -v),
      rowTooltip:
        [
          'Modeller Commission (Cost of Sales):',
          `Computed per TA per month as min(rate × AI revenue, cap).`,
          '',
          'formula:\ncomm_TA(m) = min(rate × Σ_t active_t × ai_t × sites_t / 12, cap)',
          'rate = ' + (input.commission.rate * 100).toFixed(0) + '%, cap = $' + Math.round(input.commission.capPerMonth).toLocaleString() + ' / TA / month',
        ].join('\n'),
      cellTooltip: (i) => {
        const lines: string[] = [`Modeller Commission ${input.dates[i]}:`, `total = ${money(-b.modellerCommission[i])}`, '', 'this cell:'];
        for (const ta of input.taNames) {
          const v = b.modellerCommissionByTA[ta][i];
          if (v === 0) continue;
          const capped = v >= input.commission.capPerMonth - 0.01;
          lines.push(`  ${money(v)}  (${ta})${capped ? '  ← at cap' : ''}`);
        }
        if (lines.length === 4) lines.push('  no commission this month');
        return lines.join('\n');
      },
    },
    {
      metric: 'Capital Depreciation',
      rowKey: 'depr',
      values: b.depreciation.map((v) => -v),
      rowTooltip: 'Cost of Sales: amortised capital purchases (computers etc.) per the Capital Purchases schedule.',
      cellTooltip: (i) =>
        `Depreciation ${input.dates[i]}:\n${money(-b.depreciation[i])}\n\nFrom Capital Purchases row 155.`,
    },
    {
      metric: 'Gross Profit',
      rowKey: 'gp',
      isTotal: true,
      values: b.grossProfit,
      rowTooltip:
        'formula:\ngross_profit(m) = revenue(m) − cost_of_sales(m)\n              = revenue(m) − modeller_commission(m) − depreciation(m)',
      cellTooltip: (i) =>
        `Gross Profit ${input.dates[i]}:\n${money(b.grossProfit[i])}\n\n  ${money(b.revenue[i])} (revenue)\n− ${money(b.modellerCommission[i])} (modeller commission)\n− ${money(b.depreciation[i])} (depreciation)`,
    },
  ];

  for (const dept of input.costs.depts) {
    monthlyRows.push({
      metric: dept,
      rowKey: `dept_${dept}`,
      values: b.perDept[dept].total.map((v) => -v),
      rowTooltip:
        `${dept} total opex (Staff + line items). Negative because it's an expense.`,
      cellTooltip: (i) =>
        `${dept} ${input.dates[i]}:\n${money(-b.perDept[dept].total[i])}\n  (= staff ${money(b.perDept[dept].staff[i])} + non-staff ${money(b.perDept[dept].nonStaff[i])})`,
    });
  }

  monthlyRows.push({
    metric: 'Total Opex',
    rowKey: 'opex',
    isTotal: true,
    values: b.totalOpex.map((v) => -v),
    rowTooltip: 'Sum of all departmental opex (negative).',
    cellTooltip: (i) =>
      `Total Opex ${input.dates[i]}:\n${money(-b.totalOpex[i])}\n\nSum across S&M, G&A, Engineering, Product Support.`,
  });
  monthlyRows.push({
    metric: 'EBITDA',
    rowKey: 'ebitda',
    isTotal: true,
    values: b.ebitda,
    rowTooltip:
      'formula:\nEBITDA(m) = gross_profit(m) − total_opex(m)',
    cellTooltip: (i) =>
      `EBITDA ${input.dates[i]}:\n${money(b.ebitda[i])}\n\n  ${money(b.grossProfit[i])} (gross profit)\n− ${money(b.totalOpex[i])} (opex)`,
  });

  const yearly = b.yearly;
  return (
    <>
      <section>
        <h2>Yearly P&amp;L</h2>
        <table className="yearly-emp-table">
          <thead>
            <tr>
              <th>Line</th>
              {output.years.map((y) => <th key={y}>{y}</th>)}
              <th>6-yr Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Revenue</td>
              {yearly.revenue.map((v, i) => <td key={i}>{money(v)}</td>)}
              <td className="bold">{money(yearly.revenue.reduce((a, b) => a + b, 0))}</td>
            </tr>
            <tr>
              <td>Cost of Sales</td>
              {yearly.costOfSales.map((v, i) => <td key={i}>−{money(v)}</td>)}
              <td className="bold">−{money(yearly.costOfSales.reduce((a, b) => a + b, 0))}</td>
            </tr>
            <tr className="subtotal-row">
              <td>Gross Profit</td>
              {yearly.grossProfit.map((v, i) => <td key={i}>{money(v)}</td>)}
              <td className="bold">{money(yearly.grossProfit.reduce((a, b) => a + b, 0))}</td>
            </tr>
            {input.costs.depts.map((d) => {
              const arr = yearly.perDept[d].total;
              return (
                <tr key={d}>
                  <td>{d}</td>
                  {arr.map((v, i) => <td key={i}>−{money(v)}</td>)}
                  <td className="bold">−{money(arr.reduce((a, b) => a + b, 0))}</td>
                </tr>
              );
            })}
            <tr className="subtotal-row">
              <td>Total Opex</td>
              {yearly.totalOpex.map((v, i) => <td key={i}>−{money(v)}</td>)}
              <td className="bold">−{money(yearly.totalOpex.reduce((a, b) => a + b, 0))}</td>
            </tr>
            <tr className="total-row">
              <td>EBITDA</td>
              {yearly.ebitda.map((v, i) => <td key={i} className={v < 0 ? 'neg' : ''}>{money(v)}</td>)}
              <td className="bold">{money(yearly.ebitda.reduce((a, b) => a + b, 0))}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Monthly P&amp;L</h2>
        <p className="hint">Revenue and gross-profit margins improve as modeled-TA revenue ramps. Hover any cell for the breakdown.</p>
        <MonthlyGrid
          dates={input.dates}
          rows={monthlyRows}
          height={28 + 30 * (monthlyRows.length + 1)}
        />
      </section>
    </>
  );
}

interface TotalViewProps {
  input: ModelInput;
  output: ReturnType<typeof computeModel>;
  updateHubSpot: (rowKey: string, monthIdx: number, value: number) => void;
}

function TotalView({ input, output, updateHubSpot }: TotalViewProps) {
  const activeTaNames = input.taNames.filter((n) =>
    output.yearly.perTA[n].total.some((v) => v > 0),
  );
  // Show all line items so the user can edit any of them — even ones that started at zero.
  const lineItemNames = Object.keys(input.hubspot.lineItems);

  const rows: MonthlyRow[] = [];

  for (const name of lineItemNames) {
    rows.push({
      metric: name,
      rowKey: `hs_${name}`,
      values: input.hubspot.lineItems[name],
      editable: true,
      rowTooltip: HUBSPOT_ROW_TOOLTIP,
      cellTooltip: (i, v) => hubspotLineCellTooltip(name, i, input.dates, v),
    });
  }
  rows.push({
    metric: 'HubSpot pipeline (subtotal)',
    rowKey: 'hs_subtotal',
    isTotal: true,
    values: input.hubspot.grandTotal,
    rowTooltip: HUBSPOT_ROW_TOOLTIP,
    cellTooltip: (i) => hubspotSubtotalCellTooltip(i, input.dates, input.hubspot.lineItems),
  });

  for (const name of activeTaNames) {
    const taOut = output.perTA[name];
    rows.push({
      metric: name,
      rowKey: `ta_${name}`,
      values: taOut.total,
      rowTooltip: TA_TOTAL_ROW_TOOLTIP,
      cellTooltip: (i) => taTotalCellTooltip(name, i, input.dates, taOut),
    });
  }
  rows.push({
    metric: 'Modeled TAs (subtotal)',
    rowKey: 'ta_subtotal',
    isTotal: true,
    values: output.totals.total,
    rowTooltip: TA_TOTAL_ROW_TOOLTIP,
    cellTooltip: (i) => modeledSubtotalCellTooltip(i, input.dates, output.perTA, activeTaNames),
  });

  rows.push({
    metric: 'Grand total (HubSpot + modeled)',
    rowKey: 'grand_total',
    isTotal: true,
    values: output.grandTotal,
    rowTooltip: GRAND_TOTAL_ROW_TOOLTIP,
    cellTooltip: (i) => grandTotalCellTooltip(i, input.dates, input.hubspot.grandTotal[i], output.totals.total[i]),
  });

  const hsTotal = input.hubspot.grandTotal.reduce((a, b) => a + b, 0);
  const modeledTotal = output.totals.total.reduce((a, b) => a + b, 0);

  return (
    <>
      <section>
        <h2>Yearly revenue summary <span className="hint">(HubSpot + modeled)</span></h2>
        <YearlySummary output={output} taNames={input.taNames} variant="total" />
      </section>

      <section>
        <h2>Total Revenue <span className="hint">(modeled TAs + HubSpot pipeline)</span></h2>
        <div className="ta-summary">
          <span className="ta-name">All revenue</span>
          <span className="ta-total">
            6-yr total: ${Math.round(hsTotal + modeledTotal).toLocaleString()}{' '}
            <span className="hint">
              (= ${Math.round(hsTotal).toLocaleString()} HubSpot + ${Math.round(modeledTotal).toLocaleString()} modeled)
            </span>
          </span>
        </div>

        <h3>
          Monthly revenue ($){' '}
          <span className="hint">
            HubSpot pipeline rows are editable (yellow cells). Modeled rows derive from the Revenue Model auto tab.
            Hover any cell or row label for the formula.
          </span>
        </h3>
        <MonthlyGrid
          dates={input.dates}
          rows={rows}
          onCellEdit={updateHubSpot}
          height={28 + 30 * (rows.length + 1)}
        />
      </section>
    </>
  );
}
