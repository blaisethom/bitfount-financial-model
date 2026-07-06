import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
import { applyEditToInput, EDITABLE_SOURCES } from './report/applyEdit';
import { SOURCE_IDENTITY } from './report/identity';
import { engineSummary } from './report/summary';
import { salesReport } from './report/salesReport';
import { useUndoable } from './useUndoable';
import ScenarioBar from './components/ScenarioBar';
import {
  type ScenarioStore,
  loadStore, saveStore, computeOverrides, applyOverrides, newId,
} from './scenarios';
import {
  type FormulaOverrides,
  loadFormulaOverrides, saveFormulaOverrides, applyFormulaOverrides,
} from './formula';
import { annualSummaryByType, contractValueHistory, highLevelType, quarterlyPivot, syncHubSpot } from './hubspot';
import { getLineItemConfig, isClassified } from './lineItemConfig';
import { Button } from '@/components/ui/button';
import { AIAssistant, buildSystemPrompt } from './components/AIAssistant';
import ReportDefinitionEditor from './report/ReportDefinitionEditor';
import YamlViewer from './components/YamlViewer';
import { type SavedModel, loadSavedModels, persistSavedModels } from './modelStore';
import NotificationsPanel, { type SyncNotification } from './components/NotificationsPanel';
import { weeklyCashflowModel } from './models/weeklyCashflowModel';
import { evaluateModel, type EvalResult, type Row, type Table } from './engine';
import { cashflowReport } from './report/cashflowReport';
import reportYamlRaw from './report/report.yaml';
import cashflowReportYamlRaw from './report/cashflow_report.yaml';
import engineLayoutRaw from './view-layout/engine.yaml';
import type { EngineLayoutConfig } from './view-layout/types';

ModuleRegistry.registerModules([AllCommunityModule]);

type View = 'model' | 'total' | 'hubspot' | 'hubspot-deals' | 'employees' | 'costs' | 'budget' | 'balance-sheet';

const ALL_VIEWS: View[] = ['model', 'total', 'hubspot', 'hubspot-deals', 'employees', 'costs', 'budget', 'balance-sheet'];
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
  // Base assumptions (code defaults). Scenarios are diffs layered on top of this.
  const base = useMemo(() => loadInitialInput(), []);
  const [store, setStore] = useState<ScenarioStore>(() => loadStore());

  // Initial live input = the active scenario's overrides layered on base.
  // Computed once on mount (store is read from its initial value).
  const initialInput = useMemo(() => {
    const active = store.scenarios.find((s) => s.id === store.activeId) ?? store.scenarios[0];
    return applyOverrides(base, active.overrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    state: input,
    set: setInput,
    reset: setReset,
    undo,
    redo,
    canUndo,
    canRedo,
    historyDepth,
  } = useUndoable<ModelInput>(initialInput);

  const activeScenario =
    store.scenarios.find((s) => s.id === store.activeId) ?? store.scenarios[0];

  // Persist the live input back into the active scenario as a set of overrides
  // (only the top-level fields that differ from base) whenever it changes.
  useEffect(() => {
    setStore((prev) => {
      const idx = prev.scenarios.findIndex((s) => s.id === prev.activeId);
      if (idx < 0) return prev;
      const nextOverrides = computeOverrides(base, input);
      if (JSON.stringify(prev.scenarios[idx].overrides) === JSON.stringify(nextOverrides)) {
        return prev;
      }
      const scenarios = prev.scenarios.slice();
      scenarios[idx] = { ...scenarios[idx], overrides: nextOverrides };
      return { ...prev, scenarios };
    });
  }, [input, base]);

  // Persist the whole scenario store to localStorage.
  useEffect(() => { saveStore(store); }, [store]);

  const switchScenario = (id: string) => {
    const s = store.scenarios.find((x) => x.id === id);
    if (!s || id === store.activeId) return;
    setStore((prev) => ({ ...prev, activeId: id }));
    setReset(applyOverrides(base, s.overrides));
  };

  const newScenario = () => {
    const id = newId();
    const existing = new Set(store.scenarios.map((s) => s.name));
    let name = `${activeScenario.name} copy`;
    let i = 2;
    while (existing.has(name)) name = `${activeScenario.name} copy ${i++}`;
    setStore((prev) => ({
      scenarios: [...prev.scenarios, { id, name, overrides: computeOverrides(base, input) }],
      activeId: id,
    }));
  };

  const renameScenario = (id: string, name: string) =>
    setStore((prev) => ({
      ...prev,
      scenarios: prev.scenarios.map((s) => (s.id === id ? { ...s, name } : s)),
    }));

  const deleteScenario = (id: string) => {
    if (store.scenarios.length <= 1) return;
    const remaining = store.scenarios.filter((s) => s.id !== id);
    const wasActive = store.activeId === id;
    const nextActiveId = wasActive ? remaining[0].id : store.activeId;
    setStore({ scenarios: remaining, activeId: nextActiveId });
    if (wasActive) setReset(applyOverrides(base, remaining[0].overrides));
  };

  const resetActiveScenario = () => {
    setStore((prev) => ({
      ...prev,
      scenarios: prev.scenarios.map((s) =>
        s.id === prev.activeId ? { ...s, overrides: {} } : s),
    }));
    setReset(base);
  };

  const [route, navigate] = useHashRoute();
  const view = route.view;
  const setView = (v: View) => navigate({ view: v });
  const [engineRef, setEngineRef] = useState<string | undefined>(undefined);
  const [lastSyncMeta, setLastSyncMeta] = useState<import('./hubspot').SyncResult['meta'] | null>(null);

  // Formula / operation overrides patch the model itself (base case / model-wide).
  const [formulaOverrides, setFormulaOverrides] = useState<FormulaOverrides>(() => loadFormulaOverrides());
  useEffect(() => { saveFormulaOverrides(formulaOverrides); }, [formulaOverrides]);
  const patchedModel = useMemo(() => applyFormulaOverrides(salesModel, formulaOverrides), [formulaOverrides]);

  // Merge the engine.yaml layout (groups + outputs) onto whichever model variant
  // we're using. salesModel itself has groups/outputs as empty arrays; the yaml
  // is the source of truth for the explorer sidebar structure.
  const engineLayout = engineLayoutRaw as EngineLayoutConfig;
  const withLayout = (m: typeof salesModel) => ({
    ...m,
    groups: engineLayout.groups ?? [],
    outputs: engineLayout.outputs ?? [],
  });

  // Evaluate with the patched model. If a (stale) override makes the model
  // un-evaluable, fall back to the base model and surface an error banner so
  // the app never white-screens.
  const { engineResult, modelForView, evalError } = useMemo(() => {
    try {
      return { engineResult: evaluateSalesModel(input, patchedModel), modelForView: withLayout(patchedModel), evalError: null as string | null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        return { engineResult: evaluateSalesModel(input, salesModel), modelForView: withLayout(salesModel), evalError: msg };
      } catch {
        return { engineResult: { tables: {}, trace: [] }, modelForView: withLayout(salesModel), evalError: msg };
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, patchedModel]);

  // Commit a formula/operation edit only if it parses (strict) AND the model
  // still evaluates; returns an error string to show in the editor, or null.
  const setFormula = (stepOutput: string, slot: string, src: string): string | null => {
    const next = { ...formulaOverrides, [stepOutput]: { ...formulaOverrides[stepOutput], [slot]: src } };
    try {
      const m = applyFormulaOverrides(salesModel, next, { strict: true });
      evaluateSalesModel(input, m); // throws on invalid refs / cycles
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    setFormulaOverrides(next);
    return null;
  };
  const resetFormula = (stepOutput: string, slot: string) =>
    setFormulaOverrides((prev) => {
      const step = { ...prev[stepOutput] };
      delete step[slot];
      const next = { ...prev, [stepOutput]: step };
      if (Object.keys(step).length === 0) delete next[stepOutput];
      return next;
    });
  const clearFormulaOverrides = () => setFormulaOverrides({});

  // Saved model slots — each stores a full snapshot of (scenarioStore, formulaOverrides).
  const [savedModels, setSavedModels] = useState<SavedModel[]>(() => loadSavedModels());
  useEffect(() => { persistSavedModels(savedModels); }, [savedModels]);

  const saveCurrentModel = (name: string) => {
    const id = newId();
    setSavedModels((prev) => [
      ...prev,
      { id, name, savedAt: new Date().toISOString(), scenarioStore: store, formulaOverrides },
    ]);
  };

  const loadSavedModel = (model: SavedModel) => {
    setStore(model.scenarioStore);
    setFormulaOverrides(model.formulaOverrides);
    const active =
      model.scenarioStore.scenarios.find((s) => s.id === model.scenarioStore.activeId) ??
      model.scenarioStore.scenarios[0];
    if (active) setReset(applyOverrides(base, active.overrides));
  };

  const deleteSavedModel = (id: string) =>
    setSavedModels((prev) => prev.filter((m) => m.id !== id));

  const summary = useMemo(() => engineSummary(engineResult), [engineResult]);
  const handleReportEdit = (edit: Parameters<typeof applyEditToInput>[1]) =>
    setInput((prev) => applyEditToInput(prev, edit));

  const updateHubSpotSync = (next: HubSpotSyncAssumptions) =>
    setInput((prev) => ({ ...prev, hubspotSync: next }));

  const NOTIF_KEY = 'sync_notifications_v1';
  const [notifications, setNotifications] = useState<SyncNotification[]>(() => {
    try { return JSON.parse(localStorage.getItem(NOTIF_KEY) ?? '[]'); }
    catch { return []; }
  });
  useEffect(() => { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifications)); }, [notifications]);
  const addNotification = (level: 'info' | 'error', msg: string) => {
    const n: SyncNotification = { id: Math.random().toString(36).slice(2), ts: new Date().toISOString(), level, msg };
    setNotifications(prev => [n, ...prev].slice(0, 50));
  };

  const runHubSpotSync = async () => {
    const result = await syncHubSpot(
      input.dates,
      Object.keys(input.hubspot.lineItems),
      input.hubspotSync,
    );
    // Fork into a new scenario so the pre-sync state is preserved.
    const syncedInput = { ...input, hubspot: result.hubspot };
    const id = newId();
    const syncDate = new Date().toISOString().slice(0, 10);
    const name = `${activeScenario.name} (HS ${syncDate})`;
    setStore((prev) => ({
      scenarios: [...prev.scenarios, { id, name, overrides: computeOverrides(base, syncedInput) }],
      activeId: id,
    }));
    setReset(syncedInput);
    setLastSyncMeta(result.meta);
    const { meta } = result;
    const parts = [
      `Synced ${meta.dealsApplied}/${meta.dealsApplied + meta.dealsSkipped} deals`,
      `(${meta.counts.sales} Sales + ${meta.counts.changeOrders} CO, ${meta.counts.lineItems} line items)`,
    ];
    if (meta.newLineItemNames.length) parts.push(`+${meta.newLineItemNames.length} new line items`);
    if (meta.unknownStages.length) parts.push(`unknown stages: ${meta.unknownStages.join(', ')}`);
    if (meta.unknownLineItemNames.length) parts.push(`unmapped: ${meta.unknownLineItemNames.length}`);
    const summary = parts.join(' · ');
    addNotification('info', `HubSpot sync: ${summary}`);
    return summary;
  };

  const reset = resetActiveScenario;

  const { modeledTotal, hubspotTotal, grandTotal, employeeTotal, opexTotal, ebitdaTotal } = summary;

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [section, setSection] = useState('web');
  const [renderingViewMode, setRenderingViewMode] = useState<'ui' | 'yaml'>('ui');
  const [renderingHighlightRef, setRenderingHighlightRef] = useState<string | undefined>(undefined);
  const [syncPill, setSyncPill] = useState<string | null>(null);
  const [appMode, setAppMode] = useState<'financial-model' | 'weekly-cashflow'>('financial-model');
  const [cashflowView, setCashflowView] = useState<'cashflow-summary' | 'cashflow-inflows' | 'cashflow-outflows' | 'cashflow-bank'>('cashflow-summary');
  const [cashflowOverrides, setCashflowOverrides] = useState<Record<string, Table>>({});
  const cashflowResult = useMemo(
    () => evaluateModel(weeklyCashflowModel, { prefetchedSources: cashflowOverrides }),
    [cashflowOverrides],
  );
  const currentSection = section;

  const handleCashflowEdit = (edit: import('./report/EngineSection').ReportEdit) => {
    const src = weeklyCashflowModel.sources[edit.source];
    if (!src || src.kind !== 'manual') return;
    const currentRows: Row[] = cashflowOverrides[edit.source]?.rows ?? src.defaults;
    const idCols = Object.keys(edit.identity);
    const updated = currentRows.map(row => {
      const matches = idCols.every(k => String(row[k]) === String(edit.identity[k]));
      if (!matches) return row;
      return { ...row, [edit.col]: edit.value };
    });
    setCashflowOverrides(prev => ({
      ...prev,
      [edit.source]: { schema: src.schema, rows: updated },
    }));
  };

  const CASHFLOW_EDITABLE = new Set(['forecast_items_t', 'capital_events_t']);

  const onNavigateSection = (s: string) => {
    setSection(s);
    if (s === 'web' || s === 'scenarios') {
      // ensure we're on a valid web view
      if (!ALL_VIEWS.includes(view)) setView('total');
    }
  };

  const runXeroSync = async (): Promise<string> => {
    setSyncPill('Fetching Xero actuals…');
    try {
      const res = await fetch('/api/xero/sync');
      const data = await res.json() as import('./xero').XeroSyncResponse;
      if (!data.ok) throw new Error(data.error);
      setSyncPill('Building actuals…');
      const { buildActualsFromXero } = await import('./xero');
      const { actuals: xeroActuals, summary: xeroSummary } = buildActualsFromXero(data, input.dates);
      // Merge bsMonthly: existing manual overrides win for months Xero didn't return data for;
      // Xero bank balances win when present (they have real values).
      const actuals = {
        ...xeroActuals,
        bsMonthly: { ...input.actuals.bsMonthly, ...xeroActuals.bsMonthly },
      };
      const syncedInput = { ...input, actuals };
      const id = newId();
      const syncDate = new Date().toISOString().slice(0, 10);
      const name = `${activeScenario.name} (Xero ${syncDate})`;
      setStore((prev) => ({
        scenarios: [...prev.scenarios, { id, name, overrides: computeOverrides(base, syncedInput) }],
        activeId: id,
      }));
      setReset(syncedInput);
      const disconnected = data.disconnectedOrgs ?? [];
      if (disconnected.length > 0) {
        addNotification('warn', `Xero: ${disconnected.join(', ')} org(s) not connected — re-add in prokura dashboard for full data`);
      }
      addNotification('info', `Xero sync: ${xeroSummary}`);
      setSyncPill(`✓ ${xeroSummary}`);
      setTimeout(() => setSyncPill(null), 6000);
      return xeroSummary;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addNotification('error', `Xero sync failed: ${msg}`);
      setSyncPill(null);
      throw err;
    }
  };

  const systemPrompt = useMemo(() => buildSystemPrompt({
    model: modelForView,
    formulaOverrides,
    scenarios: store.scenarios,
    activeScenarioId: store.activeId,
    engineResult,
  }), [modelForView, formulaOverrides, store.scenarios, store.activeId, engineResult]);

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ''}`}>
      {syncPill && <div className="sync-pill">{syncPill}</div>}
      <AIAssistant
        open={sidebarOpen}
        onMinimize={() => setSidebarOpen(false)}
        onExpand={() => setSidebarOpen(true)}
        systemPrompt={systemPrompt}
        currentSection={currentSection}
        onNavigateSection={onNavigateSection}
        onSetFormula={setFormula}
        onResetFormula={resetFormula}
        onClearFormulaOverrides={clearFormulaOverrides}
        onNavigate={(v) => setView(v as View)}
        onNewScenario={newScenario}
        onSwitchScenario={switchScenario}
        onRenameScenario={renameScenario}
        onDeleteScenario={deleteScenario}
        onQueryTable={(table, limit) => (engineResult.tables[table]?.rows ?? []).slice(0, limit ?? 72)}
        onMenuReset={reset}
        onMenuDownload={async () => {
          const { downloadModelAsExcelViaEngine } = await import('./report/downloadReport');
          await downloadModelAsExcelViaEngine(input);
        }}
        onMenuSync={runHubSpotSync}
        onMenuXeroSync={runXeroSync}
      />
      <header className="app-header">
        <h1>
          {appMode === 'weekly-cashflow' ? 'Bitfount Weekly Cashflow' : 'Bitfount Sales Model'}
        </h1>
        <div className="header-stats">
          {appMode === 'financial-model' && (
            <div className="stat">
              <div className="stat-label">6-year revenue (HubSpot + modeled)</div>
              <div className="stat-value">${Math.round(grandTotal).toLocaleString()}</div>
              <div className="stat-sub">
                ${Math.round(modeledTotal).toLocaleString()} modeled · ${Math.round(hubspotTotal).toLocaleString()} HubSpot
              </div>
            </div>
          )}
          {appMode === 'financial-model' && (
          <div className="undo-group">
            <Button
              onClick={undo}
              disabled={!canUndo}
              size="icon"
              variant="outline"
              title={`Undo (${navigator.platform.includes('Mac') ? '⌘Z' : 'Ctrl+Z'}) — ${historyDepth} change${historyDepth === 1 ? '' : 's'} back`}
              aria-label="Undo"
            >
              ↶
            </Button>
            <Button
              onClick={redo}
              disabled={!canRedo}
              size="icon"
              variant="outline"
              title={`Redo (${navigator.platform.includes('Mac') ? '⇧⌘Z' : 'Ctrl+Shift+Z'})`}
              aria-label="Redo"
            >
              ↷
            </Button>
          </div>
          )}
          <NotificationsPanel
            notifications={notifications}
            onClear={() => setNotifications([])}
          />
          <HeaderMenu
            onReset={reset}
            onDownload={async () => {
              const { downloadModelAsExcelViaEngine } = await import('./report/downloadReport');
              await downloadModelAsExcelViaEngine(input);
            }}
            onSync={runHubSpotSync}
            onXeroSync={runXeroSync}
            savedModels={savedModels}
            onSaveCurrentModel={saveCurrentModel}
            onLoadModel={loadSavedModel}
            onDeleteModel={deleteSavedModel}
            appMode={appMode}
            onSetAppMode={setAppMode}
          />
        </div>
      </header>

      {appMode === 'weekly-cashflow' && currentSection === 'web' && (
        <div className="view-tabs" role="tablist">
          {([
            { id: 'cashflow-summary', label: 'Cash Summary' },
            { id: 'cashflow-inflows', label: 'Inflows' },
            { id: 'cashflow-outflows', label: 'Outflows' },
            { id: 'cashflow-bank', label: 'Bank Accounts' },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={cashflowView === tab.id}
              className={`view-tab ${cashflowView === tab.id ? 'active' : ''}`}
              onClick={() => setCashflowView(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {appMode === 'weekly-cashflow' && currentSection === 'web' && (
        <EngineSection
          report={cashflowReport}
          evalResult={cashflowResult}
          model={weeklyCashflowModel}
          sectionId={cashflowView}
        />
      )}

      {appMode === 'weekly-cashflow' && currentSection === 'engine' && (
        <EnginePreview
          model={weeklyCashflowModel}
          result={cashflowResult}
          currentRef={engineRef}
          onRefChange={setEngineRef}
          identityFor={(ref) => SOURCE_IDENTITY[ref] ?? []}
          editableSources={CASHFLOW_EDITABLE}
          onEdit={handleCashflowEdit}
        />
      )}

      {appMode === 'weekly-cashflow' && currentSection === 'rendering' && (
        <>
          <section>
            <div className="ta-summary">
              <span className="ta-name">Rendering Engine</span>
              <span className="ta-total">
                {((cashflowReportYamlRaw as { sections?: unknown[] })?.sections ?? []).length} sections
              </span>
            </div>
            <p className="hint">
              Report layout defined in <code>src/report/cashflow_report.yaml</code>.
            </p>
            <div className="engine-view-tabs">
              {(['ui', 'yaml'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`engine-view-tab-btn${renderingViewMode === tab ? ' is-active' : ''}`}
                  onClick={() => { setRenderingViewMode(tab); if (tab !== 'yaml') setRenderingHighlightRef(undefined); }}
                >
                  {tab === 'ui' ? 'Editor' : 'YAML'}
                </button>
              ))}
            </div>
          </section>
          {renderingViewMode === 'ui' ? (
            <ReportDefinitionEditor
              rawReport={cashflowReportYamlRaw}
              idPrefix=""
              onSave={async (data) => {
                const r = await fetch('/api/cashflow-report/save', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ data }),
                }).then((res) => res.json()) as { ok: boolean; error?: string };
                if (!r.ok) throw new Error(r.error);
              }}
              onViewInYaml={(sectionId) => {
                setRenderingViewMode('yaml');
                setRenderingHighlightRef(sectionId);
                setTimeout(() => {
                  document.getElementById(`yaml-ref-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
              }}
            />
          ) : (
            <section>
              <YamlViewer
                data={cashflowReportYamlRaw}
                anchorRefs={new Set(((cashflowReportYamlRaw as { sections?: { id?: string }[] })?.sections ?? []).map(s => s.id ?? '').filter(Boolean))}
                highlightRef={renderingHighlightRef}
              />
            </section>
          )}
        </>
      )}

      {appMode === 'financial-model' && currentSection === 'web' && (
        <section>
          <div className="ta-summary">
            <span className="ta-name">Web View</span>
            <span className="ta-total">
              EBITDA ${(ebitdaTotal / 1e6).toFixed(1)}M · {store.scenarios.length} scenario{store.scenarios.length !== 1 ? 's' : ''}
            </span>
          </div>
          <ScenarioBar
            scenarios={store.scenarios}
            activeId={store.activeId}
            onSwitch={switchScenario}
            onNew={newScenario}
            onRename={renameScenario}
            onDelete={deleteScenario}
            onResetActive={resetActiveScenario}
          />
          {evalError && (
            <div className="model-error-banner" role="alert">
              <span>
                <strong>Model edits couldn't be applied:</strong> {evalError} — showing the base model.
              </span>
              <Button variant="outline" size="sm" onClick={clearFormulaOverrides}>Clear all model edits</Button>
            </div>
          )}
        </section>
      )}

      {appMode === 'financial-model' && currentSection === 'engine' && (
        <EnginePreview
          model={modelForView}
          result={engineResult}
          currentRef={engineRef}
          onRefChange={setEngineRef}
          onEdit={handleReportEdit}
          editableSources={EDITABLE_SOURCES}
          identityFor={(ref) => SOURCE_IDENTITY[ref] ?? []}
          formulaEdit={{
            overrides: formulaOverrides,
            enabled: store.activeId === store.scenarios[0]?.id,
            onSet: setFormula,
            onReset: resetFormula,
          }}
          onApiSync={async (adapterName) => {
            if (adapterName === 'hubspot_pipeline') {
              await runHubSpotSync();
            } else if (adapterName === 'xero_actuals' || adapterName === 'xero_cost_line') {
              await runXeroSync();
            } else {
              throw new Error(`No sync handler for adapter "${adapterName}"`);
            }
          }}
        />
      )}

      {appMode === 'financial-model' && currentSection === 'rendering' && (
        <>
          <section>
            <div className="ta-summary">
              <span className="ta-name">Rendering Engine</span>
              <span className="ta-total">
                {((reportYamlRaw as { tabs?: unknown[] })?.tabs ?? []).length} tabs ·{' '}
                {((reportYamlRaw as { sections?: unknown[] })?.sections ?? []).length} sections
              </span>
            </div>
            <p className="hint">
              Report layout defined in <code>src/report/report.yaml</code>. Tabs reference sections by id; each section
              contains an ordered list of blocks (tables, charts, titles) rendered in the web view.
            </p>
            <div className="engine-view-tabs">
              {(['ui', 'yaml'] as const).map((tab) => (
                <button
                  key={tab}
                  className={`engine-view-tab-btn${renderingViewMode === tab ? ' is-active' : ''}`}
                  onClick={() => { setRenderingViewMode(tab); if (tab !== 'yaml') setRenderingHighlightRef(undefined); }}
                >
                  {tab === 'ui' ? 'Editor' : 'YAML'}
                </button>
              ))}
            </div>
          </section>
          {renderingViewMode === 'ui' ? (
            <ReportDefinitionEditor
              rawReport={reportYamlRaw}
              idPrefix="yaml-"
              onSave={async (data) => {
                const r = await fetch('/api/report/save', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ data }),
                }).then((res) => res.json()) as { ok: boolean; error?: string };
                if (!r.ok) throw new Error(r.error);
              }}
              onViewInYaml={(sectionId) => {
                setRenderingViewMode('yaml');
                setRenderingHighlightRef(sectionId);
                setTimeout(() => {
                  document.getElementById(`yaml-ref-${sectionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 50);
              }}
            />
          ) : (
            <section>
              <YamlViewer
                data={reportYamlRaw}
                anchorRefs={new Set(((reportYamlRaw as { sections?: { id?: string }[] })?.sections ?? []).map(s => s.id ?? '').filter(Boolean))}
                highlightRef={renderingHighlightRef}
              />
            </section>
          )}
        </>
      )}

      {appMode === 'financial-model' && currentSection === 'web' && <div className="view-tabs" role="tablist">
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
      </div>}

      {appMode === 'financial-model' && currentSection === 'web' && (view === 'model' ? (
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
        <>
          <StaffOverTimeSection input={input} />
          <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="employees" onEdit={handleReportEdit} />
        </>
      ) : view === 'costs' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="costs" onEdit={handleReportEdit} />
      ) : view === 'balance-sheet' ? (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="balance-sheet" onEdit={handleReportEdit} />
      ) : (
        <EngineSection report={salesReport} evalResult={engineResult} model={salesModel} sectionId="budget" onEdit={handleReportEdit} />
      ))}

    </div>
  );
}

interface HeaderMenuProps {
  onReset: () => void;
  onDownload: () => Promise<void> | void;
  onSync: () => Promise<string>;
  onXeroSync: () => Promise<string>;
  savedModels: SavedModel[];
  onSaveCurrentModel: (name: string) => void;
  onLoadModel: (model: SavedModel) => void;
  onDeleteModel: (id: string) => void;
  appMode: 'financial-model' | 'weekly-cashflow';
  onSetAppMode: (mode: 'financial-model' | 'weekly-cashflow') => void;
}

function HeaderMenu({ onReset, onDownload, onSync, onXeroSync, savedModels, onSaveCurrentModel, onLoadModel, onDeleteModel, appMode, onSetAppMode }: HeaderMenuProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [saveModelName, setSaveModelName] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const yamlRef = useRef<HTMLInputElement>(null);

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

  const handleXeroSync = async () => {
    setOpen(false);
    setStatus('Fetching Xero actuals…');
    try {
      setStatus(`Created scenario · ${await onXeroSync()}`);
    } catch (err) {
      setStatus(`Xero sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 8000);
  };

  const handleYamlExport = async () => {
    setOpen(false);
    setStatus('Exporting YAMLs…');
    try {
      const res = await fetch('/api/yaml/export');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'model-config.zip';
      a.click();
      URL.revokeObjectURL(url);
      setStatus('Exported model-config.zip');
    } catch (err) {
      setStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 4000);
  };

  const handleYamlImportClick = () => {
    setOpen(false);
    yamlRef.current?.click();
  };

  const handleYamlImportChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setStatus(`Importing ${file.name}…`);
    try {
      const res = await fetch('/api/yaml/import', {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: file,
      });
      const data = await res.json() as { ok: boolean; written?: string[]; error?: string };
      if (!data.ok) throw new Error(data.error);
      const modelName = file.name.replace(/\.zip$/i, '');
      onSaveCurrentModel(modelName);
      setStatus(`Imported ${file.name} · saved as model "${modelName}"`);
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setStatus(null), 5000);
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
      <Button
        size="icon"
        variant="outline"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ☰
      </Button>
      {open && (
        <div className="menu-dropdown" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); setModelModalOpen(true); }}>
            Load Model…
          </button>
          <div className="menu-separator" />
          <button role="menuitem" className="menu-item" onClick={handleSync}>
            Sync from HubSpot
          </button>
          <button role="menuitem" className="menu-item" onClick={handleXeroSync}>
            Sync Xero actuals
          </button>
          <button role="menuitem" className="menu-item" onClick={handleDownload}>
            Download as Excel
          </button>
          <button role="menuitem" className="menu-item" onClick={handleYamlExport}>
            Export config (YAML zip)
          </button>
          <button role="menuitem" className="menu-item" onClick={handleYamlImportClick}>
            Import config (YAML zip)…
          </button>
          <button role="menuitem" className="menu-item" onClick={handleUploadClick}>
            Upload file…
          </button>
          <button role="menuitem" className="menu-item" onClick={handleReset}>
            Reset to Excel defaults
          </button>
        </div>
      )}
      <Modal open={modelModalOpen} onClose={() => setModelModalOpen(false)} title="Load Model" maxWidth={580}>
        <div style={{ padding: '16px 24px 24px' }}>

          {/* ── Built-in models ── */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Models
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <tbody>
                {([
                  { id: 'financial-model' as const, name: 'Bitfount v4 Financial Model', desc: 'Monthly P&L, balance sheet, scenario modelling' },
                  { id: 'weekly-cashflow' as const, name: 'Weekly Cashflow', desc: '98-week cash forecast — inflows, outflows, bank reconciliation' },
                ] as Array<{ id: 'financial-model' | 'weekly-cashflow'; name: string; desc: string }>).map((m) => (
                  <tr key={m.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 8px' }}>
                      <div style={{ fontSize: 13, fontWeight: appMode === m.id ? 700 : 400 }}>
                        {m.name}
                        {appMode === m.id && <span style={{ marginLeft: 8, fontSize: 10, background: '#dbeafe', color: '#1e40af', padding: '1px 6px', borderRadius: 10, fontWeight: 500 }}>active</span>}
                      </div>
                      <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{m.desc}</div>
                    </td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <Button
                        variant={appMode === m.id ? 'default' : 'outline'}
                        size="sm"
                        disabled={appMode === m.id}
                        onClick={() => { onSetAppMode(m.id); setModelModalOpen(false); }}
                      >
                        {appMode === m.id ? 'Loaded' : 'Load'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── User snapshots (financial model only) ── */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Saved Snapshots (Financial Model)
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Name for current model state…"
                value={saveModelName}
                onChange={(e) => setSaveModelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && saveModelName.trim()) {
                    onSaveCurrentModel(saveModelName.trim());
                    setSaveModelName('');
                  }
                }}
                style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 13 }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!saveModelName.trim()}
                onClick={() => { onSaveCurrentModel(saveModelName.trim()); setSaveModelName(''); }}
              >
                Save current
              </Button>
            </div>
            {savedModels.length === 0 ? (
              <p className="hint" style={{ margin: 0 }}>No snapshots yet — type a name above and click Save current to capture the current scenarios and formula overrides.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500, fontSize: 12, color: '#888' }}>Name</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500, fontSize: 12, color: '#888' }}>Saved</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {savedModels.map((model) => (
                    <tr key={model.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 8px', fontSize: 13 }}>{model.name}</td>
                      <td style={{ padding: '8px 8px', fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>
                        {new Date(model.savedAt).toLocaleString()}
                      </td>
                      <td style={{ padding: '8px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { onLoadModel(model); onSetAppMode('financial-model'); setModelModalOpen(false); }}
                          >
                            Load
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onDeleteModel(model.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
            </table>
          )}
          </div>
        </div>
      </Modal>
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <input
        ref={yamlRef}
        type="file"
        accept=".zip"
        style={{ display: 'none' }}
        onChange={handleYamlImportChange}
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
          <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync from HubSpot'}
          </Button>
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
  type DealSortKey = 'name' | 'ta' | 'expected' | 'amount' | 'predicted' | 'prob' | 'stage' | 'duration';
  const [sortKey, setSortKey] = useState<DealSortKey>('stage');
  const [sortDesc, setSortDesc] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'applied' | 'skipped'>('all');
  const [openModal, setOpenModal] = useState<null | 'current' | 'expected'>(null);
  const [view, setView] = useState<'deals' | 'pricing'>('deals');
  const [hubspotAmountGtZero, setHubspotAmountGtZero] = useState(true);

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
        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync from HubSpot'}
        </Button>
      </section>
    );
  }

  const preFilter = lastSyncMeta.deals
    .filter((d) => statusFilter === 'all' || d.status === statusFilter);
  const hiddenZeroCount = hubspotAmountGtZero
    ? preFilter.filter((d) => !(d.hubspotAmount != null && d.hubspotAmount > 0)).length
    : 0;
  const deals = preFilter
    .filter((d) => !hubspotAmountGtZero || (d.hubspotAmount != null && d.hubspotAmount > 0))
    .slice()
    .sort((a, b) => {
      const dir = sortDesc ? -1 : 1;
      switch (sortKey) {
        case 'name': return a.name.localeCompare(b.name) * dir;
        case 'ta': return a.therapeuticArea.localeCompare(b.therapeuticArea) * dir;
        case 'expected': return (a.expectedAmount - b.expectedAmount) * dir;
        case 'amount': return (a.amountReported - b.amountReported) * dir;
        case 'predicted':
          return ((a.closeDatePredicted ?? '') < (b.closeDatePredicted ?? '') ? -1 : 1) * dir;
        case 'prob': return (a.closeProbability - b.closeProbability) * dir;
        case 'duration': return (a.durationMonths - b.durationMonths) * dir;
        case 'stage': {
          // Stage progression — rank by the stage's close probability so the
          // latest pipeline stages (closest to Closed Won) come first when
          // descending. Tiebreaker: stage label, then deal name.
          const probCmp = a.closeProbability - b.closeProbability;
          if (probCmp !== 0) return probCmp * dir;
          const stageCmp = a.stageLabel.localeCompare(b.stageLabel);
          if (stageCmp !== 0) return stageCmp * dir;
          return a.name.localeCompare(b.name) * dir;
        }
      }
    });

  const totalExpected = deals.reduce((s, d) => s + d.expectedAmount, 0);
  const totalAmount = deals.reduce((s, d) => s + d.amountReported, 0);

  const downloadExcel = async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Bitfount Sales Model';
    wb.created = new Date();
    const sheet = wb.addWorksheet('HubSpot Deals');

    sheet.columns = [
      { header: 'Deal', key: 'name', width: 48 },
      { header: 'Pipeline', key: 'pipeline', width: 18 },
      { header: 'Stage', key: 'stage', width: 22 },
      { header: 'TA', key: 'ta', width: 14 },
      { header: 'Amount', key: 'amount', width: 16, style: { numFmt: '"$"#,##0' } },
      { header: 'Close probability', key: 'prob', width: 16, style: { numFmt: '0.0%' } },
      { header: 'Expected', key: 'expected', width: 16, style: { numFmt: '"$"#,##0' } },
      { header: 'Close (HubSpot)', key: 'closeHs', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
      { header: 'Close (predicted)', key: 'closePred', width: 16, style: { numFmt: 'yyyy-mm-dd' } },
      { header: 'Duration (months)', key: 'duration', width: 16, style: { numFmt: '0' } },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Skip reason', key: 'skip', width: 32 },
    ];
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

    const parseDate = (s: string | null): Date | null => {
      if (!s) return null;
      const d = new Date(s + 'T00:00:00Z');
      return isNaN(d.getTime()) ? null : d;
    };

    deals.forEach((d, i) => {
      const rowNumber = i + 2;
      const row = sheet.addRow({
        name: d.name,
        pipeline: d.pipelineLabel,
        stage: d.stageLabel,
        ta: d.therapeuticArea,
        amount: d.amountReported,
        prob: d.closeProbability,
        closeHs: parseDate(d.closeDateHubSpot),
        closePred: parseDate(d.closeDatePredicted),
        duration: d.durationMonths,
        status: d.status,
        skip: d.skipReason ?? '',
      });
      row.getCell('expected').value = { formula: `E${rowNumber}*F${rowNumber}` };
    });

    const totalRow = sheet.addRow({});
    totalRow.font = { bold: true };
    totalRow.getCell('name').value = 'TOTAL';
    const lastDataRow = deals.length + 1;
    totalRow.getCell('amount').value = { formula: `SUM(E2:E${lastDataRow})` };
    totalRow.getCell('expected').value = { formula: `SUM(G2:G${lastDataRow})` };

    // ── Sheet 2: Pricing — one row per deal × one column per line item ──
    const pricingDeals = deals.filter((d) => d.lineItems.length > 0);
    if (pricingDeals.length > 0) {
      const pricingSheet = wb.addWorksheet('Pricing');

      // Discover line items with at least one non-zero value, sorted by
      // configured order (unknown → end, then alphabetical).
      const lineItemNamesSet = new Set<string>();
      const valuesByDeal = new Map<string, Record<string, number>>();
      for (const d of pricingDeals) {
        const byName: Record<string, number> = {};
        for (const li of d.lineItems) byName[li.name] = (byName[li.name] || 0) + li.value;
        valuesByDeal.set(d.id, byName);
        for (const [n, v] of Object.entries(byName)) if (v !== 0) lineItemNamesSet.add(n);
      }
      const lineItemNames = [...lineItemNamesSet].sort((a, b) => {
        const oa = getLineItemConfig(a).order;
        const ob = getLineItemConfig(b).order;
        if (oa !== ob) return oa - ob;
        return a.localeCompare(b);
      });

      pricingSheet.columns = [
        { header: 'Deal', key: 'name', width: 48 },
        { header: 'TA', key: 'ta', width: 16 },
        { header: 'Stage', key: 'stage', width: 22 },
        { header: 'Sites', key: 'sites', width: 8, style: { numFmt: '0' } },
        { header: 'Patients', key: 'patients', width: 10, style: { numFmt: '0' } },
        { header: 'Duration (months)', key: 'duration', width: 14, style: { numFmt: '0' } },
        { header: 'Close probability', key: 'prob', width: 14, style: { numFmt: '0.0%' } },
        { header: 'Close (predicted)', key: 'closePred', width: 16, style: { numFmt: 'yyyy-mm-dd' } },
        ...lineItemNames.map((n) => ({
          header: n,
          key: `li:${n}`,
          width: 20,
          style: { numFmt: '"$"#,##0' },
        })),
        { header: 'List Total', key: 'listTotal', width: 16, style: { numFmt: '"$"#,##0' } },
        { header: 'Discount', key: 'discount', width: 14, style: { numFmt: '"$"#,##0;[Red]-"$"#,##0' } },
        { header: 'HubSpot Total', key: 'hubspotTotal', width: 16, style: { numFmt: '"$"#,##0' } },
        { header: 'Calc Total', key: 'calcTotal', width: 16, style: { numFmt: '"$"#,##0' } },
        { header: 'Δ (HubSpot − Calc)', key: 'diff', width: 18, style: { numFmt: '"$"#,##0;[Red]-"$"#,##0' } },
      ];
      pricingSheet.getRow(1).font = { bold: true };
      pricingSheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
      pricingSheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: pricingSheet.columns.length },
      };

      // First per-line-item column index (1-based, after the 8 fixed columns)
      const firstLiColIdx = 9;
      const lastLiColIdx = firstLiColIdx + lineItemNames.length - 1;
      const listColIdx = lastLiColIdx + 1;
      const discountColIdx = lastLiColIdx + 2;
      const hubspotColIdx = lastLiColIdx + 3;
      const calcColIdx = lastLiColIdx + 4;
      const diffColIdx = lastLiColIdx + 5;

      const sorted = [...pricingDeals].sort((a, b) => b.amountReported - a.amountReported);
      sorted.forEach((d, i) => {
        const rowNum = i + 2;
        const byName = valuesByDeal.get(d.id) || {};
        const rowData: Record<string, unknown> = {
          name: d.name,
          ta: d.therapeuticArea,
          stage: d.stageLabel,
          sites: countByUnit(d, 'site') || null,
          patients: countByUnit(d, 'patient') || null,
          duration: d.durationMonths,
          prob: d.closeProbability,
          closePred: parseDate(d.closeDatePredicted),
        };
        for (const n of lineItemNames) rowData[`li:${n}`] = byName[n] || 0;
        rowData.listTotal = d.listTotal;
        rowData.discount = -d.discountTotal;
        if (d.hubspotAmount != null) rowData.hubspotTotal = d.hubspotAmount;
        const r = pricingSheet.addRow(rowData);
        const firstLetter = colLetter(firstLiColIdx);
        const lastLetter = colLetter(lastLiColIdx);
        r.getCell(calcColIdx).value = { formula: `SUM(${firstLetter}${rowNum}:${lastLetter}${rowNum})` };
        if (d.hubspotAmount != null) {
          r.getCell(diffColIdx).value = {
            formula: `${colLetter(hubspotColIdx)}${rowNum}-${colLetter(calcColIdx)}${rowNum}`,
          };
        }
      });

      const lastPricingRow = sorted.length + 1;
      const pricingTotalRow = pricingSheet.addRow({});
      pricingTotalRow.font = { bold: true };
      pricingTotalRow.getCell('name').value = 'TOTAL';
      pricingTotalRow.getCell('sites').value = { formula: `SUM(D2:D${lastPricingRow})` };
      pricingTotalRow.getCell('patients').value = { formula: `SUM(E2:E${lastPricingRow})` };
      for (let i = 0; i < lineItemNames.length; i++) {
        const letter = colLetter(firstLiColIdx + i);
        pricingTotalRow.getCell(firstLiColIdx + i).value = {
          formula: `SUM(${letter}2:${letter}${lastPricingRow})`,
        };
      }
      pricingTotalRow.getCell(listColIdx).value = {
        formula: `SUM(${colLetter(listColIdx)}2:${colLetter(listColIdx)}${lastPricingRow})`,
      };
      pricingTotalRow.getCell(discountColIdx).value = {
        formula: `SUM(${colLetter(discountColIdx)}2:${colLetter(discountColIdx)}${lastPricingRow})`,
      };
      pricingTotalRow.getCell(hubspotColIdx).value = {
        formula: `SUM(${colLetter(hubspotColIdx)}2:${colLetter(hubspotColIdx)}${lastPricingRow})`,
      };
      pricingTotalRow.getCell(calcColIdx).value = {
        formula: `SUM(${colLetter(calcColIdx)}2:${colLetter(calcColIdx)}${lastPricingRow})`,
      };
      pricingTotalRow.getCell(diffColIdx).value = {
        formula: `${colLetter(hubspotColIdx)}${lastPricingRow + 1}-${colLetter(calcColIdx)}${lastPricingRow + 1}`,
      };
    }

    // ── Sheet 3: Project Configuration projection by month ──
    const pcByMonth = new Map<string, { expected: number; total: number; deals: number }>();
    for (const d of deals) {
      if (!d.closeDatePredicted) continue;
      let pc = 0;
      for (const li of d.lineItems) {
        if (highLevelType(li.name) === 'Project Configuration') pc += li.value;
      }
      if (pc === 0) continue;
      const month = d.closeDatePredicted.slice(0, 7);
      const cur = pcByMonth.get(month) ?? { expected: 0, total: 0, deals: 0 };
      cur.total += pc;
      cur.expected += pc * d.closeProbability;
      cur.deals += 1;
      pcByMonth.set(month, cur);
    }
    if (pcByMonth.size > 0) {
      const pcSheet = wb.addWorksheet('Project Config Projection');
      pcSheet.columns = [
        { header: 'Month', key: 'month', width: 12, style: { numFmt: 'yyyy-mm' } },
        { header: 'Deals', key: 'deals', width: 8, style: { numFmt: '0' } },
        { header: 'Contracted', key: 'total', width: 16, style: { numFmt: '"$"#,##0' } },
        { header: 'Expected', key: 'expected', width: 16, style: { numFmt: '"$"#,##0' } },
      ];
      pcSheet.getRow(1).font = { bold: true };
      pcSheet.views = [{ state: 'frozen', ySplit: 1 }];

      const sortedMonths = [...pcByMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      sortedMonths.forEach(([month, v]) => {
        pcSheet.addRow({
          month: parseDate(month + '-01'),
          deals: v.deals,
          total: v.total,
          expected: v.expected,
        });
      });
      const lastPcRow = sortedMonths.length + 1;
      const pcTotalRow = pcSheet.addRow({});
      pcTotalRow.font = { bold: true };
      pcTotalRow.getCell('month').value = 'TOTAL';
      pcTotalRow.getCell('deals').value = { formula: `SUM(B2:B${lastPcRow})` };
      pcTotalRow.getCell('total').value = { formula: `SUM(C2:C${lastPcRow})` };
      pcTotalRow.getCell('expected').value = { formula: `SUM(D2:D${lastPcRow})` };
    }

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hubspot-deals-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Text-ish columns default to ascending (A→Z); everything else (numbers,
  // dates, stage progression) defaults to descending so the most interesting
  // rows surface at the top on first click.
  const textKeys: DealSortKey[] = ['name', 'ta'];
  const headerSort = (key: DealSortKey, label: string) => (
    <th
      style={{ cursor: 'pointer', userSelect: 'none' }}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else { setSortKey(key); setSortDesc(!textKeys.includes(key)); }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  const history = contractValueHistory(lastSyncMeta.deals);
  const historySeries = history.map((r) => ({
    key: r.monthStart.slice(0, 7),
    value: r.totalCV,
    tooltip: `${formatBucketLabel(r.monthStart.slice(0, 7), 'month')} · ${r.liveCount} live deals · ${formatShortMoney(r.totalCV)}`,
  }));
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
          start. TCV = sum of (unit price × quantity) across the deal's line items. Hover a bar for the live-deal count.
        </p>
        <TimeBarChart series={historySeries} bucket="month" />
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
          <Button variant="outline" size="sm" onClick={() => setOpenModal('current')}>Show raw data</Button>
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
          <Button variant="outline" size="sm" onClick={() => setOpenModal('expected')}>Show raw data</Button>
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
        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Re-sync'}
        </Button>
        <Button variant="outline" size="sm" onClick={downloadExcel} disabled={deals.length === 0}>
          Download Excel
        </Button>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="hint" style={{ margin: 0 }}>Show:</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All ({lastSyncMeta.deals.length})</option>
            <option value="applied">Applied ({lastSyncMeta.dealsApplied})</option>
            <option value="skipped">Skipped ({lastSyncMeta.dealsSkipped})</option>
          </select>
        </label>
        <label
          style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}
          title="Hide deals where HubSpot's deal-level amount is null or 0 — these are typically duplicate / placeholder records for trials we've already captured under another deal."
        >
          <input
            type="checkbox"
            checked={hubspotAmountGtZero}
            onChange={(e) => setHubspotAmountGtZero(e.target.checked)}
          />
          <span>HubSpot amount &gt; 0</span>
          {hubspotAmountGtZero && hiddenZeroCount > 0 && (
            <span className="hint" style={{ margin: 0 }}>
              (−{hiddenZeroCount} hidden)
            </span>
          )}
        </label>
        <div role="tablist" style={{ display: 'flex', gap: 0, marginLeft: 'auto' }}>
          <Button
            role="tab"
            aria-selected={view === 'deals'}
            variant={view === 'deals' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView('deals')}
          >
            Deals
          </Button>
          <Button
            role="tab"
            aria-selected={view === 'pricing'}
            variant={view === 'pricing' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView('pricing')}
          >
            Pricing
          </Button>
        </div>
        <span className="hint" style={{ margin: 0 }}>
          Last sync: {new Date(lastSyncMeta.fetchedAt).toLocaleString()}
        </span>
      </div>
      {view === 'deals' && (
      <table className="yearly-emp-table">
        <thead>
          <tr>
            {headerSort('name', 'Deal')}
            <th>Pipeline</th>
            {headerSort('stage', 'Stage')}
            {headerSort('ta', 'TA')}
            {headerSort('amount', 'Amount')}
            {headerSort('prob', 'Close prob')}
            {headerSort('expected', 'Expected')}
            <th>Close (HubSpot)</th>
            {headerSort('predicted', 'Close (predicted)')}
            {headerSort('duration', 'Duration')}
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
      )}
      {view === 'pricing' && <PricingView deals={deals} />}
      </section>
    </>
  );
}

interface PricingViewProps {
  deals: import('./hubspot').PerDealSummary[];
}

/** Derive site / patient counts from the manually-classified line items.
 *  Site- and patient-quantified line items share the same count across a
 *  deal (e.g. "Site Setup" and "PI Site Setup Fee" both carry the site
 *  count), so max is the right reducer. */
function countByUnit(
  deal: PricingViewProps['deals'][number],
  unit: 'site' | 'patient',
): number {
  let max = 0;
  for (const li of deal.lineItems) {
    if (getLineItemConfig(li.name).unit === unit && li.quantity > max) max = li.quantity;
  }
  return max;
}

/** Sum of `unitPrice × quantity` per line item name on a deal. Returns a
 *  map keyed by line item name. Same name can appear multiple times on a
 *  deal (rare but possible), so we sum. */
function lineItemValuesByName(
  deal: PricingViewProps['deals'][number],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const li of deal.lineItems) out[li.name] = (out[li.name] || 0) + li.value;
  return out;
}

type PricingSortKey =
  | 'name' | 'ta' | 'stage' | 'sites' | 'patients' | 'duration'
  | 'list' | 'discount' | 'hubspot' | 'calc' | 'diff';

const PRICING_TEXT_KEYS: PricingSortKey[] = ['name', 'ta'];

function PricingView({ deals }: PricingViewProps) {
  const [bucket, setBucket] = useState<Bucket>('halfyear');
  const [sortKey, setSortKey] = useState<PricingSortKey>('stage');
  const [sortDesc, setSortDesc] = useState(true);

  const unsortedRows = useMemo(
    () => deals
      .filter((d) => d.lineItems.length > 0)
      .map((d) => {
        const byName = lineItemValuesByName(d);
        const calcTotal = Object.values(byName).reduce((s, v) => s + v, 0);
        return {
          deal: d,
          sites: countByUnit(d, 'site'),
          patients: countByUnit(d, 'patient'),
          byName,
          listTotal: d.listTotal,
          discount: d.discountTotal,
          calcTotal,
          hubspotTotal: d.hubspotAmount,
        };
      }),
    [deals],
  );

  const rows = useMemo(() => {
    const dir = sortDesc ? -1 : 1;
    // Nulls always sort last (regardless of direction), so HubSpot/Δ rows
    // without an upstream value don't hijack the top of the list.
    const nullCmp = (an: number | null, bn: number | null): number | null => {
      if (an == null && bn == null) return 0;
      if (an == null) return 1;
      if (bn == null) return -1;
      return null;
    };
    return [...unsortedRows].sort((a, b) => {
      switch (sortKey) {
        case 'name': return a.deal.name.localeCompare(b.deal.name) * dir;
        case 'ta': return a.deal.therapeuticArea.localeCompare(b.deal.therapeuticArea) * dir;
        case 'sites': return (a.sites - b.sites) * dir;
        case 'patients': return (a.patients - b.patients) * dir;
        case 'duration': return (a.deal.durationMonths - b.deal.durationMonths) * dir;
        case 'list': return (a.listTotal - b.listTotal) * dir;
        case 'discount': return (a.discount - b.discount) * dir;
        case 'calc': return (a.calcTotal - b.calcTotal) * dir;
        case 'hubspot': {
          const n = nullCmp(a.hubspotTotal, b.hubspotTotal);
          return n != null ? n : (a.hubspotTotal! - b.hubspotTotal!) * dir;
        }
        case 'diff': {
          const da = a.hubspotTotal == null ? null : a.hubspotTotal - a.calcTotal;
          const db = b.hubspotTotal == null ? null : b.hubspotTotal - b.calcTotal;
          const n = nullCmp(da, db);
          return n != null ? n : (da! - db!) * dir;
        }
        case 'stage': {
          const probCmp = a.deal.closeProbability - b.deal.closeProbability;
          if (probCmp !== 0) return probCmp * dir;
          const stageCmp = a.deal.stageLabel.localeCompare(b.deal.stageLabel);
          if (stageCmp !== 0) return stageCmp * dir;
          return a.deal.name.localeCompare(b.deal.name) * dir;
        }
      }
    });
  }, [unsortedRows, sortKey, sortDesc]);

  const headerSort = (key: PricingSortKey, label: string, extraStyle?: CSSProperties) => (
    <th
      style={{ cursor: 'pointer', userSelect: 'none', ...extraStyle }}
      onClick={() => {
        if (sortKey === key) setSortDesc(!sortDesc);
        else { setSortKey(key); setSortDesc(!PRICING_TEXT_KEYS.includes(key)); }
      }}
    >
      {label} {sortKey === key ? (sortDesc ? '↓' : '↑') : ''}
    </th>
  );

  // Discover the set of line items that have at least one non-zero value
  // across the visible deals, then sort by config order (unknown items go
  // to the end).
  const lineItemNames = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) for (const [name, v] of Object.entries(r.byName)) {
      if (v !== 0) s.add(name);
    }
    return [...s].sort((a, b) => {
      const oa = getLineItemConfig(a).order;
      const ob = getLineItemConfig(b).order;
      if (oa !== ob) return oa - ob;
      return a.localeCompare(b);
    });
  }, [rows]);

  const unclassified = useMemo(
    () => lineItemNames.filter((n) => !isClassified(n)),
    [lineItemNames],
  );

  const totalsByName = useMemo(() => {
    const t: Record<string, number> = {};
    for (const r of rows) for (const n of lineItemNames) t[n] = (t[n] || 0) + (r.byName[n] || 0);
    return t;
  }, [rows, lineItemNames]);

  // Project Configuration fees over time. Payment schedule is 'Start' for the
  // PC family, so the full expected value lands in the deal's predicted close
  // month. Expected = raw value × close probability.
  const projection = useMemo(() => {
    const byKey = new Map<string, { expected: number; total: number; deals: number }>();
    const keyFor = (iso: string): string => {
      const y = iso.slice(0, 4);
      const m = parseInt(iso.slice(5, 7), 10);
      if (bucket === 'month') return iso.slice(0, 7);
      if (bucket === 'halfyear') return `${y} H${m <= 6 ? 1 : 2}`;
      return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
    };
    for (const d of deals) {
      if (!d.closeDatePredicted) continue;
      const key = keyFor(d.closeDatePredicted);
      let pcTotal = 0;
      for (const li of d.lineItems) {
        if (highLevelType(li.name) === 'Project Configuration') pcTotal += li.value;
      }
      if (pcTotal === 0) continue;
      const cur = byKey.get(key) ?? { expected: 0, total: 0, deals: 0 };
      cur.total += pcTotal;
      cur.expected += pcTotal * d.closeProbability;
      cur.deals += 1;
      byKey.set(key, cur);
    }
    return [...byKey.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [deals, bucket]);

  const projectionTotal = projection.reduce((s, r) => s + r.expected, 0);
  const projectionRawTotal = projection.reduce((s, r) => s + r.total, 0);

  // Dense series spanning min→max bucket, with gaps filled by 0, then
  // mapped into the generic shape TimeBarChart expects.
  const chartSeries = useMemo(() => {
    if (projection.length === 0) return [] as { key: string; value: number; tooltip: string }[];
    const byKey = new Map(projection.map((r) => [r.key, r] as const));
    const dense: { key: string; expected: number; total: number }[] = [];
    if (bucket === 'month') {
      const [sy, sm] = projection[0].key.split('-').map((s) => parseInt(s, 10));
      const [ey, em] = projection[projection.length - 1].key.split('-').map((s) => parseInt(s, 10));
      let y = sy;
      let m = sm;
      while (y < ey || (y === ey && m <= em)) {
        const k = `${y}-${String(m).padStart(2, '0')}`;
        const v = byKey.get(k);
        dense.push({ key: k, expected: v?.expected || 0, total: v?.total || 0 });
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      }
    } else if (bucket === 'halfyear') {
      const parseH = (k: string) => {
        const [y, h] = k.split(' H');
        return { y: parseInt(y, 10), h: parseInt(h, 10) };
      };
      const start = parseH(projection[0].key);
      const end = parseH(projection[projection.length - 1].key);
      let y = start.y;
      let h = start.h;
      while (y < end.y || (y === end.y && h <= end.h)) {
        const k = `${y} H${h}`;
        const v = byKey.get(k);
        dense.push({ key: k, expected: v?.expected || 0, total: v?.total || 0 });
        h += 1;
        if (h > 2) { h = 1; y += 1; }
      }
    } else {
      const parseQ = (k: string) => {
        const [y, q] = k.split(' Q');
        return { y: parseInt(y, 10), q: parseInt(q, 10) };
      };
      const start = parseQ(projection[0].key);
      const end = parseQ(projection[projection.length - 1].key);
      let y = start.y;
      let q = start.q;
      while (y < end.y || (y === end.y && q <= end.q)) {
        const k = `${y} Q${q}`;
        const v = byKey.get(k);
        dense.push({ key: k, expected: v?.expected || 0, total: v?.total || 0 });
        q += 1;
        if (q > 4) { q = 1; y += 1; }
      }
    }
    return dense.map((r) => ({
      key: r.key,
      value: r.expected,
      tooltip: `${formatBucketLabel(r.key, bucket)} · expected ${formatShortMoney(r.expected)} · contracted ${formatShortMoney(r.total)}`,
    }));
  }, [projection, bucket]);

  if (rows.length === 0) {
    return <p className="hint">No deals with line items available. Sync first.</p>;
  }

  return (
    <>
      <p className="hint" style={{ marginTop: 0 }}>
        One row per deal · per-line-item values are post-discount (HubSpot's <code>amount</code>) ·
        column per line item classified manually in <code>lineItemConfig.ts</code> ·
        <strong> Sites</strong> / <strong>Patients</strong> = max qty across line items of that unit ·
        <strong> List</strong> = pre-discount Σ(price × qty) · <strong>Disc</strong> = total discount
        applied · <strong>Calc</strong> = List − Disc · <strong>HubSpot</strong> = deal-level
        <code> amount</code> · <strong>Δ</strong> = HubSpot − Calc.
      </p>
      {unclassified.length > 0 && (
        <p className="hint" style={{ color: 'var(--neg, #b91c1c)' }}>
          <strong>Unclassified line items</strong> (rightmost columns — add to
          <code> lineItemConfig.ts</code>): {unclassified.join(', ')}
        </p>
      )}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
        <table className="yearly-emp-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              {headerSort('name', 'Deal', { textAlign: 'left', minWidth: 280 })}
              {headerSort('ta', 'TA', { textAlign: 'left' })}
              {headerSort('stage', 'Stage', { textAlign: 'left' })}
              {headerSort('sites', 'Sites')}
              {headerSort('patients', 'Patients')}
              {headerSort('duration', 'Duration')}
              {lineItemNames.map((n) => {
                const cfg = getLineItemConfig(n);
                return (
                  <th key={n} title={`${n} · unit: ${cfg.unit}`}>
                    {cfg.short || n}
                  </th>
                );
              })}
              {headerSort('list', 'List')}
              {headerSort('discount', 'Disc')}
              {headerSort('hubspot', 'HubSpot')}
              {headerSort('calc', 'Calc')}
              {headerSort('diff', 'Δ')}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ deal, sites, patients, byName, listTotal, discount, calcTotal, hubspotTotal }) => {
              const diff = hubspotTotal == null ? null : hubspotTotal - calcTotal;
              const diffSignificant = diff != null && Math.abs(diff) >= 1;
              return (
                <tr key={deal.id}>
                  <td style={{ textAlign: 'left', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={deal.name}>
                    {deal.name}
                  </td>
                  <td style={{ textAlign: 'left' }}>{deal.therapeuticArea}</td>
                  <td style={{ textAlign: 'left' }}>{deal.stageLabel}</td>
                  <td>{sites || ''}</td>
                  <td>{patients || ''}</td>
                  <td>{deal.durationMonths}m</td>
                  {lineItemNames.map((n) => <td key={n}>{money(byName[n] || 0)}</td>)}
                  <td>{money(listTotal)}</td>
                  <td className={discount > 0 ? 'neg' : ''}>{discount ? `−${money(discount)}` : ''}</td>
                  <td>{hubspotTotal == null ? <span className="hint">—</span> : money(hubspotTotal)}</td>
                  <td className="bold">{money(calcTotal)}</td>
                  <td
                    className={diffSignificant ? 'neg' : ''}
                    title={diff == null ? 'No HubSpot amount on deal' : `HubSpot ${money(hubspotTotal!)} − Calc ${money(calcTotal)}`}
                  >
                    {diff == null ? '' : diffSignificant ? money(diff) : '✓'}
                  </td>
                </tr>
              );
            })}
            <tr className="total-row">
              <td colSpan={3} style={{ textAlign: 'left' }}>TOTAL</td>
              <td>{rows.reduce((s, r) => s + r.sites, 0)}</td>
              <td>{rows.reduce((s, r) => s + r.patients, 0)}</td>
              <td></td>
              {lineItemNames.map((n) => <td key={n} className="bold">{money(totalsByName[n] || 0)}</td>)}
              <td className="bold">{money(rows.reduce((s, r) => s + r.listTotal, 0))}</td>
              <td className="bold neg">
                {rows.reduce((s, r) => s + r.discount, 0) > 0
                  ? `−${money(rows.reduce((s, r) => s + r.discount, 0))}`
                  : ''}
              </td>
              <td className="bold">{money(rows.reduce((s, r) => s + (r.hubspotTotal ?? 0), 0))}</td>
              <td className="bold">{money(rows.reduce((s, r) => s + r.calcTotal, 0))}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>
              Projected Project Configuration fees{' '}
              <span className="hint">(by predicted close {bucketLabel(bucket)}, probability-weighted)</span>
            </h3>
            <p className="hint">
              Project Configuration line items are paid up-front, so the full expected value lands
              in the deal's predicted close {bucketLabel(bucket)}. Expected = contracted value × close probability.
              Across all included deals: ${Math.round(projectionRawTotal).toLocaleString()} contracted ·{' '}
              <strong>${Math.round(projectionTotal).toLocaleString()} expected</strong>.
            </p>
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="hint" style={{ margin: 0 }}>Bucket:</span>
            <select value={bucket} onChange={(e) => setBucket(e.target.value as Bucket)}>
              <option value="halfyear">Half-year</option>
              <option value="quarter">Quarter</option>
              <option value="month">Month</option>
            </select>
          </label>
        </div>
        {projection.length === 0 ? (
          <p className="hint">No Project Configuration line items in current selection.</p>
        ) : (
          <>
          <TimeBarChart series={chartSeries} bucket={bucket} />
          <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginTop: 12 }}>
            <table className="yearly-emp-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>
                    {bucket === 'month' ? 'Month' : bucket === 'halfyear' ? 'Half-year' : 'Quarter'}
                  </th>
                  <th>Deals</th>
                  <th>Contracted</th>
                  <th>Expected</th>
                </tr>
              </thead>
              <tbody>
                {projection.map((r) => (
                  <tr key={r.key}>
                    <td style={{ textAlign: 'left' }}>{r.key}</td>
                    <td>{r.deals}</td>
                    <td>{money(r.total)}</td>
                    <td className="bold">{money(r.expected)}</td>
                  </tr>
                ))}
                <tr className="total-row">
                  <td style={{ textAlign: 'left' }}>TOTAL</td>
                  <td>{projection.reduce((s, r) => s + r.deals, 0)}</td>
                  <td className="bold">{money(projectionRawTotal)}</td>
                  <td className="bold">{money(projectionTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </>
  );
}

// Simple time-axis bar chart. Bars are evenly spaced over the dense series
// (one slot per month, quarter, or half-year), so the x-axis is time-ordered
// without needing a real linear date scale.
type Bucket = 'month' | 'quarter' | 'halfyear';

interface TimeBarChartProps {
  series: { key: string; value: number; tooltip: string }[];
  bucket: Bucket;
  height?: number;
  /** y-axis tick formatter. Defaults to compact $ amounts. */
  yFormat?: (v: number) => string;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function bucketLabel(b: Bucket): string {
  return b === 'month' ? 'month' : b === 'quarter' ? 'quarter' : 'half-year';
}

function formatBucketLabel(key: string, bucket: Bucket): string {
  if (bucket === 'month') {
    const [y, m] = key.split('-').map((s) => parseInt(s, 10));
    return `${MONTH_SHORT[m - 1]} '${String(y).slice(2)}`;
  }
  if (bucket === 'halfyear') {
    const [y, h] = key.split(' '); // "2026 H1"
    return `${h} '${y.slice(2)}`;
  }
  return key; // "2026 Q1"
}

function formatShortMoney(v: number): string {
  if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function TimeBarChart({ series, bucket, height = 280, yFormat = formatShortMoney }: TimeBarChartProps) {
  const PAD = { top: 16, right: 16, bottom: 44, left: 64 };
  const slotW = bucket === 'month' ? 28 : bucket === 'quarter' ? 56 : 80;
  const barW = bucket === 'month' ? 18 : bucket === 'quarter' ? 40 : 60;
  const innerH = height - PAD.top - PAD.bottom;
  const innerW = Math.max(series.length, 1) * slotW;
  const totalW = innerW + PAD.left + PAD.right;

  const maxVal = series.reduce((m, r) => Math.max(m, r.value), 0);
  const axisMax = niceCeil(maxVal);
  const y = (v: number) => PAD.top + innerH - (axisMax === 0 ? 0 : (v / axisMax) * innerH);
  const ticks = 5;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => (axisMax / ticks) * i);

  // X-axis label policy. For month: label quarter starts (Jan/Apr/Jul/Oct),
  // emphasize January. For quarter / halfyear: label every slot, emphasize
  // the year start (Q1 / H1).
  const showLabel = (key: string): { label: string; emphasize: boolean } | null => {
    if (bucket === 'quarter') return { label: key, emphasize: key.endsWith('Q1') };
    if (bucket === 'halfyear') return { label: formatBucketLabel(key, 'halfyear'), emphasize: key.endsWith('H1') };
    const m = parseInt(key.slice(5, 7), 10);
    if (m !== 1 && m !== 4 && m !== 7 && m !== 10) return null;
    return { label: formatBucketLabel(key, 'month'), emphasize: m === 1 };
  };

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6, background: '#fff' }}>
      <svg width={totalW} height={height} style={{ display: 'block' }}>
        {tickValues.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={totalW - PAD.right} y1={y(v)} y2={y(v)} stroke="#eef" />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6b7280">
              {yFormat(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={totalW - PAD.right} y1={y(0)} y2={y(0)} stroke="#9ca3af" />
        {series.map((r, i) => {
          const x = PAD.left + i * slotW + (slotW - barW) / 2;
          const h = y(0) - y(r.value);
          const lbl = showLabel(r.key);
          return (
            <g key={r.key}>
              {r.value > 0 && (
                <rect x={x} y={y(r.value)} width={barW} height={h} fill="var(--accent)">
                  <title>{r.tooltip}</title>
                </rect>
              )}
              {lbl && (
                <text
                  x={PAD.left + i * slotW + slotW / 2}
                  y={height - PAD.bottom + 16}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight={lbl.emphasize ? 600 : 400}
                  fill={lbl.emphasize ? '#111827' : '#6b7280'}
                >
                  {lbl.label}
                </text>
              )}
              {lbl && (
                <line
                  x1={PAD.left + i * slotW + slotW / 2}
                  x2={PAD.left + i * slotW + slotW / 2}
                  y1={y(0)}
                  y2={y(0) + 4}
                  stroke="#9ca3af"
                />
              )}
            </g>
          );
        })}
        {series.length === 0 && (
          <text x={totalW / 2} y={height / 2} textAnchor="middle" fontSize="13" fill="#9ca3af">
            No data
          </text>
        )}
      </svg>
    </div>
  );
}

/** Headcount per month over the model horizon. An employee is active in
 *  month M when their startDate (or "Current") ≤ M AND endDate is null/
 *  undefined or M ≤ endDate. */
function StaffOverTimeSection({ input }: { input: ModelInput }) {
  const series = useMemo(() => {
    return input.dates.map((d) => {
      const monthKey = d.slice(0, 7);
      let count = 0;
      for (const e of input.employees) {
        const started = e.startDate === 'Current' || e.startDate <= monthKey;
        if (!started) continue;
        if (e.endDate && monthKey > e.endDate) continue;
        count += 1;
      }
      return {
        key: monthKey,
        value: count,
        tooltip: `${formatBucketLabel(monthKey, 'month')} · ${count} staff`,
      };
    });
  }, [input.dates, input.employees]);

  const maxHead = series.reduce((m, r) => Math.max(m, r.value), 0);
  const minHead = series.reduce((m, r) => Math.min(m, r.value), maxHead);

  return (
    <section>
      <h2>
        Staff over time <span className="hint">(month-end headcount from the employees roster)</span>
      </h2>
      <p className="hint" style={{ margin: '4px 0 12px' }}>
        Counts every employee whose <code>startDate</code> ≤ month and (no <code>endDate</code> or
        month ≤ <code>endDate</code>). Range: <strong>{minHead}–{maxHead}</strong> over{' '}
        {input.dates.length} months.
      </p>
      <TimeBarChart series={series} bucket="month" height={240} yFormat={(v) => String(Math.round(v))} />
    </section>
  );
}

function money(v: number): string {
  if (!v) return '';
  return '$' + Math.round(v).toLocaleString();
}

/** 1-based column index → Excel column letter (1=A, 26=Z, 27=AA, …). */
function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
