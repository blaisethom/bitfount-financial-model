import {
  AssistantRuntimeProvider,
  useAssistantInstructions,
  useAssistantTool,
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from '@assistant-ui/react';
import { useChatRuntime, AssistantChatTransport } from '@assistant-ui/react-ai-sdk';
import { z } from 'zod';
import { useState, useRef, useMemo } from 'react';
import type { FormulaOverrides } from '../formula';
import type { Scenario } from '../scenarios';
import type { ModelDef } from '../engine';
import type { EvalResult } from '../engine';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

// ─── Hamburger menu (moved from App header) ───────────────────────────────

export interface MenuCallbacks {
  onMenuReset: () => void;
  onMenuDownload: () => Promise<void> | void;
  onMenuSync: () => Promise<string>;
  onMenuXeroSync: () => Promise<string>;
}

function SidebarMenu({
  onMenuReset, onMenuDownload, onMenuSync, onMenuXeroSync,
}: MenuCallbacks) {
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUploadClick = () => { fileRef.current?.click(); };
  const handleReset = () => { onMenuReset(); };

  const handleDownload = async () => {
    setStatus('Building Excel…');
    try { await onMenuDownload(); setStatus('Downloaded Excel'); }
    catch (err) { setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`); }
    setTimeout(() => setStatus(null), 4000);
  };

  const handleSync = async () => {
    setStatus('Syncing from HubSpot…');
    try { setStatus(await onMenuSync()); }
    catch (err) { setStatus(`Sync failed: ${err instanceof Error ? err.message : String(err)}`); }
    setTimeout(() => setStatus(null), 8000);
  };

  const handleXeroSync = async () => {
    setStatus('Fetching Xero actuals…');
    try { setStatus(`Created scenario · ${await onMenuXeroSync()}`); }
    catch (err) { setStatus(`Xero sync failed: ${err instanceof Error ? err.message : String(err)}`); }
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
    <>
      {status && <span className="menu-status">{status}</span>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" aria-label="Menu">☰</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={handleSync}>Sync from HubSpot</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleXeroSync}>Sync Xero Actuals</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleDownload}>Download as Excel</DropdownMenuItem>
          <DropdownMenuItem onSelect={handleUploadClick}>Upload file…</DropdownMenuItem>
          <DropdownMenuItem onSelect={handleReset}>Reset to Excel defaults</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={handleFileChange} />
    </>
  );
}

// ─── Tool callbacks ───────────────────────────────────────────────────────

export interface AIAssistantCallbacks {
  onSetFormula: (stepOutput: string, slot: string, formula: string) => string | null;
  onResetFormula: (stepOutput: string, slot: string) => void;
  onClearFormulaOverrides: () => void;
  onNavigate: (view: string) => void;
  onNewScenario: () => void;
  onSwitchScenario: (id: string) => void;
  onRenameScenario: (id: string, name: string) => void;
  onDeleteScenario: (id: string) => void;
  /** Read rows from any engine calculation table (live browser-side data). */
  onQueryTable: (table: string, limit?: number) => Record<string, unknown>[];
}

// ─── Tool registrations ───────────────────────────────────────────────────

function AITools({
  onSetFormula, onResetFormula, onClearFormulaOverrides,
  onNavigate, onNewScenario, onSwitchScenario, onRenameScenario, onDeleteScenario,
  onQueryTable,
}: AIAssistantCallbacks) {
  useAssistantTool({
    toolName: 'set_formula',
    type: 'frontend',
    description:
      'Edit a formula definition in the model engine. ' +
      'Use the step output table name (e.g. "monthly_costs") and the slot ' +
      '(column name for map/agg/window steps, "$predicate" for filter steps, ' +
      'or structural slots like "$input", "$keys", "$partitionBy", "$orderBy", "$range"). ' +
      'Formulas are spreadsheet-like expressions: +,-,*,/,%, comparisons, ' +
      'functions like min(), max(), if(), abs(), round(), coalesce(), year(), month().',
    parameters: z.object({
      stepOutput: z.string().describe('The step output table name'),
      slot: z.string().describe('The formula slot (column name, "$predicate", etc.)'),
      formula: z.string().describe('The new formula expression'),
    }),
    execute: async ({ stepOutput, slot, formula }) => {
      const error = onSetFormula(stepOutput, slot, formula);
      if (error) return `Error: ${error}`;
      return `Updated: ${stepOutput}.${slot} = ${formula}`;
    },
  });

  useAssistantTool({
    toolName: 'reset_formula',
    type: 'frontend',
    description: 'Reset a single formula override back to its default value',
    parameters: z.object({ stepOutput: z.string(), slot: z.string() }),
    execute: async ({ stepOutput, slot }) => {
      onResetFormula(stepOutput, slot);
      return `Reset: ${stepOutput}.${slot}`;
    },
  });

  useAssistantTool({
    toolName: 'clear_all_formula_overrides',
    type: 'frontend',
    description: 'Remove ALL formula overrides and restore the entire model to its defaults',
    parameters: z.object({}),
    execute: async () => { onClearFormulaOverrides(); return 'All formula overrides cleared'; },
  });

  useAssistantTool({
    toolName: 'navigate',
    type: 'frontend',
    description: 'Switch to a different section or view in the financial model application',
    parameters: z.object({
      view: z.enum([
        // Web section tabs
        'total', 'budget', 'balance-sheet',
        'model', 'hubspot', 'hubspot-deals', 'employees', 'costs', 'excel',
        // Rendering section
        'rendering',
        // Engine section
        'engine',
        // Scenarios section
        'scenarios',
      ]).describe('The view to navigate to'),
    }),
    execute: async ({ view }) => { onNavigate(view); return `Navigated to ${view}`; },
  });

  useAssistantTool({
    toolName: 'create_scenario',
    type: 'frontend',
    description: 'Create a new scenario by copying the currently active one',
    parameters: z.object({}),
    execute: async () => { onNewScenario(); return 'Created new scenario (copy of current)'; },
  });

  useAssistantTool({
    toolName: 'switch_scenario',
    type: 'frontend',
    description: 'Switch the active scenario by its ID',
    parameters: z.object({ id: z.string().describe('The scenario ID to activate') }),
    execute: async ({ id }) => { onSwitchScenario(id); return `Switched to scenario ${id}`; },
  });

  useAssistantTool({
    toolName: 'rename_scenario',
    type: 'frontend',
    description: 'Rename a scenario',
    parameters: z.object({ id: z.string(), name: z.string().describe('The new name') }),
    execute: async ({ id, name }) => { onRenameScenario(id, name); return `Renamed scenario to: ${name}`; },
  });

  useAssistantTool({
    toolName: 'delete_scenario',
    type: 'frontend',
    description: 'Delete a scenario. The last scenario cannot be deleted.',
    parameters: z.object({ id: z.string() }),
    execute: async ({ id }) => { onDeleteScenario(id); return `Deleted scenario ${id}`; },
  });

  useAssistantTool({
    toolName: 'query_table',
    type: 'frontend',
    description:
      'Read rows from any engine calculation table to look up live financial data computed in the browser. ' +
      'Returns JSON rows. The system prompt lists all available table names and their columns. ' +
      'Use this to answer questions about cash, costs, revenue, headcount, etc. by month or year.',
    parameters: z.object({
      table: z.string().describe(
        'Engine table name, e.g. "cash_monthly", "budget_monthly", "budget_yearly", "revenue_monthly"',
      ),
      limit: z.number().optional().describe('Max rows to return (default 72, covers 6 years monthly)'),
    }),
    execute: async ({ table, limit }) => {
      const rows = onQueryTable(table, limit);
      if (rows.length === 0) {
        return (
          `Table "${table}" not found or has no rows. ` +
          'Available tables include: cash_monthly, budget_monthly, budget_yearly, revenue_monthly, ' +
          'monthly_costs, employees_monthly, deals_monthly.'
        );
      }
      return JSON.stringify(rows);
    },
  });

  return null;
}

// ─── Message rendering ────────────────────────────────────────────────────

function UserMessage() {
  return (
    <MessagePrimitive.Root className="aui-msg aui-user">
      <div className="aui-bubble"><MessagePrimitive.Content /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="aui-msg aui-assistant">
      <div className="aui-bubble"><MessagePrimitive.Content /></div>
    </MessagePrimitive.Root>
  );
}

// ─── Thread UI ────────────────────────────────────────────────────────────

interface AIThreadProps extends AIAssistantCallbacks {
  systemPrompt: string;
  onClear: () => void;
}

function AIThread({ systemPrompt, onClear, ...callbacks }: AIThreadProps) {
  useAssistantInstructions(systemPrompt);

  return (
    <>
      <AITools {...callbacks} />
      <ThreadPrimitive.Root className="aui-thread">
        <ThreadPrimitive.Viewport className="aui-viewport">
          <ThreadPrimitive.Empty>
            <div className="aui-empty">
              <p>Ask me to edit formulas, switch views, or explain any part of the model.</p>
              <p className="aui-hint">
                Try: <em>"Set the G&A rent formula to 15000 per month"</em>
              </p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="aui-footer">
          <ComposerPrimitive.Root className="aui-composer">
            <ComposerPrimitive.Input
              className="aui-composer-input"
              placeholder="Ask me to edit the model…"
              rows={1}
            />
            <ComposerPrimitive.Send className="aui-send" aria-label="Send">↑</ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <button
            type="button"
            className="aui-clear-btn"
            onClick={onClear}
            title="Clear conversation"
            aria-label="Clear conversation"
          >
            ✕ Clear
          </button>
        </div>
      </ThreadPrimitive.Root>
    </>
  );
}

// Keyed wrapper — remounting resets useChatRuntime to an empty conversation.
interface ChatProviderProps extends AIAssistantCallbacks {
  systemPrompt: string;
}

// After a frontend tool executes, the result is stored in the UIMessage but NOT
// automatically re-sent to the LLM (sendAutomaticallyWhen defaults to false).
// This callback returns true when all tool calls in the last assistant message
// have results (output-available/output-error) and there is no text response yet,
// signalling the chat runtime to fire a follow-up request so Gemini can
// interpret the tool output and reply.
function shouldResendAfterToolResult({ messages }: { messages: Array<{ role?: string; parts?: Array<{ type?: string; state?: string }> }> }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  const parts = last.parts ?? [];
  const toolParts = parts.filter((p) => typeof p.type === 'string' && p.type.startsWith('tool-'));
  if (toolParts.length === 0) return false;
  // Already has a text response from a previous step — don't loop
  if (parts.some((p) => p.type === 'text')) return false;
  return toolParts.every((p) => p.state === 'output-available' || p.state === 'output-error');
}

function ChatProvider({ systemPrompt, ...callbacks }: ChatProviderProps & { onClear: () => void }) {
  const transport = useMemo(() => new AssistantChatTransport({ api: '/api/ai/chat' }), []);
  const runtime = useChatRuntime({ transport, sendAutomaticallyWhen: shouldResendAfterToolResult });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AIThread systemPrompt={systemPrompt} {...callbacks} />
    </AssistantRuntimeProvider>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { section: 'web', icon: '⊞', label: 'Web' },
  { section: 'engine', icon: '⚙', label: 'Engine' },
  { section: 'rendering', icon: '▤', label: 'Rendering' },
] as const;

export interface AIAssistantProps extends AIAssistantCallbacks, MenuCallbacks {
  open: boolean;
  onMinimize: () => void;
  onExpand: () => void;
  systemPrompt: string;
  currentSection: string;
  onNavigateSection: (section: string) => void;
}

export function AIAssistant({
  open, onMinimize, onExpand, systemPrompt,
  currentSection, onNavigateSection,
  onMenuReset, onMenuDownload, onMenuSync, onMenuXeroSync,
  ...callbacks
}: AIAssistantProps) {
  const [clearKey, setClearKey] = useState(0);

  return (
    <>
    {/* Mobile: floating button to open the assistant when minimized */}
    <button
      className={`aui-mobile-fab${open ? ' aui-mobile-fab--hidden' : ''}`}
      onClick={onExpand}
      aria-label="Open AI assistant"
    >✦</button>
    {/* Mobile: dim backdrop, tap to close */}
    <div
      className={`aui-backdrop${open ? ' aui-backdrop--visible' : ''}`}
      onClick={onMinimize}
      aria-hidden="true"
    />
    <aside className={`aui-sidebar${open ? ' aui-open' : ''}`} aria-label="AI assistant">
      {/* Thin strip — always in DOM, visible when minimized */}
      <div className="aui-strip" aria-hidden={open || undefined}>
        <Button
          size="icon"
          variant="ghost"
          className="aui-expand-btn"
          onClick={onExpand}
          title="Open AI Assistant"
          aria-label="Open AI assistant"
        >
          ✦
        </Button>
        <div className="aui-strip-divider" />
        {NAV_ITEMS.map(({ section, icon, label }) => (
          <button
            key={section}
            className={`aui-nav-strip-btn${currentSection === section ? ' active' : ''}`}
            title={label}
            aria-label={label}
            onClick={() => onNavigateSection(section)}
          >
            {icon}
          </button>
        ))}
        <div className="aui-strip-spacer" />
        <SidebarMenu
          onMenuReset={onMenuReset}
          onMenuDownload={onMenuDownload}
          onMenuSync={onMenuSync}
          onMenuXeroSync={onMenuXeroSync}
        />
      </div>

      {/* Full panel — always in DOM, visible when open */}
      <div className="aui-panel">
        <div className="aui-sidebar-header">
          <span className="aui-sidebar-title">AI Assistant</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <SidebarMenu
              onMenuReset={onMenuReset}
              onMenuDownload={onMenuDownload}
              onMenuSync={onMenuSync}
              onMenuXeroSync={onMenuXeroSync}
            />
            <Button
              size="icon"
              variant="ghost"
              onClick={onMinimize}
              aria-label="Minimize AI assistant"
              title="Minimize"
            >
              ‹
            </Button>
          </div>
        </div>
        {/* Section navigation row */}
        <nav className="aui-nav-row" aria-label="Section navigation">
          {NAV_ITEMS.map(({ section, icon, label }) => (
            <button
              key={section}
              className={`aui-nav-row-btn${currentSection === section ? ' active' : ''}`}
              onClick={() => onNavigateSection(section)}
              title={label}
            >
              <span className="aui-nav-icon">{icon}</span>
              <span className="aui-nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <ChatProvider
          key={clearKey}
          systemPrompt={systemPrompt}
          onClear={() => setClearKey((k) => k + 1)}
          {...callbacks}
        />
      </div>
    </aside>
    </>
  );
}

// ─── System prompt builder ────────────────────────────────────────────────

export function buildSystemPrompt(opts: {
  model: ModelDef;
  formulaOverrides: FormulaOverrides;
  scenarios: Scenario[];
  activeScenarioId: string;
  engineResult: EvalResult;
}): string {
  const { model, formulaOverrides, scenarios, activeScenarioId, engineResult } = opts;

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId) ?? scenarios[0];

  const overrideLines = Object.entries(formulaOverrides).flatMap(([step, slots]) =>
    Object.entries(slots).map(([slot, formula]) => `  ${step}.${slot} = ${formula}`),
  );

  // Build a schema catalog from live computed tables (name + column names)
  const tableCatalog = Object.entries(engineResult.tables)
    .filter(([, t]) => t?.rows?.length > 0)
    .map(([name, t]) => `  ${name}  [${Object.keys(t.rows[0]).join(', ')}]`)
    .join('\n');

  const scenarioList = scenarios
    .map((s) => `  ${s.id === activeScenarioId ? '→' : ' '} [${s.id}] ${s.name}`)
    .join('\n');

  const fmt = (n: number | null | undefined) =>
    n == null ? '—' : `$${Math.round(n).toLocaleString()}`;

  // Per-year P&L from budget_yearly (authoritative — derived from overridden monthly)
  type YearRow = Record<string, unknown>;
  const yearRows: YearRow[] = (engineResult.tables.budget_yearly?.rows ?? [])
    .slice()
    .sort((a, b) => Number(a['year']) - Number(b['year']));

  const yearlyTable = yearRows.length
    ? [
        'Year  | Revenue        | Cost of Sales  | Gross Profit   | Total Opex     | EBITDA',
        '------|----------------|----------------|----------------|----------------|----------------',
        ...yearRows.map((r) =>
          [
            String(r['year']).padEnd(6),
            fmt(r['revenue'] as number).padEnd(16),
            fmt(r['cost_of_sales'] as number).padEnd(16),
            fmt(r['gross_profit'] as number).padEnd(16),
            fmt(r['total_opex'] as number).padEnd(16),
            fmt(r['ebitda'] as number),
          ].join('| '),
        ),
      ].join('\n')
    : '  (no yearly data available)';

  // Cash balance from cash_monthly; month_idx 0 = Jan 2026
  type CashRow = { month_idx: number; cash: number };
  const cashRows = (engineResult.tables.cash_monthly?.rows ?? []) as CashRow[];

  const monthLabel = (idx: number) => {
    const year = 2026 + Math.floor(idx / 12);
    const month = String((idx % 12) + 1).padStart(2, '0');
    return `${year}-${month}`;
  };

  // First month where cash goes negative = runway end
  const runoutRow = cashRows.find((r) => r.cash < 0);
  const runoutLabel = runoutRow
    ? `Cash goes negative in **${monthLabel(runoutRow.month_idx)}** (balance: ${fmt(runoutRow.cash)})`
    : 'Cash remains positive across the full 6-year model period';

  // Show every 3rd month to keep the prompt concise
  const cashTable = cashRows.length
    ? [
        'Month   | Cash Balance',
        '--------|----------------',
        ...cashRows
          .filter((r) => r.month_idx % 3 === 0)
          .map((r) => `${monthLabel(r.month_idx).padEnd(8)}| ${fmt(r.cash)}`),
      ].join('\n')
    : '  (no cash data available)';

  return `You are an AI assistant embedded in the Bitfount financial model application — a 6-year forward-looking P&L, cost, and balance-sheet model covering 2026–2031.

## How this model works

The model is a DAG of ~127 steps (map / filter / agg / window / join / lookup). Each step reads one or more input tables and produces an output table. Formulas are spreadsheet-like expressions that can be overridden per-slot without touching the model definition. The engine re-evaluates everything whenever an override changes.

All dollar figures are in USD.

## Navigation

The app is organised into four sections. Use the \`navigate\` tool with any of the values below:

**Web view** (tabs defined in report.yaml):
- "total" — 6-year rollup chart and KPI summary (header stats are 6-year totals, NOT per-year)
- "budget" — full monthly Budget P&L spreadsheet
- "balance-sheet" — cash, assets, liabilities
- "model" — month-by-month revenue build from deals and headcount
- "hubspot" — HubSpot pipeline data and sync settings
- "hubspot-deals" — per-deal table with pipeline charts
- "employees" — headcount plan (FTEs, salaries, start dates)
- "costs" — direct and operating cost line items
- "excel" — Excel Export: download the full model as .xlsx

**Rendering** (report and layout definition — edit report.yaml):
- "rendering" — shows the LayoutEditor (tab layout) and ReportEditor (section/block definitions)

**Engine** (model editing):
- "engine" — declarative step-by-step engine; edit formulas here

**Scenarios** (data management):
- "scenarios" — manage scenarios, import from HubSpot, import Xero actuals

## Current state

Active scenario: "${activeScenario?.name ?? 'unknown'}"

Scenarios:
${scenarioList}

Formula overrides active (departures from model defaults):
${overrideLines.length ? overrideLines.join('\n') : '  (none — all formulas at defaults)'}

## Annual P&L by year

These are per-year figures derived from the overridden monthly model.
The header "total" stats in the app are 6-year sums — always use this table for any per-year question.

${yearlyTable}

## Cash balance & runway

${runoutLabel}

Cash balance every 3 months (quarterly snapshots):

${cashTable}

For the full month-by-month cash breakdown, call \`query_table\` with table "cash_monthly".

## Available engine tables & columns

Each line is a table you can pass to \`query_table\`. Columns are shown in brackets.

${tableCatalog}

## Formula DSL reference

Operators: +, -, *, /, %, <, >, <=, >=, ==, !=
Functions: min(), max(), if(cond, a, b), abs(), round(), coalesce(), pow(), year(), month(), day(),
           left(), right(), mid(), len(), upper(), lower(), trim(), int(), floor(), ceiling(), sqrt(),
           mod(), isblank(), value(), concat()
Slot names by step type:
  Map / window  → output column name
  Filter        → "$predicate"
  Agg           → output column name
  Structural    → "$input", "$keys", "$partitionBy", "$orderBy", "$range", "$right", "$type", "$on"

## How to help

- For data questions (cash, revenue, costs, headcount by month): call \`query_table\` to read the live browser-computed data, then interpret it for the user. Do NOT just navigate — actually look up and report the numbers.
- For per-year questions: use the Annual P&L table above.
- For cash/runway questions: the cash summary above gives a quick answer; use \`query_table("cash_monthly")\` for month-by-month detail.
- For editing: use \`set_formula\` with the exact step output name and slot. Always confirm what changed.
- If a formula edit fails, explain the error and ask the user to clarify.
- If the user asks about something not in the context above, navigate to the relevant view and describe what they'll see.`;
}
