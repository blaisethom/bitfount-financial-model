// Single-pane explorer for the declarative engine. Sources and steps live
// in one navigable node list; the user walks through them with Prev/Next or by
// clicking entries in the (optionally section-grouped) sidebar. Each step's
// formula display also exposes clickable column references that jump back to
// the upstream source/step the column came from.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  evaluateModel,
  type AggExpr, type CellValue, type Column, type EvalResult, type Expr, type ModelDef, type ModelOutputDef,
  type SourceDef, type Step, type Table, type TableOp,
} from '../engine';
import type { ReportEdit } from '../report/EngineSection';
import {
  parseExpr, exprToSource, parseAgg, aggToSource, aggColNames, FILTER_SLOT, STRUCT,
  type FormulaOverrides,
} from '../formula';
import Modal from './Modal';

/** Wiring that makes a manual source's value cells editable. */
interface EditConfig {
  source: string;
  /** Identity columns for this source (used to address the edited row). */
  idKeys: string[];
  onEdit: (e: ReportEdit) => void;
}

/** Wiring for editing a step's formulas + structural params (model-wide / base case). */
interface FormulaEditConfig {
  overrides: FormulaOverrides;
  /** Whether editing is allowed right now (base case active). */
  enabled: boolean;
  /** Commit an edit; returns an error string to show in-editor, or null on success. */
  onSet: (stepOutput: string, slot: string, src: string) => string | null;
  onReset: (stepOutput: string, slot: string) => void;
}

/** Build a row's identity object from its identity columns. */
function rowIdentity(row: Record<string, CellValue>, idKeys: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of idKeys) {
    const v = row[k];
    if (typeof v === 'number' || typeof v === 'string') out[k] = v;
  }
  return out;
}

interface Props {
  model: ModelDef;
  /** Pre-evaluated result. Required when the model has `apiSource` entries that
   *  the engine can't fetch on its own. */
  result?: EvalResult;
  /** Externally-controlled selection: the ref of the source/step the user is
   *  viewing. When undefined, defaults to the first node. Lets the host wire
   *  the selection up to the URL hash so browser back/forward works. */
  currentRef?: string;
  /** Called every time the user navigates to a different ref (sidebar click,
   *  Prev/Next, jump-from-formula, jump-from-usage). The host is expected to
   *  push the ref to history. Same-ref navigations are deduped before this
   *  fires. */
  onRefChange?: (ref: string) => void;
  /** When provided, value cells of editable manual sources become editable and
   *  emit a ReportEdit on commit. */
  onEdit?: (e: ReportEdit) => void;
  /** Source names whose cells may be edited (those `applyEditToInput` handles). */
  editableSources?: ReadonlySet<string>;
  /** Identity columns for a given source ref. */
  identityFor?: (ref: string) => string[];
  /** When provided, map-step column formulas become editable. */
  formulaEdit?: FormulaEditConfig;
}

interface ExpandedTable {
  title: string;
  table: Table;
  /** When true, the modal renders the table as a month-pivot. */
  pivot?: boolean;
}

/** A unified entry — either a source or a step — in the node list. */
type Node =
  | { kind: 'source'; ref: string; src: SourceDef }
  | { kind: 'step';   ref: string; step: Step; output: Table; input: Table; inputRef: string };

/** All table refs a step consumes — the primary `input`, plus any extra
 *  tables the op brings in (join's right, union's other tables). */
function stepInputRefs(step: Step): string[] {
  const refs = [step.input];
  switch (step.op.op) {
    case 'join':
      refs.push(step.op.right);
      break;
    case 'union':
      refs.push(...step.op.tables);
      break;
  }
  return refs;
}

export default function EnginePreview({ model, result: passedResult, currentRef, onRefChange, onEdit, editableSources, identityFor, formulaEdit }: Props) {
  const result = useMemo(
    () => passedResult ?? evaluateModel(model),
    [model, passedResult],
  );

  // Build the unified node list: sources first (in declared order), then steps
  // in evaluation order. The `ref` of each node is the table name it produces.
  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    for (const [name, src] of Object.entries(model.sources)) {
      out.push({ kind: 'source', ref: name, src });
    }
    for (const { step, output } of result.trace) {
      out.push({
        kind: 'step',
        ref: step.output,
        step,
        output,
        input: result.tables[step.input],
        inputRef: step.input,
      });
    }
    return out;
  }, [model.sources, result]);

  const refToIdx = useMemo(() => {
    const m = new Map<string, number>();
    nodes.forEach((n, i) => m.set(n.ref, i));
    return m;
  }, [nodes]);

  // Reverse adjacency: for each ref, which trace steps consume it as input?
  // Drives the "Used by" section in the detail panel.
  const usagesByRef = useMemo(() => {
    const m = new Map<string, number[]>();
    result.trace.forEach(({ step }, traceIdx) => {
      for (const r of stepInputRefs(step)) {
        if (!m.has(r)) m.set(r, []);
        m.get(r)!.push(traceIdx);
      }
    });
    return m;
  }, [result.trace]);

  // Convert a trace index (position in result.trace) → its node index
  // (position in the unified nodes array). Sources occupy the first slots.
  const sourceCount = Object.keys(model.sources).length;
  const traceIdxToNodeIdx = (traceIdx: number) => sourceCount + traceIdx;

  // Selection is derived from the externally-controlled `currentRef` (e.g.
  // URL hash) when provided; otherwise we fall back to local state so the
  // component remains usable on its own.
  const [localIdx, setLocalIdx] = useState(0);
  const currentIdx = useMemo(() => {
    if (currentRef === undefined) return localIdx;
    const i = refToIdx.get(currentRef);
    return i !== undefined && i >= 0 ? i : 0;
  }, [currentRef, localIdx, refToIdx]);
  const goToIdx = (i: number) => {
    const node = nodes[i];
    if (!node) return;
    if (onRefChange) onRefChange(node.ref);
    else setLocalIdx(i);
  };
  const [expanded, setExpanded] = useState<ExpandedTable | null>(null);
  // List is hidden by default on phones; toolbar toggle controls it.
  const [showList, setShowList] = useState<boolean>(
    () => typeof window === 'undefined' || !window.matchMedia('(max-width: 900px)').matches,
  );
  // Group-by-section toggle — on by default when the model declares groups.
  const [groupBySection, setGroupBySection] = useState<boolean>(() => Boolean(model.groups?.length));

  // When the active definition changes, scroll the corresponding list item into
  // view inside the (height-constrained, scrollable) sidebar.
  const listScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showList) return;
    const active = listScrollRef.current?.querySelector('[data-active]') as HTMLElement | null;
    active?.scrollIntoView({ block: 'nearest' });
  }, [currentIdx, showList]);

  const total = nodes.length;
  const current = nodes[currentIdx];

  // When the current node is an editable manual source, build the edit wiring.
  const editConfig = useMemo<EditConfig | undefined>(() => {
    if (!current || current.kind !== 'source' || current.src.kind !== 'manual') return undefined;
    if (!onEdit || !editableSources?.has(current.ref)) return undefined;
    return { source: current.ref, idKeys: identityFor?.(current.ref) ?? [], onEdit };
  }, [current, onEdit, editableSources, identityFor]);

  // Lookup: ref → its headline output entry, if declared.
  const headlineByRef = useMemo(() => {
    const m = new Map<string, ModelOutputDef>();
    for (const o of model.outputs) m.set(o.ref, o);
    return m;
  }, [model.outputs]);

  // Map month_idx → date string for pivot-view column headers.
  const dateMap = useMemo<Map<number, string> | undefined>(() => {
    const t = result.tables.dates_t;
    if (!t) return undefined;
    const m = new Map<number, string>();
    for (const r of t.rows) {
      const idx = Number(r.month_idx);
      if (Number.isFinite(idx) && typeof r.date === 'string') m.set(idx, r.date);
    }
    return m.size ? m : undefined;
  }, [result]);

  const jumpToRef = (ref: string) => {
    const i = refToIdx.get(ref);
    if (i !== undefined && i >= 0) goToIdx(i);
  };

  const openFull = (title: string, table: Table, pivot = false) =>
    setExpanded({ title, table, pivot });

  // Pre-compute the section-grouped layout when grouping is on; falls back to
  // a flat layout (returns null) when not. An "Other" bucket catches any node
  // refs the model didn't assign to a group.
  const sections = useMemo(() => {
    if (!groupBySection || !model.groups?.length) return null;
    const seen = new Set<string>();
    const out: Array<{ name: string; description?: string; items: Array<{ ref: string; idx: number }> }> = [];
    for (const g of model.groups) {
      const items = g.refs
        .map((r) => ({ ref: r, idx: refToIdx.get(r) ?? -1 }))
        .filter((x) => x.idx >= 0);
      for (const it of items) seen.add(it.ref);
      out.push({ name: g.name, description: g.description, items });
    }
    const leftover = nodes
      .map((n, i) => ({ ref: n.ref, idx: i }))
      .filter((x) => !seen.has(x.ref));
    if (leftover.length > 0) {
      out.push({ name: 'Other', description: 'Refs not assigned to any group.', items: leftover });
    }
    return out;
  }, [groupBySection, model.groups, refToIdx, nodes]);

  return (
    <>
      <section>
        <div className="ta-summary">
          <span className="ta-name">Model Engine</span>
          <span className="ta-total">
            {Object.keys(model.sources).length} sources · {model.steps.length} steps
            {model.outputs.length > 0 && ` (${model.outputs.length} marked as headline)`}
            {model.groups && model.groups.length > 0 && ` · ${model.groups.length} sections`}
          </span>
        </div>
        <p className="hint">
          Declarative engine. The model is a DAG of named tables; sources and steps share one navigable list.
          Click any column reference in a step's formula to jump to where it came from.
        </p>
      </section>

      <section>
        <h2>Definitions</h2>

        <div className="engine-step-toolbar">
          <div className="engine-step-toolbar-current">
            <span className="engine-step-counter">
              {current?.kind === 'source' ? 'Source' : 'Step'} {currentIdx + 1} of {total}
            </span>
            <strong className="engine-step-toolbar-ref">
              {current?.ref}
            </strong>
            {current?.kind === 'step' && (
              <span className="hint engine-step-toolbar-io">
                {current.step.name}
              </span>
            )}
          </div>
          <div className="engine-step-nav">
            <button className="btn" onClick={() => goToIdx(Math.max(0, currentIdx - 1))} disabled={currentIdx === 0}>
              ← Prev
            </button>
            <button
              className="btn"
              onClick={() => goToIdx(Math.min(total - 1, currentIdx + 1))}
              disabled={currentIdx >= total - 1}
            >
              Next →
            </button>
            <button
              className="btn"
              onClick={() => setShowList((s) => !s)}
              aria-expanded={showList}
            >
              {showList ? 'Hide list' : 'Browse all'}
            </button>
            {model.groups && model.groups.length > 0 && (
              <button
                className="btn"
                onClick={() => setGroupBySection((g) => !g)}
                title="Toggle section grouping"
              >
                {groupBySection ? 'Flat' : 'By section'}
              </button>
            )}
          </div>
        </div>

        <div className={`engine-step-body${showList ? ' has-list' : ''}`}>
          {showList && (
            <div className="engine-list-scroll" ref={listScrollRef}>
              {sections
                ? <GroupedNodeList sections={sections} nodes={nodes} currentIdx={currentIdx} onPick={goToIdx} headlineByRef={headlineByRef} />
                : <FlatNodeList nodes={nodes} currentIdx={currentIdx} onPick={goToIdx} headlineByRef={headlineByRef} />}
            </div>
          )}
          <div>
            {current && (
              current.kind === 'source'
                ? <SourceDetail
                    name={current.ref}
                    src={current.src}
                    table={result.tables[current.ref]}
                    usages={usagesByRef.get(current.ref) ?? []}
                    trace={result.trace}
                    onJumpToTraceIdx={(i) => goToIdx(traceIdxToNodeIdx(i))}
                    dateMap={dateMap}
                    axis={model.defaultAxis}
                    onExpand={openFull}
                    edit={editConfig}
                  />
                : <StepDetail
                    step={current.step}
                    input={current.input}
                    inputRef={current.inputRef}
                    inputRefs={stepInputRefs(current.step)}
                    resolveTable={(ref) => result.tables[ref]}
                    output={current.output}
                    headline={headlineByRef.get(current.ref)}
                    usages={usagesByRef.get(current.ref) ?? []}
                    trace={result.trace}
                    dateMap={dateMap}
                    axis={model.defaultAxis}
                    onJumpToRef={jumpToRef}
                    onJumpToTraceIdx={(i) => goToIdx(traceIdxToNodeIdx(i))}
                    onExpand={openFull}
                    formulaEdit={formulaEdit}
                  />
            )}
          </div>
        </div>
      </section>

      <Modal
        open={expanded !== null}
        onClose={() => setExpanded(null)}
        title={expanded?.title ?? ''}
        maxWidth={1300}
      >
        {expanded && (expanded.pivot
          ? <SourceTablePreview table={expanded.table} maxRows={Infinity} dateMap={dateMap} axis={model.defaultAxis} />
          : <TablePreview table={expanded.table} maxRows={Infinity} />)}
      </Modal>
    </>
  );
}

// ─── List variants ────────────────────────────────────────────────────────

interface NodeListProps {
  nodes: Node[];
  currentIdx: number;
  onPick: (i: number) => void;
  headlineByRef: Map<string, ModelOutputDef>;
}

function FlatNodeList({ nodes, currentIdx, onPick, headlineByRef }: NodeListProps) {
  return (
    <ol className="engine-step-list">
      {nodes.map((n, i) => (
        <li key={n.ref}>
          <NodeListButton node={n} i={i} active={i === currentIdx} headline={headlineByRef.get(n.ref)} onPick={() => onPick(i)} />
        </li>
      ))}
    </ol>
  );
}

interface GroupedNodeListProps extends NodeListProps {
  sections: Array<{ name: string; description?: string; items: Array<{ ref: string; idx: number }> }>;
}

function GroupedNodeList({ sections, nodes, currentIdx, onPick, headlineByRef }: GroupedNodeListProps) {
  return (
    <div className="engine-grouped-list">
      {sections.map((s) => (
        <details key={s.name} className="engine-group" open>
          <summary className="engine-group-summary">
            <span className="engine-group-name">{s.name}</span>
            <span className="engine-group-count">{s.items.length}</span>
          </summary>
          {s.description && <p className="hint engine-group-desc">{s.description}</p>}
          <ol className="engine-step-list">
            {s.items.map(({ ref, idx }) => {
              const n = nodes[idx];
              return (
                <li key={ref}>
                  <NodeListButton node={n} i={idx} active={idx === currentIdx} headline={headlineByRef.get(ref)} onPick={() => onPick(idx)} />
                </li>
              );
            })}
          </ol>
        </details>
      ))}
    </div>
  );
}

interface NodeListButtonProps {
  node: Node;
  i: number;
  active: boolean;
  headline?: ModelOutputDef;
  onPick: () => void;
}

function NodeListButton({ node, i, active, headline, onPick }: NodeListButtonProps) {
  const kindBadge = node.kind === 'source' ? node.src.kind : null;
  return (
    <button
      onClick={onPick}
      className={`engine-step-list-btn${active ? ' is-active' : ''}`}
      title={node.kind === 'step' ? node.step.name : node.ref}
      data-active={active ? '' : undefined}
    >
      <span className="engine-step-list-index">{i + 1}.</span>
      <span className="engine-step-list-ref">{node.ref}</span>
      {kindBadge && <span className="engine-kind-badge engine-kind-badge--compact">{kindBadge}</span>}
      {headline && <span className="engine-headline-badge" title={`Declared headline: ${headline.label}`}>★</span>}
    </button>
  );
}

// ─── Detail panels ────────────────────────────────────────────────────────

interface SourceDetailProps {
  name: string;
  src: SourceDef;
  table: Table | undefined;
  usages: number[];
  trace: EvalResult['trace'];
  onJumpToTraceIdx: (traceIdx: number) => void;
  dateMap?: Map<number, string>;
  axis?: string;
  onExpand: (title: string, table: Table, pivot?: boolean) => void;
  edit?: EditConfig;
}

function SourceDetail({ name, src, table, usages, trace, onJumpToTraceIdx, dateMap, axis, onExpand, edit }: SourceDetailProps) {
  return (
    <div className="engine-step-detail">
      <h3 className="engine-step-detail-title">
        {name}
        <span className="engine-kind-badge headline-inline">{src.kind}</span>
        {edit && <span className="engine-editable-badge" title="Manual input — cells are editable">editable</span>}
      </h3>
      {'description' in src && src.description && (
        <p className="engine-step-detail-desc">{src.description}</p>
      )}

      <div className="engine-section-label">Schema</div>
      <ul className="engine-schema-list">
        {src.schema.columns.map((c) => (
          <li key={c.name}>
            <code className="engine-ref">{c.name}</code>
            <span className="hint" style={{ marginLeft: 6 }}>{c.type}</span>
            {c.description && <span className="hint" style={{ marginLeft: 6 }}>— {c.description}</span>}
          </li>
        ))}
      </ul>

      <div className="engine-section-label">Data <code className="engine-ref">{name}</code></div>
      {edit && <p className="hint" style={{ marginTop: -4 }}>Click any value cell to edit. Changes save into the active scenario.</p>}
      {table
        ? <SourceTablePreview table={table} dateMap={dateMap} axis={axis} scrollable edit={edit} onExpand={() => onExpand(name, table, true)} />
        : <p className="hint">(table not yet materialized)</p>}

      <UsageList usages={usages} trace={trace} onJump={onJumpToTraceIdx} />
    </div>
  );
}

interface UsageListProps {
  usages: number[];
  trace: EvalResult['trace'];
  onJump: (traceIdx: number) => void;
}

function UsageList({ usages, trace, onJump }: UsageListProps) {
  if (usages.length === 0) {
    return (
      <>
        <div className="engine-section-label">Used by</div>
        <p className="hint" style={{ margin: 0 }}>(no downstream usages)</p>
      </>
    );
  }
  return (
    <>
      <div className="engine-section-label">Used by ({usages.length})</div>
      <ul className="engine-usage-list">
        {usages.map((traceIdx) => {
          const s = trace[traceIdx].step;
          return (
            <li key={traceIdx}>
              <button
                type="button"
                className="engine-usage-btn"
                onClick={() => onJump(traceIdx)}
                title={`Jump to step: ${s.name}`}
              >
                <span className="engine-usage-name">{s.name}</span>
                <code className="engine-ref engine-usage-ref">{s.output}</code>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

interface StepDetailProps {
  step: Step;
  input: Table;
  inputRef: string;
  output: Table;
  headline?: ModelOutputDef;
  /** All table refs the op consumes (primary input + join right / union tables). */
  inputRefs: string[];
  resolveTable: (ref: string) => Table | undefined;
  usages: number[];
  trace: EvalResult['trace'];
  dateMap?: Map<number, string>;
  axis?: string;
  onJumpToRef: (ref: string) => void;
  onJumpToTraceIdx: (traceIdx: number) => void;
  onExpand: (title: string, table: Table, pivot?: boolean) => void;
  formulaEdit?: FormulaEditConfig;
}

function StepDetail({
  step, input, inputRef, output, headline, inputRefs, resolveTable,
  usages, trace, dateMap, axis, onJumpToRef, onJumpToTraceIdx, onExpand, formulaEdit,
}: StepDetailProps) {
  // Valid column names in the primary input — column references in the
  // formula that match these are clickable and jump to the input ref.
  const inputColumns = useMemo(
    () => new Set(input?.schema.columns.map((c) => c.name) ?? []),
    [input],
  );

  const handleColClick = (colName: string) => {
    if (inputColumns.has(colName)) onJumpToRef(inputRef);
  };

  return (
    <div className="engine-step-detail">
      <h3 className="engine-step-detail-title">
        {step.name}
        {headline && <span className="engine-headline-badge headline-inline" title="Declared headline output">★ headline</span>}
      </h3>
      <div className="engine-step-detail-varname">
        <code className="engine-ref">{step.output}</code>
      </div>
      <p className="engine-step-detail-desc">{step.description}</p>
      {headline && headline.description && (
        <p className="hint" style={{ margin: '4px 0 8px' }}>
          <strong>Renderer label:</strong> {headline.label} — {headline.description}
        </p>
      )}

      <div className="engine-section-label">Operation</div>
      <FormulaDisplay
        op={step.op}
        inputRef={inputRef}
        onColClick={handleColClick}
        onTableClick={onJumpToRef}
        inputColumns={inputColumns}
        formulaEdit={formulaEdit}
        stepOutput={step.output}
      />

      <div className="engine-section-label">Output <code className="engine-ref">{step.output}</code></div>
      <SourceTablePreview
        table={output}
        dateMap={dateMap}
        axis={axis}
        scrollable
        onExpand={() => onExpand(step.output, output, true)}
      />

      <details className="engine-input-collapse" open>
        <summary>
          <span className="engine-section-label">
            {inputRefs.length === 1 ? 'Input' : `Inputs (${inputRefs.length})`}
          </span>
        </summary>
        <ul className="engine-inputs-list">
          {inputRefs.map((ref, i) => {
            const t = resolveTable(ref);
            const isPrimary = ref === inputRef;
            return (
              <li key={ref + i} className="engine-input-item">
                <details className="engine-input-item-details">
                  <summary
                    className="engine-input-item-summary"
                    onClick={(e) => {
                      // The ref button is the "jump" affordance — clicking it
                      // should navigate, not toggle the table preview.
                      if ((e.target as HTMLElement).closest('.engine-ref-button')) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="engine-ref engine-ref-button"
                      onClick={() => onJumpToRef(ref)}
                      title={`Jump to ${ref}`}
                    >
                      {ref}
                    </button>
                    {!isPrimary && (
                      <span className="hint" style={{ fontSize: 10, marginLeft: 6 }}>
                        ({step.op.op === 'union' ? 'union member' : 'right side'})
                      </span>
                    )}
                    {t && (
                      <span className="hint engine-input-item-meta">
                        {t.rows.length.toLocaleString()} rows · {t.schema.columns.length} cols
                      </span>
                    )}
                  </summary>
                  {t && (
                    <div className="engine-input-item-body">
                      <SourceTablePreview
                        table={t}
                        dateMap={dateMap}
                        axis={axis}
                        scrollable
                        onExpand={() => onExpand(ref, t, true)}
                      />
                    </div>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      </details>

      <UsageList usages={usages} trace={trace} onJump={onJumpToTraceIdx} />
    </div>
  );
}

// ─── Pretty-print operations + expressions (with clickable col refs) ─────

type Tok =
  | { kind: 'text'; text: string }
  | { kind: 'col'; name: string }
  /** A reference to another table (the step's input, a join's right side,
   *  union members). Rendered as a clickable button that jumps to the ref. */
  | { kind: 'tableRef'; name: string };

interface FormulaDisplayProps {
  op: TableOp;
  /** The step's primary input ref — embedded into the formula so every op is
   *  self-contained (e.g. join shows `<input> ⨝ <right>`, filter shows
   *  "filter rows of `<input>` where ..."). */
  inputRef: string;
  inputColumns: Set<string>;
  onColClick: (name: string) => void;
  onTableClick: (ref: string) => void;
  /** When provided, an edit pencil appears on each editable formula line. */
  formulaEdit?: FormulaEditConfig;
  stepOutput: string;
}

function FormulaDisplay({ op, inputRef, onColClick, onTableClick, inputColumns, formulaEdit, stepOutput }: FormulaDisplayProps) {
  const p = prettyOp(op, inputRef);
  const slots = formulaEdit ? editSlots(op) : [];
  const [editingSlot, setEditingSlot] = useState<string | null>(null);
  // Close any open editor when navigating to a different step.
  useEffect(() => { setEditingSlot(null); }, [stepOutput]);

  const renderTok = (tok: Tok, j: number) => {
    if (tok.kind === 'text') return <span key={j}>{tok.text}</span>;
    if (tok.kind === 'tableRef') {
      return (
        <button
          key={j}
          type="button"
          className="engine-ref engine-ref-button"
          onClick={() => onTableClick(tok.name)}
          title={`Jump to ${tok.name}`}
        >
          {tok.name}
        </button>
      );
    }
    const clickable = inputColumns.has(tok.name);
    return (
      <button
        key={j}
        type="button"
        className={`engine-col-ref${clickable ? '' : ' is-disabled'}`}
        onClick={() => clickable && onColClick(tok.name)}
        title={clickable ? `Jump to source of "${tok.name}"` : `"${tok.name}" not on the input (probably joined or aggregated)`}
        disabled={!clickable}
      >
        {tok.name}
      </button>
    );
  };

  const structSlots = formulaEdit ? structuralSlots(op, inputRef) : [];

  // Render the pencil / modified / reset actions + inline editor for one slot.
  const slotControls = (s: EditSlot) => {
    if (!formulaEdit) return null;
    const overridden = !!formulaEdit.overrides[stepOutput]?.[s.slot];
    return (
      <>
        <span className="engine-formula-line-actions">
          {overridden && <span className="engine-formula-modified" title="Overridden vs the code default">modified</span>}
          {formulaEdit.enabled && (
            <button
              type="button"
              className="engine-formula-pencil"
              title="Edit"
              aria-label={`Edit ${s.label}`}
              onClick={() => setEditingSlot((cur) => (cur === s.slot ? null : s.slot))}
            >
              ✎
            </button>
          )}
          {overridden && (
            <button type="button" className="scenario-link" onClick={() => formulaEdit.onReset(stepOutput, s.slot)}>reset</button>
          )}
        </span>
        {editingSlot === s.slot && (
          <InlineFormulaEditor
            slot={s}
            inputColumns={inputColumns}
            onSave={(src) => {
              const e = formulaEdit.onSet(stepOutput, s.slot, src);
              if (!e) setEditingSlot(null);
              return e;
            }}
            onCancel={() => setEditingSlot(null)}
          />
        )}
      </>
    );
  };

  return (
    <div className="engine-formula">
      <div className="engine-formula-head">
        {p.head.map(renderTok)}
      </div>

      {structSlots.length > 0 && (
        <div className="engine-op-params">
          {structSlots.map((s) => (
            <div key={s.slot} className="engine-op-param">
              <span className="engine-op-param-label">{s.label}:</span>
              <code className="engine-op-param-val">{s.source || '(none)'}</code>
              {slotControls(s)}
            </div>
          ))}
        </div>
      )}

      {p.lines.length > 0 && (
        <div className="engine-formula-body">
          {p.lines.map((line, i) => {
            const s = slots[i]; // aligned 1:1 with lines for editable ops
            return (
              <div key={i} className="engine-formula-line">
                <span className="engine-formula-line-toks">{line.map(renderTok)}</span>
                {s && slotControls(s)}
              </div>
            );
          })}
        </div>
      )}

      {formulaEdit && slots.length === 0 && structSlots.length <= 1 && (
        <p className="hint engine-formula-note">
          Structural step — edit its input/parameters above; it has no per-cell formula.
        </p>
      )}
      {formulaEdit && !formulaEdit.enabled && (slots.length > 0 || structSlots.length > 0) && (
        <p className="hint engine-formula-note">
          Switch to the <strong>Base case</strong> scenario to edit (model edits apply to every scenario).
        </p>
      )}
    </div>
  );
}

function InlineFormulaEditor({ slot, inputColumns, onSave, onCancel }: {
  slot: EditSlot;
  inputColumns: Set<string>;
  /** Commit; returns an error string to show, or null on success. */
  onSave: (src: string) => string | null;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(slot.source);
  const [err, setErr] = useState<string | null>(null);

  const save = () => {
    // Cheap local validation for expressions/aggregations; structural ('text')
    // slots are validated when the parent re-evaluates the model.
    if (slot.kind === 'expr' || slot.kind === 'agg') {
      let cols: string[];
      try {
        cols = slot.kind === 'expr' ? collectColNames(parseExpr(draft)) : aggColNames(parseAgg(draft));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        return;
      }
      const unknown = cols.filter((c) => !inputColumns.has(c));
      if (unknown.length) {
        setErr(`Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — must be one of the input columns below.`);
        return;
      }
    }
    const e = onSave(draft);
    if (e) setErr(e);
  };

  const isExprLike = slot.kind === 'expr' || slot.kind === 'agg';

  return (
    <div className="engine-formula-editor">
      <textarea
        autoFocus
        className="engine-formula-input"
        value={draft}
        spellCheck={false}
        rows={isExprLike ? 3 : 1}
        onChange={(e) => { setDraft(e.target.value); setErr(null); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !isExprLike)) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
      />
      {err && <div className="engine-formula-err">{err}</div>}
      <div className="engine-formula-actions">
        <button className="btn" onClick={save}>Save{isExprLike ? ' (⌘↵)' : ' (↵)'}</button>
        <button className="scenario-link" onClick={onCancel}>Cancel</button>
      </div>
      <div className="hint engine-formula-cols">
        {slot.kind === 'agg' && 'Aggregation: fn(column) — sum, count, avg, min, max, first, last. '}
        {slot.hint && `${slot.hint}. `}
        {isExprLike && `Columns in scope: ${[...inputColumns].sort().join(', ') || '(none)'}`}
      </div>
    </div>
  );
}

const txt = (text: string): Tok => ({ kind: 'text', text });
const col = (name: string): Tok => ({ kind: 'col', name });
const tref = (name: string): Tok => ({ kind: 'tableRef', name });

/** Interleave a separator between tokens. */
function joinToks(parts: Tok[][], sep: string): Tok[] {
  const out: Tok[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(txt(sep));
    out.push(...p);
  });
  return out;
}

/** Render an aggregate as `name = fn(<originRef>.colName)`. The table-ref
 *  prefix makes the column's origin explicit (the same convention as join's
 *  `on <left>.k = <right>.k`). */
function aggTokens(name: string, a: AggExpr, originRef: string): Tok[] {
  const inner: Tok[] = a.column == null
    ? [txt('*')]
    : [tref(originRef), txt('.'), col(a.column)];
  return [txt(`${name} = ${a.fn}(`), ...inner, txt(')')];
}

/** Render a list of column names as comma-separated clickable col refs,
 *  falling back to `∅` when empty. */
function colList(cols: string[]): Tok[] {
  if (cols.length === 0) return [txt('∅')];
  return joinToks(cols.map((c) => [col(c)]), ', ');
}

function prettyOp(op: TableOp, inputRef: string): { head: Tok[]; lines: Tok[][] } {
  switch (op.op) {
    case 'select':
      return {
        head: [txt('select from '), tref(inputRef)],
        lines: [joinToks(op.columns.map((c) => [col(c)]), ', ')],
      };
    case 'rename':
      return {
        head: [txt('rename columns of '), tref(inputRef)],
        lines: Object.entries(op.renames).map(([f, t]) => [col(f), txt(' → ' + t)]),
      };
    case 'filter':
      return {
        head: [txt('filter rows of '), tref(inputRef), txt(' where')],
        lines: [exprTokens(op.predicate)],
      };
    case 'map':
      return {
        head: [txt('derive columns on '), tref(inputRef)],
        lines: Object.entries(op.columns).map(([n, e]) => [txt(n + ' = '), ...exprTokens(e)]),
      };
    case 'groupBy':
      return {
        head: [
          txt('groupBy '), tref(inputRef),
          txt(' keyed by ('), ...colList(op.keys), txt(')'),
        ],
        lines: Object.entries(op.aggs).map(([n, a]) => aggTokens(n, a, inputRef)),
      };
    case 'join': {
      const head: Tok[] = [
        txt(`${op.type} join `), tref(inputRef), txt(' ⨝ '), tref(op.right),
      ];
      if (op.type === 'cross' || op.on.length === 0) {
        return { head, lines: [[txt('(cross join — no on clause)')]] };
      }
      const lines = op.on.map((j) => [
        txt('on '),
        tref(inputRef), txt('.' + j.left),
        txt(' = '),
        tref(op.right), txt('.' + j.right),
      ]);
      return { head, lines };
    }
    case 'union': {
      const members = [inputRef, ...op.tables];
      return {
        head: [txt(`union of ${members.length} tables`)],
        lines: members.map((r) => [tref(r)]),
      };
    }
    case 'sort':
      return {
        head: [txt('sort '), tref(inputRef), txt(' by')],
        lines: [joinToks(op.by.map((b) => [col(b.column), txt(b.desc ? ' desc' : '')]), ', ')],
      };
    case 'limit':
      return {
        head: [txt(`limit `), tref(inputRef), txt(` to ${op.n} rows`)],
        lines: [],
      };
    case 'window':
      return {
        head: [
          txt('window over '), tref(inputRef),
          txt(' (partition by '), ...colList(op.partitionBy),
          txt(', order by '), col(op.orderBy),
          txt(`, range [-${op.range.preceding}, +${op.range.following}])`),
        ],
        lines: Object.entries(op.derive).map(([n, a]) => aggTokens(n, a, inputRef)),
      };
  }
}

function exprTokens(e: Expr): Tok[] {
  switch (e.node) {
    case 'col':
      return [{ kind: 'col', name: e.name }];
    case 'lit':
      if (e.value === null) return [{ kind: 'text', text: 'null' }];
      if (typeof e.value === 'string') return [{ kind: 'text', text: `"${e.value}"` }];
      if (typeof e.value === 'boolean') return [{ kind: 'text', text: e.value ? 'true' : 'false' }];
      return [{ kind: 'text', text: String(e.value) }];
    case 'unary':
      return [
        { kind: 'text', text: e.op === '-' ? '-' : 'not(' },
        ...exprTokens(e.operand),
        ...(e.op === 'not' ? [{ kind: 'text' as const, text: ')' }] : []),
      ];
    case 'binary': {
      const opSym = e.op === 'and' ? ' and ' : e.op === 'or' ? ' or ' : ` ${e.op} `;
      return [
        { kind: 'text', text: '(' },
        ...exprTokens(e.left),
        { kind: 'text', text: opSym },
        ...exprTokens(e.right),
        { kind: 'text', text: ')' },
      ];
    }
    case 'fn': {
      const out: Tok[] = [{ kind: 'text', text: `${e.name}(` }];
      e.args.forEach((a, i) => {
        if (i > 0) out.push({ kind: 'text', text: ', ' });
        out.push(...exprTokens(a));
      });
      out.push({ kind: 'text', text: ')' });
      return out;
    }
  }
}

// ─── Generic table previews (flat + pivot) ───────────────────────────────

interface TablePreviewProps {
  table: Table;
  maxRows?: number;
  onExpand?: () => void;
  /** When true, render every row but bound the wrapper height so the user can
   *  scroll inside the preview. The "view full table" link is shown as a
   *  separate footer instead of a "more rows" pseudo-row. */
  scrollable?: boolean;
  edit?: EditConfig;
}

function TablePreview({ table, maxRows = 10, onExpand, scrollable, edit }: TablePreviewProps) {
  if (!table) return <span className="hint">(table not yet materialized)</span>;
  const cols = table.schema.columns;
  const idSet = new Set(edit?.idKeys ?? []);
  const shown = scrollable
    ? table.rows
    : Number.isFinite(maxRows) ? table.rows.slice(0, maxRows) : table.rows;
  const more = table.rows.length - shown.length;
  return (
    <>
      <div className={`engine-table-scroll${scrollable ? ' engine-table-scroll--bounded' : ''}`}>
        <table className="yearly-emp-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.name} title={`${c.type}${c.description ? ' — ' + c.description : ''}`}>
                  {c.name} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{c.type[0]}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => {
                  // Editable when an edit config is present and the column is a
                  // value (not an identity key, which addresses the row).
                  const canEdit = !!edit && !idSet.has(c.name);
                  return (
                    <td key={c.name} style={{ textAlign: c.type === 'number' ? 'right' : 'left' }}>
                      {canEdit ? (
                        <EditableCell
                          value={row[c.name]}
                          type={c.type}
                          onCommit={(v) => edit!.onEdit({
                            source: edit!.source,
                            identity: rowIdentity(row, edit!.idKeys),
                            col: c.name,
                            value: v,
                          })}
                        />
                      ) : (
                        formatCell(row[c.name], c.type)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {more > 0 && !scrollable && (
              <tr>
                <td colSpan={cols.length} style={{ padding: 0 }}>
                  {onExpand ? (
                    <button
                      type="button"
                      onClick={onExpand}
                      style={{
                        width: '100%', padding: '6px 8px', border: 'none',
                        background: 'transparent', color: 'var(--accent)',
                        cursor: 'pointer', fontStyle: 'italic', fontSize: 12,
                        textAlign: 'left',
                      }}
                    >
                      … {more} more rows — click to view full table
                    </button>
                  ) : (
                    <span style={{
                      display: 'inline-block', padding: '6px 8px',
                      color: 'var(--muted)', fontStyle: 'italic',
                    }}>
                      … {more} more rows
                    </span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {scrollable && onExpand && (
        <ViewFullFooter rows={table.rows.length} onExpand={onExpand} />
      )}
    </>
  );
}

function ViewFullFooter({ rows, onExpand }: { rows: number; onExpand: () => void }) {
  return (
    <button type="button" className="engine-view-full" onClick={onExpand}>
      View full table ({rows.toLocaleString()} rows)
    </button>
  );
}

function formatCell(v: unknown, type: string): string {
  if (v == null) return '';
  if (type === 'number' && typeof v === 'number') return Math.round(v).toLocaleString();
  return String(v);
}

/** A value cell that turns into a text input on click and commits on
 *  Enter/blur. Number cells reject non-numeric input. */
function EditableCell({ value, type, onCommit }: {
  value: CellValue;
  type: string;
  onCommit: (v: number | string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <span
        className="engine-editable-cell"
        title="Click to edit"
        onClick={() => { setDraft(value == null ? '' : String(value)); setEditing(true); }}
      >
        {formatCell(value, type) || <span className="engine-editable-empty">—</span>}
      </span>
    );
  }

  const commit = () => {
    setEditing(false);
    if (type === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || Number.isNaN(n)) return; // reject; keep prior value
      onCommit(n);
    } else {
      onCommit(draft);
    }
  };

  return (
    <input
      autoFocus
      className="engine-edit-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
      }}
      style={{ width: '100%', textAlign: type === 'number' ? 'right' : 'left' }}
    />
  );
}

// ─── Formula definition editor (all step types) ─────────────────────────────

/** One editable slot within a step — an expression (map column / agg / filter
 *  predicate) or a structural parameter (`text`, e.g. window range, join keys). */
interface EditSlot { slot: string; label: string; kind: 'expr' | 'agg' | 'text'; source: string; hint?: string }

/** The editable expressions a step exposes (the formula lines). Structural ops
 *  (join / select / rename / sort / limit / union) have none of these. */
function editSlots(op: TableOp): EditSlot[] {
  switch (op.op) {
    case 'map':
      return Object.entries(op.columns).map(([c, e]) => ({ slot: c, label: c, kind: 'expr', source: exprToSource(e) }));
    case 'filter':
      return [{ slot: FILTER_SLOT, label: 'keep rows where', kind: 'expr', source: exprToSource(op.predicate) }];
    case 'groupBy':
      return Object.entries(op.aggs).map(([c, a]) => ({ slot: c, label: c, kind: 'agg', source: aggToSource(a) }));
    case 'window':
      return Object.entries(op.derive).map(([c, a]) => ({ slot: c, label: c, kind: 'agg', source: aggToSource(a) }));
    default:
      return [];
  }
}

/** The editable *structural* parameters of a step's operation — the "Operation"
 *  line. Includes the input table for every step, plus op-specific wiring. */
function structuralSlots(op: TableOp, inputRef: string): EditSlot[] {
  const out: EditSlot[] = [];
  const t = (slot: string, label: string, source: string, hint: string) => out.push({ slot, label, kind: 'text', source, hint });
  t(STRUCT.input, 'input table', inputRef, 'a table name');
  switch (op.op) {
    case 'groupBy':
      t(STRUCT.keys, 'group by', op.keys.join(', '), 'comma-separated columns');
      break;
    case 'window':
      t(STRUCT.partitionBy, 'partition by', op.partitionBy.join(', '), 'columns, comma-separated (empty = whole table)');
      t(STRUCT.orderBy, 'order by', op.orderBy, 'a single column');
      t(STRUCT.range, 'range', `${op.range.preceding}, ${op.range.following}`, 'preceding, following (rows). e.g. "11, 0" = trailing 12');
      break;
    case 'join':
      t(STRUCT.right, 'right table', op.right, 'a table name');
      t(STRUCT.type, 'join type', op.type, 'inner | left | cross');
      if (op.type !== 'cross') t(STRUCT.on, 'on', op.on.map((o) => `${o.left}=${o.right}`).join(', '), 'left=right, comma-separated');
      break;
    case 'select':
      t(STRUCT.columns, 'columns', op.columns.join(', '), 'comma-separated columns to keep');
      break;
    case 'rename':
      t(STRUCT.renames, 'renames', Object.entries(op.renames).map(([f, to]) => `${f}=${to}`).join(', '), 'from=to, comma-separated');
      break;
    case 'sort':
      t(STRUCT.by, 'sort by', op.by.map((b) => b.column + (b.desc ? ' desc' : '')).join(', '), 'col [desc], comma-separated');
      break;
    case 'limit':
      t(STRUCT.n, 'limit', String(op.n), 'number of rows');
      break;
    case 'union':
      t(STRUCT.members, 'members', op.tables.join(', '), 'comma-separated table names');
      break;
  }
  return out;
}

/** All distinct column names referenced by an expression. */
function collectColNames(e: Expr, out: Set<string> = new Set()): string[] {
  switch (e.node) {
    case 'col': out.add(e.name); break;
    case 'unary': collectColNames(e.operand, out); break;
    case 'binary': collectColNames(e.left, out); collectColNames(e.right, out); break;
    case 'fn': e.args.forEach((a) => collectColNames(a, out)); break;
  }
  return [...out];
}

interface SourceTablePreviewProps {
  table: Table;
  maxRows?: number;
  onExpand?: () => void;
  dateMap?: Map<number, string>;
  /** Column to spread across the x-axis. Caller passes `model.defaultAxis`;
   *  when undefined or absent from the table's schema, falls back to the
   *  flat row-per-record `TablePreview`. */
  axis?: string;
  /** Bound the wrapper height and let the preview scroll vertically. The
   *  "view full table" link is shown as a separate footer. */
  scrollable?: boolean;
  edit?: EditConfig;
}

/**
 * When the table contains `axis` as a column, renders a pivot with:
 *   - row-key columns:   every non-axis, non-numeric column
 *   - metric column:     the value-column name (shown when there's more than
 *                        one value column, or no row keys at all)
 *   - axis columns:      every distinct value of `axis`, in sorted order
 *
 * One row is emitted per (key combo × value column), so multi-metric tables
 * like `active_by_ta_type_month` (with both `starts` and `active`) get one
 * row per metric.
 */
function SourceTablePreview({ table, maxRows = 5, onExpand, dateMap, axis, scrollable, edit }: SourceTablePreviewProps) {
  if (!table) return <span className="hint">(table not yet materialized)</span>;
  const pivot = axis ? detectPivot(table, axis) : null;
  if (!pivot || !axis) return <TablePreview table={table} maxRows={maxRows} onExpand={onExpand} scrollable={scrollable} edit={edit} />;

  const { keyCols, valueCols } = pivot;
  const showMetricCol = valueCols.length > 1 || keyCols.length === 0;

  // Collect distinct axis values + build (keyCombo × valueCol) → axis → cell.
  // Rows in the input fan out: one input row contributes to one cell per value
  // column for the row's (key combo, axis value).
  type Row = { keyValues: CellValue[]; metric: string; metricType: string; byAxis: Map<string, CellValue> };
  const rows = new Map<string, Row>();
  const axisSet = new Set<string>();
  const axisNumeric = (table.schema.columns.find((c) => c.name === axis)?.type) === 'number';

  for (const r of table.rows) {
    const av = r[axis];
    if (av == null) continue;
    const ak = String(av);
    axisSet.add(ak);
    const keyPart = keyCols.map((c) => String(r[c.name] ?? '')).join('\x1f');
    for (const vc of valueCols) {
      const fullKey = keyPart + '\x1f' + vc.name;
      if (!rows.has(fullKey)) {
        rows.set(fullKey, {
          keyValues: keyCols.map((c) => r[c.name] ?? null),
          metric: vc.name,
          metricType: vc.type,
          byAxis: new Map(),
        });
      }
      rows.get(fullKey)!.byAxis.set(ak, r[vc.name]);
    }
  }

  const axisValues = [...axisSet].sort((a, b) => {
    if (axisNumeric) return Number(a) - Number(b);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const allRows = [...rows.values()];
  const shown = scrollable
    ? allRows
    : Number.isFinite(maxRows) ? allRows.slice(0, maxRows) : allRows;
  const more = allRows.length - shown.length;
  const totalCols = keyCols.length + (showMetricCol ? 1 : 0) + axisValues.length;

  const renderAxisHeader = (ak: string) => {
    if (axis === 'month_idx' && dateMap) return dateMap.get(Number(ak)) ?? `m${ak}`;
    return ak;
  };

  return (
    <>
      <div className="engine-pivot-axes">
        <span>
          <span className="engine-pivot-axes-label">x-axis:</span>{' '}
          <code className="engine-pivot-axes-name">{axis}</code>
        </span>
        <span>
          <span className="engine-pivot-axes-label">
            {valueCols.length === 1 ? 'value:' : 'values:'}
          </span>{' '}
          {valueCols.map((c, i) => (
            <span key={c.name}>
              {i > 0 && <span style={{ color: 'var(--muted)' }}>, </span>}
              <code className="engine-pivot-axes-name">{c.name}</code>
            </span>
          ))}
        </span>
      </div>
      <div className={`engine-table-scroll${scrollable ? ' engine-table-scroll--bounded' : ''}`}>
        <table className="yearly-emp-table engine-pivot-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              {keyCols.map((c) => (
                <th key={c.name} className="engine-pivot-key" title={`${c.type}${c.description ? ' — ' + c.description : ''}`}>
                  {c.name}
                </th>
              ))}
              {showMetricCol && (
                <th className="engine-pivot-key engine-pivot-metric-col" title="value column name">metric</th>
              )}
              {axisValues.map((v) => (
                <th key={v} className="engine-pivot-month" title={`${axis} = ${v}`}>
                  {renderAxisHeader(v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>
                {r.keyValues.map((v, j) => (
                  <td key={keyCols[j].name} className="engine-pivot-key" style={{ textAlign: 'left' }}>
                    {formatCell(v, keyCols[j].type)}
                  </td>
                ))}
                {showMetricCol && (
                  <td className="engine-pivot-key engine-pivot-metric-col" style={{ textAlign: 'left' }}>
                    <code className="engine-ref" style={{ marginLeft: 0 }}>{r.metric}</code>
                  </td>
                )}
                {axisValues.map((v) => (
                  <td key={v} style={{ textAlign: 'right' }}>
                    {edit ? (
                      <EditableCell
                        value={r.byAxis.get(v) ?? null}
                        type={r.metricType}
                        onCommit={(val) => {
                          const identity: Record<string, string | number> = {};
                          keyCols.forEach((c, j) => {
                            const kv = r.keyValues[j];
                            if (typeof kv === 'number' || typeof kv === 'string') identity[c.name] = kv;
                          });
                          identity[axis] = axisNumeric ? Number(v) : v;
                          edit.onEdit({ source: edit.source, identity, col: r.metric, value: val });
                        }}
                      />
                    ) : (
                      formatCell(r.byAxis.get(v) ?? null, r.metricType)
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {more > 0 && !scrollable && (
              <tr>
                <td colSpan={totalCols} style={{ padding: 0 }}>
                  {onExpand ? (
                    <button
                      type="button"
                      onClick={onExpand}
                      style={{
                        width: '100%', padding: '6px 8px', border: 'none',
                        background: 'transparent', color: 'var(--accent)',
                        cursor: 'pointer', fontStyle: 'italic', fontSize: 12,
                        textAlign: 'left',
                      }}
                    >
                      … {more} more rows — click to view full table
                    </button>
                  ) : (
                    <span style={{
                      display: 'inline-block', padding: '6px 8px',
                      color: 'var(--muted)', fontStyle: 'italic',
                    }}>
                      … {more} more rows
                    </span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {scrollable && onExpand && (
        <ViewFullFooter rows={allRows.length} onExpand={onExpand} />
      )}
    </>
  );
}

function detectPivot(
  table: Table,
  axis: string,
): { keyCols: Column[]; valueCols: Column[] } | null {
  const cols = table.schema.columns;
  if (!cols.find((c) => c.name === axis)) return null;
  const others = cols.filter((c) => c.name !== axis);
  const valueCols = others.filter((c) => c.type === 'number');
  // Drop string cols that are 1:1 with the axis (e.g. `date` ↔ `month_idx`).
  // Keeping them in keyCols fans the pivot out to one row per input row,
  // which blows the DOM up for tables like per_employee_monthly_cost.
  const keyCols = others
    .filter((c) => c.type !== 'number')
    .filter((c) => !isAxisDependent(table, c.name, axis));
  if (valueCols.length === 0) return null;
  return { keyCols, valueCols };
}

function isAxisDependent(table: Table, col: string, axis: string): boolean {
  const mapping = new Map<string, string>();
  for (const r of table.rows) {
    const a = String(r[axis] ?? '');
    const v = String(r[col] ?? '');
    const prev = mapping.get(a);
    if (prev === undefined) mapping.set(a, v);
    else if (prev !== v) return false;
  }
  return true;
}
