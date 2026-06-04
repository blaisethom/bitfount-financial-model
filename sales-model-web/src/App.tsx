import { useEffect, useMemo, useRef, useState } from 'react';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './App.css';
import { loadInitialInput } from './data';
import type { ModelInput, HubSpotSyncAssumptions } from './types';
import Modal from './components/Modal';
import EnginePreview from './components/EnginePreview';
import StackedBarChart from './components/StackedBarChart';
import { salesModel } from './models/salesModel';
import { evaluateSalesModel } from './models/evaluateSalesModel';
import EngineSection from './report/EngineSection';
import { applyEditToInput } from './report/applyEdit';
import { engineSummary } from './report/summary';
import { salesReport } from './report/salesReport';
import { useUndoable } from './useUndoable';
import { annualSummaryByType, contractValueHistory, quarterlyPivot, syncHubSpot } from './hubspot';

ModuleRegistry.registerModules([AllCommunityModule]);

type View = 'model' | 'total' | 'hubspot' | 'hubspot-deals' | 'employees' | 'costs' | 'budget' | 'balance-sheet' | 'engine';

const ALL_VIEWS: View[] = ['model', 'total', 'hubspot', 'hubspot-deals', 'employees', 'costs', 'budget', 'balance-sheet', 'engine'];
const DEFAULT_VIEW: View = 'total';

interface Route {
  view: View;
  /** Sub-location inside the view. Currently only used for `engine`, where it
   *  names the source/step ref the user is looking at. */
  ref?: string;
}

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  if (!raw) return { view: DEFAULT_VIEW };
  const slash = raw.indexOf('/');
  const head = slash >= 0 ? raw.slice(0, slash) : raw;
  const tail = slash >= 0 ? raw.slice(slash + 1) : '';
  if (!(ALL_VIEWS as string[]).includes(head)) return { view: DEFAULT_VIEW };
  const ref = tail ? decodeURIComponent(tail) : undefined;
  return { view: head as View, ref };
}

function formatRoute(route: Route): string {
  return route.ref ? `#${route.view}/${encodeURIComponent(route.ref)}` : `#${route.view}`;
}

/** Two-way binding between component state and `location.hash`. Pushing a new
 *  route goes through `history.pushState`, so the browser Back/Forward buttons
 *  replay prior selections. Also listens for `popstate` (back/forward) and
 *  `hashchange` (manual URL edits) to keep state in sync. */
function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? { view: DEFAULT_VIEW } : parseRoute(window.location.hash),
  );
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);
  const navigate = (next: Route) => {
    const hash = formatRoute(next);
    if (hash !== window.location.hash) {
      window.history.pushState(null, '', hash);
    }
    setRoute(next);
  };
  return [route, navigate];
}

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
  const [route, navigate] = useHashRoute();
  const view = route.view;
  const setView = (v: View) => navigate({ view: v });
  const setEngineRef = (ref: string) => navigate({ view: 'engine', ref });
  const [lastSyncMeta, setLastSyncMeta] = useState<import('./hubspot').SyncResult['meta'] | null>(null);

  const engineResult = useMemo(() => evaluateSalesModel(input), [input]);
  const summary = useMemo(() => engineSummary(engineResult), [engineResult]);
  const handleReportEdit = (edit: Parameters<typeof applyEditToInput>[1]) =>
    setInput((prev) => applyEditToInput(prev, edit));

  const updateHubSpotSync = (next: HubSpotSyncAssumptions) =>
    setInput((prev) => ({ ...prev, hubspotSync: next }));

  const runHubSpotSync = async () => {
    const result = await syncHubSpot(
      input.dates,
      Object.keys(input.hubspot.lineItems),
      input.hubspotSync,
    );
    setInput((prev) => ({ ...prev, hubspot: result.hubspot }));
    setLastSyncMeta(result.meta);
    const { meta } = result;
    const parts = [
      `Synced ${meta.dealsApplied}/${meta.dealsApplied + meta.dealsSkipped} deals`,
      `(${meta.counts.sales} Sales + ${meta.counts.changeOrders} CO, ${meta.counts.lineItems} line items)`,
    ];
    if (meta.newLineItemNames.length) parts.push(`+${meta.newLineItemNames.length} new line items`);
    if (meta.unknownStages.length) parts.push(`unknown stages: ${meta.unknownStages.join(', ')}`);
    if (meta.unknownLineItemNames.length) parts.push(`unmapped: ${meta.unknownLineItemNames.length}`);
    return parts.join(' · ');
  };

  const reset = () => setReset(loadInitialInput());

  const { modeledTotal, hubspotTotal, grandTotal, employeeTotal, opexTotal, ebitdaTotal } = summary;

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
          <HeaderMenu
            onReset={reset}
            onDownload={async () => {
              const { downloadModelAsExcelViaEngine } = await import('./report/downloadReport');
              await downloadModelAsExcelViaEngine(input);
            }}
            onSync={runHubSpotSync}
          />
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
          aria-selected={view === 'hubspot'}
          className={`view-tab ${view === 'hubspot' ? 'active' : ''}`}
          onClick={() => setView('hubspot')}
        >
          HubSpot
          <span className="view-tab-sub">
            ${(hubspotTotal / 1e6).toFixed(1)}M pipeline
            {lastSyncMeta ? ` · synced` : ' · not synced'}
          </span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'hubspot-deals'}
          className={`view-tab ${view === 'hubspot-deals' ? 'active' : ''}`}
          onClick={() => setView('hubspot-deals')}
        >
          HubSpot Deals
          <span className="view-tab-sub">
            {lastSyncMeta ? `${lastSyncMeta.deals.length} deals` : 'sync to view'}
          </span>
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
        <button
          role="tab"
          aria-selected={view === 'balance-sheet'}
          className={`view-tab ${view === 'balance-sheet' ? 'active' : ''}`}
          onClick={() => setView('balance-sheet')}
        >
          Balance Sheet
          <span className="view-tab-sub">simplified</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'engine'}
          className={`view-tab ${view === 'engine' ? 'active' : ''}`}
          onClick={() => setView('engine')}
        >
          Engine (preview)
          <span className="view-tab-sub">v2 declarative</span>
        </button>
      </div>

      {view === 'model' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="revenue-model" onEdit={handleReportEdit} />
      ) : view === 'total' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="total-revenue" onEdit={handleReportEdit} />
      ) : view === 'hubspot' ? (
        <HubSpotView
          input={input}
          engineResult={engineResult}
          hubspotTotal={hubspotTotal}
          updateHubSpotSync={updateHubSpotSync}
          onSync={runHubSpotSync}
          onReportEdit={handleReportEdit}
          lastSyncMeta={lastSyncMeta}
        />
      ) : view === 'hubspot-deals' ? (
        <HubSpotDealsView lastSyncMeta={lastSyncMeta} onSync={runHubSpotSync} />
      ) : view === 'employees' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="employees" onEdit={handleReportEdit} />
      ) : view === 'costs' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="costs" onEdit={handleReportEdit} />
      ) : view === 'balance-sheet' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="balance-sheet" onEdit={handleReportEdit} />
      ) : view === 'engine' ? (
        <EnginePreview
          model={salesModel}
          result={engineResult}
          currentRef={route.ref}
          onRefChange={setEngineRef}
        />
      ) : (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="budget" onEdit={handleReportEdit} />
      )}

      <footer className="app-footer">
        <p>
          Modeled from <code>5-year-plan.xlsx</code>. <strong>Revenue Model</strong> reproduces v4's modeled per-TA totals
          exactly (e.g. Ophthalmology 2031 = $14,860,417 matches the Revenue Model auto sheet's row 83 sum to the cent).
          <strong> HubSpot</strong> pipeline values come from the HubSpot Pivot tab and are now <em>allocated to TAs at sync
          time</em> using deal-name regex rules editable on the HubSpot tab — default config catches every ophthalmology
          term (WetAMD / GA / DME / DR / Glaucoma / cataract / OCT / fundus / retina / InSite) and routes all matching
          deals to Ophthalmology. Add a rule (e.g. `\b(liver|mash|hepatic)\b` → "Hepatology") to fan deals out as new TAs
          come online. <em>Per-(TA, month) manual revenue adjustments</em> on the Total Revenue tab reproduce v4's six 2026
          Ophthalmology budget tweaks (Jan/Feb/Mar formula adds plus Oct/Nov/Dec hardcoded +$50k). With the defaults in
          place, <strong>Total Revenue now matches v4 to the cent in every year 2026–2031.</strong> <strong>Employees</strong>: 48 people including 7 with end dates (Jonny / Daniella /
          Tomike / Nikolas / Christopher / Ali / Lily — leaving Dec 2025 → May 2026), 5% inflation each April. Two v4
          formula bugs are reproduced by default (toggle in the Employees assumptions): <code>maxInflationSteps=4</code>
          (v4 skips the Apr 2031 step) and <code>inflateFutureHires=false</code> (v4 leaves future-start hires flat).
          <strong> Modeller commission</strong> = <code>min(80% × AI revenue, $30k cap)</code> per TA per month, summed across
          12 TAs — matches v4 to the cent in 2027 / 2029 / 2030 / 2031, off by $20k in 2028 due to spreadsheet formula
          inconsistency (v4's row 304 sums B292:B295 in some columns and B292:B303 in others). <strong>Sales commission</strong>
          = <code>min($6k × starts + 12% × revenue, 1.5 × Total Sales Salary)</code> where Total Sales Salary is the
          sum of cap-eligible employees (David / Jonny / Muhammad / East+West Coast / Therapeutic 1+2) — matches v4
          within 5% in all years. <strong>Balance Sheet</strong> derives every v4 line from the opening position
          and monthly P&amp;L; opening values and AR/AP days are editable on the Balance Sheet tab.
        </p>
        <p>
          <strong>Salary adjustments</strong>: v4's hand-edited per-cell salary tweaks (Naaman's ×0.8 from Apr 2026,
          Blaise's ×0.66 from Apr 2026 then ×2.8052 from Apr 2027 tracking Naaman's salary) are now reproduced via a
          sparse multiplier table editable on the Employees tab. Each row sets a factor on one employee's monthly cost
          that carries forward until the next adjustment for the same employee. With the defaults in place, <strong>G&amp;A
          / Engineering / Product Support staff costs now match v4 to the dollar in every year</strong> and yearly Total
          Opex tracks v4 within $1 in 2028–2031.
          <br /><br />
          <strong>Sales commission</strong> is now overridden per-month from v4's hardcoded S&amp;M Commission line (every cell
          in v4 is a pasted value — no formula at all). <strong>Modeller commission</strong> uses our `min(0.8 × AI revenue,
          $30k cap)` per-TA formula plus four manual Jan/Feb/Mar/May 2026 historic-commitment entries. <strong>Depreciation</strong>
          patches the Jan-Mar 2026 cells (v4 hardcodes Jan = `-256 × 1.32` = -$337.92 and leaves Feb/Mar empty, rather than pulling
          from Capital Purchases). With all three in place, <strong>cost of sales now matches v4 to the cent in every year
          except 2030 (-$5,000) and EBITDA matches to within $1 in 2027/2029/2031</strong>.
          <br /><br />
          Final piece: v4's G&amp;A Salaries Jan/Feb/Mar 2026 cells use formulas like `=Employees!L51-2642` (manual
          actual-vs-modelled reconciliations subtracting $2,642 / $2,506 / $4,410). Pre-populated as G&amp;A staff actuals
          for those three months, the per-dept totals auto-recompute (`staff_actual + non_staff_modelled +
          derived_modelled`) and flow through Total Opex → EBITDA. <strong>Result: every Budget P&amp;L yearly line —
          Revenue, Cost of Sales, Gross Profit, Total Opex, EBITDA — matches v4 to within $3 across all 6 years
          (rounding noise on division and the cascading IF expressions).</strong>
        </p>
      </footer>
    </div>
  );
}

interface HeaderMenuProps {
  onReset: () => void;
  onDownload: () => Promise<void> | void;
  onSync: () => Promise<string>;
}

function HeaderMenu({ onReset, onDownload, onSync }: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleUploadClick = () => {
    setOpen(false);
    fileRef.current?.click();
  };

  const handleReset = () => {
    setOpen(false);
    onReset();
  };

  const handleDownload = async () => {
    setOpen(false);
    setStatus('Building Excel…');
    try {
      await onDownload();
      setStatus('Downloaded Excel');
    } catch (err) {
      setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 4000);
  };

  const handleSync = async () => {
    setOpen(false);
    setStatus('Syncing from HubSpot…');
    try {
      const summary = await onSync();
      setStatus(summary);
    } catch (err) {
      setStatus(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 8000);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus(`Uploading ${file.name}…`);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-filename': file.name, 'content-type': 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(`Uploaded ${file.name}`);
    } catch (err) {
      setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 4000);
  };

  return (
    <div className="menu-wrap" ref={wrapRef}>
      {status && <span className="menu-status">{status}</span>}
      <button
        className="btn icon-btn"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </button>
      {open && (
        <div className="menu-dropdown" role="menu">
          <button role="menuitem" className="menu-item" onClick={handleSync}>
            Sync from HubSpot
          </button>
          <button role="menuitem" className="menu-item" onClick={handleDownload}>
            Download as Excel
          </button>
          <button role="menuitem" className="menu-item" onClick={handleUploadClick}>
            Upload file…
          </button>
          <button role="menuitem" className="menu-item" onClick={handleReset}>
            Reset to Excel defaults
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}

interface HubSpotViewProps {
  input: ModelInput;
  engineResult: ReturnType<typeof evaluateSalesModel>;
  hubspotTotal: number;
  updateHubSpotSync: (next: HubSpotSyncAssumptions) => void;
  onSync: () => Promise<string>;
  onReportEdit: (edit: Parameters<typeof applyEditToInput>[1]) => void;
  lastSyncMeta: import('./hubspot').SyncResult['meta'] | null;
}

function HubSpotView({ input, engineResult, hubspotTotal, updateHubSpotSync, onSync, onReportEdit, lastSyncMeta }: HubSpotViewProps) {
  const a = input.hubspotSync;
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      setSyncMsg(await onSync());
    } catch (err) {
      setSyncMsg(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setSyncing(false);
  };

  const updateStage = (label: string, field: 'closeProbability' | 'remainingDays', value: number) => {
    updateHubSpotSync({
      ...a,
      stages: { ...a.stages, [label]: { ...a.stages[label], [field]: value } },
    });
  };

  const updateSchedule = (name: string, value: HubSpotSyncAssumptions['paymentSchedules'][string]) => {
    updateHubSpotSync({ ...a, paymentSchedules: { ...a.paymentSchedules, [name]: value } });
  };

  return (
    <>
      <section>
        <div className="ta-summary">
          <span className="ta-name">HubSpot Sync</span>
          <span className="ta-total">
            Pipeline 6-yr total: ${Math.round(hubspotTotal).toLocaleString()}
          </span>
        </div>
        <p className="hint">
          Pulls deals from <code>Sales Pipeline [New]</code> + <code>Change Orders</code>, applies the
          per-stage close probability and per-line-item payment schedule below, and replaces the
          HubSpot section of the model. Edits here re-run only on next Sync.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <button className="btn" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync from HubSpot'}
          </button>
          {syncMsg && <span className="hint" style={{ margin: 0 }}>{syncMsg}</span>}
        </div>
        {lastSyncMeta && (
          <div className="hint" style={{ marginTop: 8 }}>
            Last sync at {new Date(lastSyncMeta.fetchedAt).toLocaleString()} —{' '}
            {lastSyncMeta.dealsApplied} applied · {lastSyncMeta.dealsSkipped} skipped (
            {Object.entries(lastSyncMeta.skipReasons).map(([k, v]) => `${v} ${k}`).join(', ')})
            {lastSyncMeta.newLineItemNames.length > 0 && (
              <>
                {' · '}new line items: {lastSyncMeta.newLineItemNames.join(', ')}
              </>
            )}
            {lastSyncMeta.unknownStages.length > 0 && (
              <>
                {' · '}<strong>unknown stages</strong>: {lastSyncMeta.unknownStages.join(', ')}
              </>
            )}
            {lastSyncMeta.unknownLineItemNames.length > 0 && (
              <>
                {' · '}<strong>unmapped line items</strong>: {lastSyncMeta.unknownLineItemNames.join(', ')}
              </>
            )}
          </div>
        )}
      </section>

      <section>
        <h2>Annual summary by revenue type</h2>
        <p className="hint">
          High-level revenue type = line item name trimmed before the first "-" (so all "Bitfount License - …"
          rows roll up to "Bitfount License"). Values are the synced pipeline above, totalled per calendar year.
        </p>
        {(() => {
          const summary = annualSummaryByType(input.hubspot, input.dates);
          return (
            <div className="scroll-x" style={{ maxWidth: 900 }}>
            <table className="yearly-emp-table">
              <thead>
                <tr>
                  <th>Revenue type</th>
                  {summary.years.map((y) => <th key={y}>{y}</th>)}
                  <th>6-yr Total</th>
                </tr>
              </thead>
              <tbody>
                {summary.types.map((t) => {
                  const rowTotal = summary.years.reduce((s, y) => s + (summary.data[t]?.[y] || 0), 0);
                  return (
                    <tr key={t}>
                      <td>{t}</td>
                      {summary.years.map((y) => <td key={y}>{money(summary.data[t]?.[y] || 0)}</td>)}
                      <td className="bold">{money(rowTotal)}</td>
                    </tr>
                  );
                })}
                <tr className="total-row">
                  <td>TOTAL</td>
                  {summary.years.map((y) => {
                    const colTotal = summary.types.reduce((s, t) => s + (summary.data[t]?.[y] || 0), 0);
                    return <td key={y}>{money(colTotal)}</td>;
                  })}
                  <td className="bold">
                    {money(
                      summary.types.reduce(
                        (s, t) => s + summary.years.reduce((s2, y) => s2 + (summary.data[t]?.[y] || 0), 0),
                        0,
                      ),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            </div>
          );
        })()}
      </section>

      <section>
        <h2>Pipeline by line item × month <span className="hint">(synced state, editable)</span></h2>
        <p className="hint">
          Monthly value of each HubSpot line item after applying the stage probability and payment
          schedule. Sums to the pipeline total above.
        </p>
        <EngineSection
          report={salesReport}
          evalResult={engineResult}
          model={salesModel}
          sectionId="hubspot"
          onEdit={onReportEdit}
        />
      </section>

      <section>
        <h2>Sync settings</h2>
        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', marginTop: 4 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="hint" style={{ margin: 0 }}>Close-date mode</span>
            <select
              className="btn"
              value={a.closeDateMode}
              onChange={(e) =>
                updateHubSpotSync({ ...a, closeDateMode: e.target.value as 'predicted' | 'hubspot' })
              }
            >
              <option value="predicted">Predicted (HubSpot date + remaining stage days)</option>
              <option value="hubspot">HubSpot date (use raw closedate)</option>
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="hint" style={{ margin: 0 }}>Default project duration (months)</span>
            <input
              className="btn"
              type="number"
              min={1}
              value={a.defaultDurationMonths}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) updateHubSpotSync({ ...a, defaultDurationMonths: v });
              }}
              style={{ width: 120 }}
            />
          </label>
        </div>
      </section>

      <section>
        <h2>Stage probability table</h2>
        <p className="hint">
          Close probability and estimated remaining days per stage. Used to weight deal value and to
          shift the predicted close date forward from the HubSpot close date. Stages with 0% are
          skipped entirely (Closed Lost).
        </p>
        <table className="yearly-emp-table" style={{ maxWidth: 640 }}>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Close probability</th>
              <th>Remaining days</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(a.stages).map((label) => {
              const s = a.stages[label];
              return (
                <tr key={label}>
                  <td>{label}</td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      max={1}
                      value={s.closeProbability}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v)) updateStage(label, 'closeProbability', v);
                      }}
                      style={{ width: 90, textAlign: 'right' }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="0.5"
                      min={0}
                      value={s.remainingDays}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v)) updateStage(label, 'remainingDays', v);
                      }}
                      style={{ width: 90, textAlign: 'right' }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Payment schedule by line item</h2>
        <p className="hint">
          <strong>Annual</strong>: ⌈duration/12⌉ payments on close-date anniversary months ·
          <strong> Uniform</strong>: spread evenly over `duration` months ·
          <strong> Start</strong>: lump in close month ·
          <strong> End</strong>: lump in close + duration month.
        </p>
        <table className="yearly-emp-table" style={{ maxWidth: 720 }}>
          <thead>
            <tr>
              <th>Line item</th>
              <th>Schedule</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(a.paymentSchedules).sort().map((name) => (
              <tr key={name}>
                <td>{name}</td>
                <td>
                  <select
                    value={a.paymentSchedules[name]}
                    onChange={(e) =>
                      updateSchedule(name, e.target.value as HubSpotSyncAssumptions['paymentSchedules'][string])
                    }
                  >
                    <option value="Annual">Annual</option>
                    <option value="Uniform">Uniform</option>
                    <option value="Start">Start</option>
                    <option value="End">End</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

interface HubSpotDealsViewProps {
  lastSyncMeta: import('./hubspot').SyncResult['meta'] | null;
  onSync: () => Promise<string>;
}

function HubSpotDealsView({ lastSyncMeta, onSync }: HubSpotDealsViewProps) {
  const [syncing, setSyncing] = useState(false);
  const [sortKey, setSortKey] = useState<'name' | 'expected' | 'amount' | 'predicted' | 'prob' | 'stage'>('expected');
  const [sortDesc, setSortDesc] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'applied' | 'skipped'>('all');
  const [openModal, setOpenModal] = useState<null | 'current' | 'expected'>(null);

  const handleSync = async () => {
    setSyncing(true);
    try { await onSync(); } catch { /* errors surfaced via menu status */ }
    setSyncing(false);
  };

  if (!lastSyncMeta) {
    return (
      <section>
        <div className="ta-summary">
          <span className="ta-name">HubSpot Deals</span>
        </div>
        <p className="hint">No sync data yet. Click Sync to fetch deals from HubSpot.</p>
        <button className="btn" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync from HubSpot'}
        </button>
      </section>
    );
  }

  const deals = lastSyncMeta.deals
    .filter((d) => statusFilter === 'all' || d.status === statusFilter)
    .slice()
    .sort((a, b) => {
      const dir = sortDesc ? -1 : 1;
      switch (sortKey) {
        case 'name': return a.name.localeCompare(b.name) * dir;
        case 'expected': return (a.expectedAmount - b.expectedAmount) * dir;
        case 'amount': return (a.amountReported - b.amountReported) * dir;
        case 'predicted':
          return ((a.closeDatePredicted ?? '') < (b.closeDatePredicted ?? '') ? -1 : 1) * dir;
        case 'prob': return (a.closeProbability - b.closeProbability) * dir;
        case 'stage': return a.stageLabel.localeCompare(b.stageLabel) * dir;
      }
    });

  const totalExpected = deals.reduce((s, d) => s + d.expectedAmount, 0);
  const totalAmount = deals.reduce((s, d) => s + d.amountReported, 0);

  const headerSort = (key: typeof sortKey, label: string) => (
    <th
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else { setSortKey(key); setSortDesc(true); }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  const history = contractValueHistory(lastSyncMeta.deals);
  const maxHistCV = history.reduce((m, r) => Math.max(m, r.totalCV), 0);
  const currentPipe = quarterlyPivot(lastSyncMeta.deals, { weighted: false, openOnly: true });
  const expectedClose = quarterlyPivot(lastSyncMeta.deals, { weighted: true, openOnly: false });

  const pivotTable = (p: typeof currentPipe) => (
    <table className="yearly-emp-table">
      <thead>
        <tr>
          <th>Quarter</th>
          {p.types.map((t) => <th key={t}>{t}</th>)}
          <th>Row total</th>
        </tr>
      </thead>
      <tbody>
        {p.quarters.length === 0 && (
          <tr><td colSpan={p.types.length + 2}><span className="hint">No deals.</span></td></tr>
        )}
        {p.quarters.map((q) => (
          <tr key={q}>
            <td>{q}</td>
            {p.types.map((t) => <td key={t}>{money(p.data[q]?.[t] || 0)}</td>)}
            <td className="bold">{money(p.rowTotals[q])}</td>
          </tr>
        ))}
        {p.quarters.length > 0 && (
          <tr className="total-row">
            <td>TOTAL</td>
            {p.types.map((t) => <td key={t}>{money(p.colTotals[t] || 0)}</td>)}
            <td className="bold">{money(p.grandTotal)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );

  return (
    <>
      <section>
        <h2>Total contract value over time <span className="hint">(snapshot at start of each month)</span></h2>
        <p className="hint">
          A deal is counted as live if its create date is ≤ the month start and its HubSpot close date is &gt; the month
          start. TCV = sum of (unit price × quantity) across the deal's line items.
        </p>
        <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
          <table className="yearly-emp-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Month start</th>
                <th>Live deals</th>
                <th>Total CV</th>
                <th style={{ width: '50%' }}></th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.monthStart}>
                  <td>{r.monthStart}</td>
                  <td>{r.liveCount}</td>
                  <td className="bold">{money(r.totalCV)}</td>
                  <td>
                    <div
                      style={{
                        height: 10,
                        background: 'var(--accent)',
                        width: maxHistCV ? `${(r.totalCV / maxHistCV) * 100}%` : '0%',
                        borderRadius: 2,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>
              Current pipeline by close quarter × revenue type{' '}
              <span className="hint">(open deals, raw amounts)</span>
            </h2>
            <p className="hint">
              Sum of (unit price × quantity) across all open deals (stage not Closed Won/Lost), stacked by
              high-level revenue type and bucketed by the deal's predicted close quarter.
            </p>
          </div>
          <button className="btn" onClick={() => setOpenModal('current')}>Show raw data</button>
        </div>
        <StackedBarChart pivot={currentPipe} />
      </section>

      <section>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>
              Estimated closed pipeline by close quarter × revenue type{' '}
              <span className="hint">(all deals × close probability)</span>
            </h2>
            <p className="hint">
              Each line item value is multiplied by the deal's close probability — Closed Won = 100%, Closed Lost
              excluded (0%). Represents the forecast booking by quarter.
            </p>
          </div>
          <button className="btn" onClick={() => setOpenModal('expected')}>Show raw data</button>
        </div>
        <StackedBarChart pivot={expectedClose} />
      </section>

      <Modal
        open={openModal === 'current'}
        onClose={() => setOpenModal(null)}
        title="Current pipeline by close quarter × revenue type — raw data"
      >
        {pivotTable(currentPipe)}
      </Modal>
      <Modal
        open={openModal === 'expected'}
        onClose={() => setOpenModal(null)}
        title="Estimated closed pipeline by close quarter × revenue type — raw data"
      >
        {pivotTable(expectedClose)}
      </Modal>

      <section>
      <div className="ta-summary">
        <span className="ta-name">HubSpot Deals</span>
        <span className="ta-total">
          {deals.length} deals · ${Math.round(totalAmount).toLocaleString()} total ·{' '}
          ${Math.round(totalExpected).toLocaleString()} expected
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 12px' }}>
        <button className="btn" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Re-sync'}
        </button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="hint" style={{ margin: 0 }}>Show:</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All ({lastSyncMeta.deals.length})</option>
            <option value="applied">Applied ({lastSyncMeta.dealsApplied})</option>
            <option value="skipped">Skipped ({lastSyncMeta.dealsSkipped})</option>
          </select>
        </label>
        <span className="hint" style={{ margin: 0 }}>
          Last sync: {new Date(lastSyncMeta.fetchedAt).toLocaleString()}
        </span>
      </div>
      <table className="yearly-emp-table">
        <thead>
          <tr>
            {headerSort('name', 'Deal')}
            <th>Pipeline</th>
            {headerSort('stage', 'Stage')}
            <th>TA</th>
            {headerSort('amount', 'Amount')}
            {headerSort('prob', 'Close prob')}
            {headerSort('expected', 'Expected')}
            <th>Close (HubSpot)</th>
            {headerSort('predicted', 'Close (predicted)')}
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {deals.map((d) => (
            <tr key={d.id}>
              <td style={{ textAlign: 'left', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</td>
              <td style={{ textAlign: 'left' }}>{d.pipelineLabel}</td>
              <td style={{ textAlign: 'left' }}>{d.stageLabel}</td>
              <td style={{ textAlign: 'left' }}>{d.therapeuticArea}</td>
              <td>{d.amountReported ? `$${Math.round(d.amountReported).toLocaleString()}` : ''}</td>
              <td>{(d.closeProbability * 100).toFixed(1)}%</td>
              <td className="bold">{d.expectedAmount ? `$${Math.round(d.expectedAmount).toLocaleString()}` : ''}</td>
              <td>{d.closeDateHubSpot ?? ''}</td>
              <td>{d.closeDatePredicted ?? ''}</td>
              <td>{d.durationMonths}m</td>
              <td className={d.status === 'applied' ? '' : 'neg'} title={d.skipReason ?? ''}>
                {d.status === 'applied' ? 'Applied' : `Skipped (${d.skipReason ?? ''})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </section>
    </>
  );
}

function money(v: number): string {
  if (!v) return '';
  return '$' + Math.round(v).toLocaleString();
}
