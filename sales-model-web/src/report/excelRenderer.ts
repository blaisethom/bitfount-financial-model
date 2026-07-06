// Excel renderer for ReportDef (option B: inline formulas).
//
// Renders a workbook whose visible sheets mirror the original spreadsheet's
// shape: one sheet per ReportSection, manual inputs sit as editable cells on
// the sheet where users expect them, and every derived cell carries a real
// Excel formula that traces back to canonical input cells.
//
// Architecture
// ────────────
//
//   1. CellAddressBook records every rendered cell as
//      (tableRef, identityKey, col) → SheetN!Cm.
//
//   2. Canonical blocks (manual sources, or derived blocks explicitly marked
//      canonical) are rendered first by value. Each cell is recorded in the
//      address book.
//
//   3. Derived blocks emit Excel formulas by walking the engine step graph.
//      For each output cell, the inline emitter recursively expands the chain
//      of ops, terminating at an address already in the book (a previously-
//      rendered cell). Range-based aggregations (window, groupBy) require
//      their input to be addressed; pure pointwise ops (map, select, rename,
//      cross) can chain through arbitrary depth.
//
// Identity columns
// ────────────────
//
// Each table has an "identity": the column tuple that uniquely identifies a
// row. Sources declare it; steps inherit and transform it based on their op
// (select/rename projects, groupBy replaces with keys, map/window/join/cross
// pass through). The address book is keyed by identity-tuple → row.

import ExcelJS from 'exceljs';
import type {
  CellValue, EvalResult, ModelDef, Row, Step, Table, TableOp,
} from '../engine';
import { emitExprFormula, quoteSheet } from '../engine';
import type { ColumnLetterMap } from '../engine';
import type {
  CellFormat, ReportBlock, ReportDef, ReportSection, TableBlock,
  TitleBlock, ParagraphBlock, SpacerBlock,
} from './types';
import { IdentityResolver, SOURCE_IDENTITY } from './identity';

const FMT: Record<CellFormat, string> = {
  money: '"$"#,##0',
  count: '0',
  integer: '0',
  percent: '0.00%',
  text: '@',
};

function escapeSheetName(s: string): string {
  return s.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
}

function colLetter(n: number): string {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function fmtKey(values: Array<CellValue>): string {
  return values.map((v) => String(v ?? '')).join('\x1f');
}

// ─── Cell address book ───────────────────────────────────────────────────

interface CellAddress { sheet: string; row: number; col: string; }

class CellAddressBook {
  // tableRef → identityKey → col → address
  private cells = new Map<string, Map<string, Map<string, CellAddress>>>();

  record(tableRef: string, identityValues: CellValue[], col: string, addr: CellAddress): void {
    let byKey = this.cells.get(tableRef);
    if (!byKey) { byKey = new Map(); this.cells.set(tableRef, byKey); }
    const k = fmtKey(identityValues);
    let byCol = byKey.get(k);
    if (!byCol) { byCol = new Map(); byKey.set(k, byCol); }
    byCol.set(col, addr);
  }

  lookup(tableRef: string, identityValues: CellValue[], col: string): CellAddress | null {
    const byKey = this.cells.get(tableRef);
    if (!byKey) return null;
    const byCol = byKey.get(fmtKey(identityValues));
    if (!byCol) return null;
    return byCol.get(col) ?? null;
  }

  has(tableRef: string): boolean { return this.cells.has(tableRef); }
}

function fmtAddr(a: CellAddress): string {
  return `${quoteSheet(a.sheet)}!${a.col}${a.row}`;
}

function addrEq(a: CellAddress | null, b: CellAddress | null): boolean {
  if (!a || !b) return false;
  return a.sheet === b.sheet && a.row === b.row && a.col === b.col;
}

/**
 * After recording an address at a rendered cell, walk the producing step
 * graph upstream and record the same address at any equivalent ref where the
 * column / identity pass through unchanged. Lets later inline emissions hit
 * the rendered cell directly instead of re-deriving from sources.
 */
function propagateAddressUpstream(
  model: ModelDef,
  evalResult: EvalResult,
  identityRes: IdentityResolver,
  book: CellAddressBook,
  ref: string,
  rowIdentity: Record<string, CellValue>,
  col: string,
  addr: CellAddress,
): void {
  const seen = new Set<string>();
  const visit = (curRef: string, curCol: string, curIdentity: Record<string, CellValue>): void => {
    const stepKey = `${curRef}::${curCol}::${fmtKey(Object.values(curIdentity))}`;
    if (seen.has(stepKey)) return;
    seen.add(stepKey);
    const step = model.steps.find((s) => s.id === curRef);
    if (!step) return;

    let nextCol: string | null = curCol;
    const nextIdentity = { ...curIdentity };

    switch (step.op.op) {
      case 'select': {
        const cols = (step.op as { columns: string[] }).columns;
        if (!cols.includes(curCol)) return;
        break;
      }
      case 'rename': {
        const renames = (step.op as { renames: Record<string, string> }).renames;
        const reverse = Object.entries(renames).find(([_, out]) => out === curCol)?.[0];
        nextCol = reverse ?? curCol;
        break;
      }
      case 'map': {
        const cols = (step.op as { columns: Record<string, unknown> }).columns;
        if (curCol in cols) return; // derived column
        break;
      }
      case 'window': {
        const derive = (step.op as { derive: Record<string, unknown> }).derive;
        if (curCol in derive) return; // derived column
        break;
      }
      case 'groupBy':
        return; // many-to-one; can't propagate to a single input row
      case 'join': {
        const left = evalResult.tables[step.input];
        if (left.schema.columns.find((c) => c.name === curCol)) {
          // col is on left side, identity preserved
          break;
        }
        return; // right-side cols don't propagate cleanly
      }
      default: return;
    }

    if (nextCol === null) return;
    const inputIdCols = identityRes.for(step.input);
    const inputIdVals = inputIdCols.map((c) => nextIdentity[c]);
    book.record(step.input, inputIdVals, nextCol, addr);
    visit(step.input, nextCol, nextIdentity);
  };
  visit(ref, col, rowIdentity);
}

// ─── Inline formula emitter ──────────────────────────────────────────────

class InlineEmitter {
  private model: ModelDef;
  private evalResult: EvalResult;
  private book: CellAddressBook;
  private identity: IdentityResolver;
  /** During a top-level emit for a derived cell, this holds that cell's
   *  address; any address-book lookup pointing back to it is suppressed so the
   *  emitter walks through the step rather than emitting `=B5` in cell B5. */
  private excludeAddr: CellAddress | null = null;
  /** Identity of the cell whose formula is currently being emitted. Used to
   *  decide whether a reference is "axis-tracking" (e.g. shares the same
   *  month_idx, so column should be relative for paste-shifts) or fixed
   *  (pricing, assumptions — column should be `$`-locked). */
  private outputIdentity: Record<string, CellValue> | null = null;
  constructor(model: ModelDef, evalResult: EvalResult, book: CellAddressBook, identity: IdentityResolver) {
    this.model = model;
    this.evalResult = evalResult;
    this.book = book;
    this.identity = identity;
  }

  /** Top-level emission for a derived cell at `addr`. */
  emitForDerivedCell(addr: CellAddress, tableRef: string, identity: Record<string, CellValue>, col: string): string {
    this.excludeAddr = addr;
    this.outputIdentity = identity;
    try {
      const step = this.model.steps.find((s) => s.id === tableRef);
      if (!step) return this.literalValueOf(tableRef, identity, col);
      return this.emitStep(step, identity, col);
    } finally {
      this.excludeAddr = null;
      this.outputIdentity = null;
    }
  }

  /**
   * Format a cross-sheet cell reference with `$` markers appropriate for
   * copy-paste in Excel.
   *   - Column relative when the reference's `month_idx` matches the formula
   *     cell's `month_idx` (the reference moves with us along the axis).
   *   - Column absolute (`$`) otherwise (pricing / assumptions / cross-TA).
   *   - Row relative when the reference is on the same row as the formula
   *     cell, otherwise absolute.
   * Falls back to bare `Sheet!Col Row` outside a top-level emission.
   */
  private formatRef(addr: CellAddress, refIdentity: Record<string, CellValue>): string {
    if (!this.excludeAddr || !this.outputIdentity) return fmtAddr(addr);
    const axisCol = 'month_idx';
    const outAxis = this.outputIdentity[axisCol];
    const refAxis = refIdentity[axisCol];
    const colTracks = outAxis !== undefined && refAxis !== undefined && outAxis === refAxis;
    const rowTracks = this.excludeAddr.row === addr.row;
    const colMark = colTracks ? '' : '$';
    const rowMark = rowTracks ? '' : '$';
    return `${quoteSheet(addr.sheet)}!${colMark}${addr.col}${rowMark}${addr.row}`;
  }

  /** Emit a formula string (no leading `=`) for table[identity].col. */
  emit(tableRef: string, identity: Record<string, CellValue>, col: string): string {
    // Recorded canonical / pre-rendered cell wins, unless it's the cell whose
    // own formula we're currently emitting (would yield a self-reference).
    const idCols = this.identity.for(tableRef);
    const idVals = idCols.map((c) => identity[c]);
    const direct = this.book.lookup(tableRef, idVals, col);
    if (direct && !addrEq(direct, this.excludeAddr)) return this.formatRef(direct, identity);

    // Otherwise walk the producing step.
    const step = this.model.steps.find((s) => s.id === tableRef);
    if (!step) {
      // No producing step and not addressed: fall back to literal value.
      return this.literalValueOf(tableRef, identity, col);
    }
    return this.emitStep(step, identity, col);
  }

  private literalValueOf(tableRef: string, identity: Record<string, CellValue>, col: string): string {
    const t = this.evalResult.tables[tableRef];
    if (!t) return '0';
    const idCols = this.identity.for(tableRef);
    const row = t.rows.find((r) => idCols.every((k) => r[k] === identity[k]));
    if (!row) return '0';
    const v = row[col];
    if (v === null || v === undefined) return '0';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
    return `"${String(v).replace(/"/g, '""')}"`;
  }

  private emitStep(step: Step, identity: Record<string, CellValue>, col: string): string {
    switch (step.op.op) {
      case 'map':     return this.emitMap(step, identity, col);
      case 'select':  return this.emit(step.input, identity, col);
      case 'rename':  return this.emitRename(step, identity, col);
      case 'window':  return this.emitWindow(step, identity, col);
      case 'groupBy': return this.emitGroupBy(step, identity, col);
      case 'join':    return this.emitJoin(step, identity, col);
      default:        return this.literalValueOf(step.id, identity, col);
    }
  }

  private emitMap(step: Step, identity: Record<string, CellValue>, col: string): string {
    const op = step.op as Extract<TableOp, { op: 'map' }>;
    const expr = op.columns[col];
    if (!expr) return this.emit(step.input, identity, col);

    // emitExprFormula takes a (colName → letterRef) map + a row index. We
    // override its column lookup so each col ref expands into the inline
    // formula for that input cell.
    const inputTable = this.evalResult.tables[step.input];
    const refs: ColumnLetterMap = {};
    for (const c of inputTable.schema.columns) {
      // Sentinel mapping: emitExprFormula will append the row index.
      refs[c.name] = `__INLINE_${c.name}__`;
    }
    const raw = emitExprFormula(expr, 0, refs);
    // Replace each sentinel + row-zero suffix with the inline formula for that col.
    return raw.replace(/__INLINE_([A-Za-z_][A-Za-z0-9_]*)__0/g, (_m, c) => {
      const sub = this.emit(step.input, identity, c);
      return needsParens(sub) ? `(${sub})` : sub;
    });
  }

  private emitRename(step: Step, identity: Record<string, CellValue>, col: string): string {
    const op = step.op as Extract<TableOp, { op: 'rename' }>;
    // Reverse-map renames: output col → input col.
    const inputCol = Object.entries(op.renames).find(([_, out]) => out === col)?.[0] ?? col;
    return this.emit(step.input, identity, inputCol);
  }

  private emitWindow(step: Step, identity: Record<string, CellValue>, col: string): string {
    const op = step.op as Extract<TableOp, { op: 'window' }>;
    const derived = op.derive[col];
    if (!derived) return this.emit(step.input, identity, col);
    if (derived.fn !== 'sum' || !derived.column) {
      return this.literalValueOf(step.id, identity, col);
    }
    // Build the partition key + walk order values in [-preceding, +following].
    const partitionId: Record<string, CellValue> = {};
    for (const k of op.partitionBy) partitionId[k] = identity[k];
    const orderVal = Number(identity[op.orderBy]);
    const inputTable = this.evalResult.tables[step.input];
    const idCols = this.identity.for(step.input);
    const cellsWithId: Array<{ addr: CellAddress; identity: Record<string, CellValue> }> = [];
    const inlineFormulas: string[] = [];
    for (let k = -op.range.preceding; k <= op.range.following; k++) {
      const v = orderVal + k;
      const child: Record<string, CellValue> = { ...partitionId, [op.orderBy]: v };
      // Skip months / partition slots that don't exist in the input table. The
      // engine evaluator only sums rows whose orderBy is in range AND that
      // exist; the formula emitter must match — otherwise it inlines a
      // recursive formula chain that evaluates to 0 but bloats the cell well
      // past Excel's 8192-char limit.
      const rowExists = inputTable.rows.some((r) =>
        idCols.every((c) => r[c] === child[c]),
      );
      if (!rowExists) continue;
      // Is the input addressed? Then collect for range SUM.
      const idVals = idCols.map((c) => child[c]);
      const addr = this.book.lookup(step.input, idVals, derived.column);
      if (addr && !addrEq(addr, this.excludeAddr)) {
        cellsWithId.push({ addr, identity: child });
      } else {
        // Fall back to inline-emitting each individual cell formula.
        const f = this.emit(step.input, child, derived.column);
        if (f !== '0' && f !== '') inlineFormulas.push(f);
      }
    }
    const cells = cellsWithId.map((c) => c.addr);
    if (cells.length === 1 && !inlineFormulas.length) {
      return this.formatRef(cellsWithId[0].addr, cellsWithId[0].identity);
    }
    if (cells.length && !inlineFormulas.length) return rangeSum(cells);
    if (!cells.length && inlineFormulas.length) {
      return inlineFormulas.length === 1 ? inlineFormulas[0] : `(${inlineFormulas.join('+')})`;
    }
    // Mixed — both addressed and inline.
    const parts = [...(cells.length ? [rangeSum(cells)] : []), ...inlineFormulas];
    if (parts.length === 0) return '0';
    return parts.length === 1 ? parts[0] : `(${parts.join('+')})`;
  }

  private emitGroupBy(step: Step, identity: Record<string, CellValue>, col: string): string {
    const op = step.op as Extract<TableOp, { op: 'groupBy' }>;
    // Pass through key columns directly.
    if (op.keys.includes(col)) {
      const v = identity[col];
      if (typeof v === 'number') return String(v);
      return `"${String(v).replace(/"/g, '""')}"`;
    }
    const agg = op.aggs[col];
    if (!agg) return '0';

    // Find all input rows matching the group key.
    const inputTable = this.evalResult.tables[step.input];
    const inputIdCols = this.identity.for(step.input);
    const matching = inputTable.rows.filter((r) =>
      op.keys.every((k) => r[k] === identity[k]),
    );

    if (agg.fn === 'sum') {
      if (!agg.column) return '0';

      // Prefer a contiguous range SUM if all matching rows are addressed and
      // contiguous in the same sheet/col.
      const addrsWithId: Array<{ addr: CellAddress; identity: Record<string, CellValue> }> = [];
      const inlines: string[] = [];
      for (const r of matching) {
        const rowId: Record<string, CellValue> = {};
        for (const c of inputIdCols) rowId[c] = r[c];
        const idVals = inputIdCols.map((c) => rowId[c]);
        const addr = this.book.lookup(step.input, idVals, agg.column);
        if (addr && !addrEq(addr, this.excludeAddr)) addrsWithId.push({ addr, identity: rowId });
        else inlines.push(this.emit(step.input, rowId, agg.column));
      }
      const addrs = addrsWithId.map((a) => a.addr);
      if (addrs.length === 1 && !inlines.length) {
        return this.formatRef(addrsWithId[0].addr, addrsWithId[0].identity);
      }
      if (addrs.length && !inlines.length) return rangeSum(addrs);
      if (!addrs.length && inlines.length) {
        const filtered = inlines.filter((x) => x !== '0' && x !== '');
        if (!filtered.length) return '0';
        return filtered.length === 1 ? filtered[0] : `(${filtered.join('+')})`;
      }
      const parts = [...(addrs.length ? [rangeSum(addrs)] : []), ...inlines.filter((x) => x !== '0' && x !== '')];
      if (parts.length === 0) return '0';
      return parts.length === 1 ? parts[0] : `(${parts.join('+')})`;
    }

    if (agg.fn === 'count') {
      return String(matching.length);
    }

    return this.literalValueOf(step.id, identity, col);
  }

  private emitJoin(step: Step, identity: Record<string, CellValue>, col: string): string {
    const op = step.op as Extract<TableOp, { op: 'join' }>;
    const left = this.evalResult.tables[step.input];
    if (left.schema.columns.find((c) => c.name === col)) {
      // Column on the left: same identity, same col.
      return this.emit(step.input, identity, col);
    }

    // Column on the right — find the matching right row using join keys.
    const rightTable = this.evalResult.tables[op.right];
    const rightIdCols = this.identity.for(op.right);

    if (op.type === 'cross') {
      // Cross-join: each output row is (left_row × right_row). Look up the
      // matching right row by reading the right-identity values out of the
      // (now extended) output identity.
      if (rightTable.rows.length === 1) {
        const rowId: Record<string, CellValue> = {};
        for (const c of rightIdCols) rowId[c] = rightTable.rows[0][c];
        return this.emit(op.right, rowId, col);
      }
      const rowId: Record<string, CellValue> = {};
      for (const c of rightIdCols) rowId[c] = identity[c];
      return this.emit(op.right, rowId, col);
    }

    // Look up the right-side row by matching all on-clause keys.
    const match = rightTable.rows.find((r) =>
      op.on.every((j) => r[j.right] === identity[j.left]),
    );
    if (!match) return '0';
    const rowId: Record<string, CellValue> = {};
    for (const c of rightIdCols) rowId[c] = match[c];
    return this.emit(op.right, rowId, col);
  }
}

function needsParens(formula: string): boolean {
  if (!formula) return false;
  if (formula.startsWith('(') && formula.endsWith(')')) return false;
  if (/^\$?[A-Z]+\$?\d+$/.test(formula)) return false;             // bare ref (possibly $)
  if (/^'[^']+'!\$?[A-Z]+\$?\d+$/.test(formula)) return false;     // cross-sheet ref (possibly $)
  if (/^[A-Z][A-Z_.]*\([^)]*\)$/.test(formula)) return false;      // single function call
  if (/^-?\d+(\.\d+)?$/.test(formula)) return false;               // number
  if (/^"[^"]*"$/.test(formula)) return false;                     // string lit
  if (/^[+\-]?[A-Z]+\d+([+\-*/][A-Z]+\d+)*$/.test(formula)) return true;
  return true;
}

function rangeSum(cells: CellAddress[]): string {
  if (cells.length === 0) return '0';
  if (cells.length === 1) return fmtAddr(cells[0]);
  // Check contiguous in same row of same sheet (column letters consecutive).
  const sameSheet = cells.every((c) => c.sheet === cells[0].sheet);
  const sameRow = cells.every((c) => c.row === cells[0].row);
  if (sameSheet && sameRow) {
    // Check columns are contiguous: every cell's col letter is consecutive.
    const colNums = cells.map((c) => letterToNum(c.col));
    const sorted = [...colNums].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) {
      const min = colLetter(sorted[0]);
      const max = colLetter(sorted[sorted.length - 1]);
      return `SUM(${quoteSheet(cells[0].sheet)}!${min}${cells[0].row}:${max}${cells[0].row})`;
    }
  }
  // Same column down a contiguous row range
  const sameCol = cells.every((c) => c.col === cells[0].col);
  if (sameSheet && sameCol) {
    const rowNums = cells.map((c) => c.row);
    const sorted = [...rowNums].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) {
      return `SUM(${quoteSheet(cells[0].sheet)}!${cells[0].col}${sorted[0]}:${cells[0].col}${sorted[sorted.length - 1]})`;
    }
  }
  // Fallback: explicit sum.
  return cells.map(fmtAddr).join('+');
}

function letterToNum(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// ─── Calendar helper ─────────────────────────────────────────────────────

function dateLabels(evalResult: EvalResult, calendarRef?: string): string[] {
  if (!calendarRef) return [];
  const t = evalResult.tables[calendarRef];
  if (!t) return [];
  const out: string[] = [];
  for (const r of t.rows) {
    const idx = Number(r.month_idx);
    out[idx] = String(r.date);
  }
  return out;
}

// ─── Block rendering ─────────────────────────────────────────────────────

interface RenderCtx {
  sheet: ExcelJS.Worksheet;
  sheetName: string;
  rowCursor: number;
  evalResult: EvalResult;
  report: ReportDef;
  model: ModelDef;
  book: CellAddressBook;
  identity: IdentityResolver;
  emitter: InlineEmitter;
  /** Derived-cell formula emissions are deferred to a second pass so any
   *  block can reference any other block's address regardless of section
   *  order. */
  deferred: Array<() => void>;
}

function setHeader(cell: ExcelJS.Cell, text: string, center = false): void {
  cell.value = text;
  cell.font = { bold: true };
  if (center) cell.alignment = { horizontal: 'center' };
}

function renderTitle(ctx: RenderCtx, b: TitleBlock): void {
  const level = b.level ?? 1;
  const size = level === 1 ? 13 : level === 2 ? 11 : 10;
  const cell = ctx.sheet.getCell(`A${ctx.rowCursor}`);
  cell.value = b.text;
  cell.font = { bold: true, size };
  ctx.rowCursor++;
}

function renderParagraph(ctx: RenderCtx, b: ParagraphBlock): void {
  const cell = ctx.sheet.getCell(`A${ctx.rowCursor}`);
  cell.value = b.text;
  if (b.italic) cell.font = { italic: true, color: { argb: 'FF6B7280' } };
  ctx.rowCursor++;
}

function renderSpacer(ctx: RenderCtx, b: SpacerBlock): void {
  ctx.rowCursor += b.rows ?? 1;
}

function axisValues(table: Table, axisCol: string): Array<string | number> {
  const seen = new Set<string | number>();
  for (const r of table.rows) {
    const v = r[axisCol];
    if (v === null || v === undefined) continue;
    seen.add(v as string | number);
  }
  const arr = Array.from(seen);
  if (arr.every((v) => typeof v === 'number')) {
    return (arr as number[]).sort((a, b) => a - b);
  }
  return (arr as string[]).sort();
}

function yearGroupsFor(
  evalResult: EvalResult,
  report: ReportDef,
  axisValues: Array<string | number>,
): Array<{ year: number; indexes: number[] }> {
  const dates = dateLabels(evalResult, report.calendarRef);
  const groups = new Map<number, number[]>();
  axisValues.forEach((v, i) => {
    const date = dates[Number(v)];
    if (!date) return;
    const y = parseInt(date.slice(0, 4), 10);
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y)!.push(i);
  });
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, indexes]) => ({ year, indexes }));
}

function isCanonicalSource(model: ModelDef, ref: string): boolean {
  const src = model.sources[ref];
  return !!src && (src.kind === 'manual' || src.kind === 'literal');
}

/** Render a TableBlock, producing one or more sub-tables (per group). */
function renderTable(ctx: RenderCtx, b: TableBlock): void {
  const sourceTable = ctx.evalResult.tables[b.source];
  if (!sourceTable) { console.warn(`[report] missing engine table ${b.source}`); return; }
  if (b.title) renderTitle(ctx, { kind: 'title', text: b.title, level: 2 });

  // Determine canonical refs the block holds — defaults to source if source
  // is a manual table.
  const canonicalRefs = new Set<string>(b.canonical?.refs ?? []);
  if (!b.canonical && isCanonicalSource(ctx.model, b.source)) canonicalRefs.add(b.source);

  // Static row filter (scalar = equality; array = membership)
  const filteredRows = b.filter
    ? sourceTable.rows.filter((r) =>
        Object.entries(b.filter!).every(([k, v]) =>
          Array.isArray(v) ? (v as Array<string | number>).includes(r[k] as string | number) : r[k] === v,
        ),
      )
    : sourceTable.rows;
  const source: Table = { schema: sourceTable.schema, rows: filteredRows };

  // Group rows. Scalar filter keys are pinned into every group's keyVals so
  // identity-aware lookups (`emit(ref, identity, col)`) carry them through;
  // array filters are membership-only and don't pin identity to one value.
  const filterKeys: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(b.filter ?? {})) {
    if (!Array.isArray(v)) filterKeys[k] = v;
  }
  const groups: Array<{ keyVals: Record<string, CellValue>; label: string | null; rows: Row[] }> = [];
  if (b.groupBy) {
    const byKey = new Map<string, { keyVals: Record<string, CellValue>; rows: Row[] }>();
    for (const r of source.rows) {
      const keyVals: Record<string, CellValue> = { ...filterKeys };
      for (const k of b.groupBy.keys) keyVals[k] = r[k];
      const k = fmtKey(b.groupBy.keys.map((k2) => keyVals[k2]));
      if (!byKey.has(k)) byKey.set(k, { keyVals, rows: [] });
      byKey.get(k)!.rows.push(r);
    }
    for (const { keyVals, rows } of byKey.values()) {
      groups.push({
        keyVals,
        label: b.groupBy.label(keyVals as Record<string, string | number>),
        rows,
      });
    }
  } else {
    groups.push({ keyVals: filterKeys, label: null, rows: source.rows });
  }

  // Axis values (per-table — single set across groups for uniform columns)
  const axisCols = b.axis ? axisValues(source, b.axis.col) : [];
  const axisLabelArr: string[] = [];
  if (b.axis?.labels === 'dates') {
    const dates = dateLabels(ctx.evalResult, ctx.report.calendarRef);
    axisCols.forEach((v, i) => { axisLabelArr[i] = dates[Number(v)] ?? String(v); });
  } else {
    axisCols.forEach((v, i) => { axisLabelArr[i] = String(v); });
  }

  for (const group of groups) {
    if (group.label) renderTitle(ctx, { kind: 'title', text: group.label, level: 3 });
    renderTableGroup(ctx, b, group, axisCols, axisLabelArr, canonicalRefs);
    ctx.rowCursor++; // blank row between groups
  }
}

function renderTableGroup(
  ctx: RenderCtx,
  block: TableBlock,
  group: { keyVals: Record<string, CellValue>; rows: Row[] },
  axisCols: Array<string | number>,
  axisLabels: string[],
  canonicalRefs: Set<string>,
): void {
  const { sheet, sheetName } = ctx;

  // ── Header row ──
  const headerRow = ctx.rowCursor;
  const labelHeader = block.rows.kind === 'value-columns'
    ? ''
    : (block.rows.labelHeader ?? '');
  setHeader(sheet.getCell(`A${headerRow}`), labelHeader);

  let nextCol = 2;
  axisCols.forEach((_, i) => {
    setHeader(sheet.getCell(`${colLetter(nextCol + i)}${headerRow}`), axisLabels[i], true);
  });
  nextCol += axisCols.length;

  const rollupYears = block.rollup?.yearTotals
    ? yearGroupsFor(ctx.evalResult, ctx.report, axisCols)
    : [];
  rollupYears.forEach((yg, i) => {
    setHeader(sheet.getCell(`${colLetter(nextCol + i)}${headerRow}`), String(yg.year), true);
  });
  nextCol += rollupYears.length;
  if (block.rollup?.grandTotal) {
    setHeader(sheet.getCell(`${colLetter(nextCol)}${headerRow}`), block.rollup.grandTotalLabel ?? 'Total', true);
    nextCol++;
  }
  ctx.rowCursor++;

  // ── Data rows ──
  const renderedRows: Array<{ excelRow: number; format: CellFormat }> = [];
  const defaultFormat: CellFormat = block.defaultFormat ?? 'money';
  const firstAxisCol = 2;
  const lastAxisCol = firstAxisCol + axisCols.length - 1;

  const writeAxisCell = (
    r: number, axisIdx: number, tableRef: string,
    rowIdentity: Record<string, CellValue>, col: string,
    fmt: CellFormat, bold: boolean,
  ): void => {
    const cell = sheet.getCell(`${colLetter(firstAxisCol + axisIdx)}${r}`);
    const addr: CellAddress = { sheet: sheetName, row: r, col: colLetter(firstAxisCol + axisIdx) };
    if (canonicalRefs.has(tableRef)) {
      cell.value = readRowValue(ctx.evalResult, tableRef, rowIdentity, col);
    } else {
      const capturedIdentity = { ...rowIdentity };
      ctx.deferred.push(() => {
        cell.value = { formula: ctx.emitter.emitForDerivedCell(addr, tableRef, capturedIdentity, col) };
      });
    }
    const idCols = ctx.identity.for(tableRef);
    ctx.book.record(tableRef, idCols.map((c) => rowIdentity[c]), col, addr);
    propagateAddressUpstream(ctx.model, ctx.evalResult, ctx.identity, ctx.book, tableRef, rowIdentity, col, addr);
    cell.numFmt = FMT[fmt];
    if (bold) cell.font = { ...(cell.font || {}), bold: true };
  };

  const writeRollup = (r: number, fmt: CellFormat, bold: boolean): number => {
    let rollCol = firstAxisCol + axisCols.length;
    for (const yg of rollupYears) {
      const startC = firstAxisCol + yg.indexes[0];
      const endC = firstAxisCol + yg.indexes[yg.indexes.length - 1];
      const cell = sheet.getCell(`${colLetter(rollCol)}${r}`);
      cell.value = { formula: `SUM(${colLetter(startC)}${r}:${colLetter(endC)}${r})` };
      cell.numFmt = FMT[fmt];
      if (bold) cell.font = { ...(cell.font || {}), bold: true };
      rollCol++;
    }
    if (block.rollup?.grandTotal && axisCols.length) {
      const cell = sheet.getCell(`${colLetter(rollCol)}${r}`);
      cell.value = { formula: `SUM(${colLetter(firstAxisCol)}${r}:${colLetter(lastAxisCol)}${r})` };
      cell.numFmt = FMT[fmt];
      if (bold) cell.font = { ...(cell.font || {}), bold: true };
      rollCol++;
    }
    return rollCol;
  };

  if (block.rows.kind === 'value-columns') {
    // Header for no-axis case (e.g., assumptions tables)
    if (axisCols.length === 0) {
      setHeader(sheet.getCell(`A${headerRow}`), 'Parameter');
      setHeader(sheet.getCell(`B${headerRow}`), 'Value', true);
    }
    for (const spec of block.rows.rows) {
      const r = ctx.rowCursor;
      const label = spec.label ?? spec.col;
      const fmt = spec.format ?? defaultFormat;
      const cellA = sheet.getCell(`A${r}`);
      cellA.value = label;
      if (spec.bold) cellA.font = { bold: true };

      if (axisCols.length === 0) {
        // No axis: one cell per row from the (sole) source row matching the
        // group/filter. Use the first matching row's identity for lookups.
        const baseRow = group.rows[0];
        if (baseRow) {
          const rowIdentity: Record<string, CellValue> = { ...group.keyVals };
          const idCols = ctx.identity.for(block.source);
          for (const c of idCols) rowIdentity[c] = baseRow[c];
          writeAxisCell(r, 0, block.source, rowIdentity, spec.col, fmt, !!spec.bold);
        }
      } else {
        axisCols.forEach((axisVal, i) => {
          const rowIdentity: Record<string, CellValue> = {
            ...group.keyVals,
            ...(block.axis ? { [block.axis.col]: axisVal } : {}),
          };
          writeAxisCell(r, i, block.source, rowIdentity, spec.col, fmt, !!spec.bold);
        });
      }
      writeRollup(r, fmt, !!spec.bold);

      renderedRows.push({ excelRow: r, format: fmt });
      ctx.rowCursor++;
    }
  } else if (block.rows.kind === 'pivot-rows') {
    const pr = block.rows;
    // Distinct label values across the group
    const labelVals = Array.from(new Set(group.rows.map((row) => row[pr.labelCol] as string | number)))
      .sort((a, b) => (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b)));
    const rowFmt = pr.format ?? defaultFormat;
    const rowBold = !!pr.bold;
    for (const labelVal of labelVals) {
      const r = ctx.rowCursor;
      const display = pr.labelMap?.[String(labelVal)] ?? String(labelVal);
      const cellA = sheet.getCell(`A${r}`);
      cellA.value = display;
      if (rowBold) cellA.font = { bold: true };

      axisCols.forEach((axisVal, i) => {
        const rowIdentity: Record<string, CellValue> = {
          ...group.keyVals,
          [pr.labelCol]: labelVal,
          ...(block.axis ? { [block.axis.col]: axisVal } : {}),
        };
        writeAxisCell(r, i, block.source, rowIdentity, pr.valueCol, rowFmt, rowBold);
      });
      writeRollup(r, rowFmt, rowBold);

      renderedRows.push({ excelRow: r, format: rowFmt });
      ctx.rowCursor++;
    }
    setHeader(sheet.getCell(`A${headerRow}`), pr.labelHeader ?? '');
  } else if (block.rows.kind === 'explicit') {
    // Explicit rows can mix sources — each spec names its source + identity.
    for (const spec of block.rows.rows) {
      const r = ctx.rowCursor;
      const sourceRef = spec.source ?? block.source;
      const fmt = spec.format ?? defaultFormat;
      const isBold = !!spec.bold;
      const cellA = sheet.getCell(`A${r}`);
      cellA.value = spec.label;
      if (isBold) cellA.font = { bold: true };

      axisCols.forEach((axisVal, i) => {
        const rowIdentity: Record<string, CellValue> = { ...spec.identity };
        if (block.axis) rowIdentity[block.axis.col] = axisVal;
        writeAxisCell(r, i, sourceRef, rowIdentity, spec.valueCol, fmt, isBold);
      });
      writeRollup(r, fmt, isBold);

      renderedRows.push({ excelRow: r, format: fmt });
      ctx.rowCursor++;
    }
    setHeader(sheet.getCell(`A${headerRow}`), block.rows.labelHeader ?? '');
  } else {
    // table-rows: one output row per source row, no axis pivot
    const rowsSpec = block.rows;
    const idCols = ctx.identity.for(block.source);
    const otherCols = ctx.evalResult.tables[block.source].schema.columns
      .filter((c) => !idCols.includes(c.name) && c.name !== rowsSpec.labelCol);

    // Write column headers in cols B..
    otherCols.forEach((schemaCol, i) => {
      setHeader(sheet.getCell(`${colLetter(2 + i)}${headerRow}`), schemaCol.name, true);
    });

    for (const sourceRow of group.rows) {
      const r = ctx.rowCursor;
      sheet.getCell(`A${r}`).value = sourceRow[rowsSpec.labelCol];

      const rowIdentity: Record<string, CellValue> = {};
      for (const c of idCols) rowIdentity[c] = sourceRow[c];

      otherCols.forEach((schemaCol, i) => {
        const cell = sheet.getCell(`${colLetter(2 + i)}${r}`);
        const addr: CellAddress = { sheet: sheetName, row: r, col: colLetter(2 + i) };
        if (canonicalRefs.has(block.source)) {
          cell.value = sourceRow[schemaCol.name] as CellValue;
        } else {
          const capturedIdentity = { ...rowIdentity };
          ctx.deferred.push(() => {
            cell.value = { formula: ctx.emitter.emitForDerivedCell(addr, block.source, capturedIdentity, schemaCol.name) };
          });
        }
        ctx.book.record(block.source, idCols.map((c) => rowIdentity[c]), schemaCol.name, addr);
        propagateAddressUpstream(ctx.model, ctx.evalResult, ctx.identity, ctx.book, block.source, rowIdentity, schemaCol.name, addr);
        if (schemaCol.type === 'number') cell.numFmt = FMT[defaultFormat];
      });

      renderedRows.push({ excelRow: r, format: defaultFormat });
      ctx.rowCursor++;
    }
  }

  // ── Totals row ──
  if (block.totalsRow && renderedRows.length) {
    const r = ctx.rowCursor;
    sheet.getCell(`A${r}`).value = block.totalsRow.label;
    const totalsBold = block.totalsRow.bold ?? true;
    if (totalsBold) sheet.getCell(`A${r}`).font = { bold: true };
    const fmt = renderedRows[0].format;
    const firstRow = renderedRows[0].excelRow;
    const lastRow = renderedRows[renderedRows.length - 1].excelRow;
    let totalCols = firstAxisCol + axisCols.length + rollupYears.length;
    if (block.rollup?.grandTotal) totalCols += 1;
    for (let c = firstAxisCol; c < totalCols; c++) {
      const cell = sheet.getCell(`${colLetter(c)}${r}`);
      cell.value = { formula: `SUM(${colLetter(c)}${firstRow}:${colLetter(c)}${lastRow})` };
      cell.numFmt = FMT[fmt];
      if (totalsBold) cell.font = { bold: true };
    }
    ctx.rowCursor++;
  }
}

/** Read a row's value from the materialized eval result, by identity. */
function readRowValue(
  evalResult: EvalResult,
  tableRef: string,
  identity: Record<string, CellValue>,
  col: string,
): CellValue {
  const t = evalResult.tables[tableRef];
  if (!t) return null;
  const idCols = (SOURCE_IDENTITY[tableRef] ?? []);
  const row = t.rows.find((r) => idCols.every((k) => r[k] === identity[k]));
  if (!row) return null;
  // Preserve null. Critical for actuals overlay tables: a null value means
  // "no override" and must render as an empty cell so the downstream
  // `IF((X=""), modeled, X)` formula picks the modeled branch. Coercing null
  // to 0 makes Excel see 0 ≠ "" and silently use the 0, zeroing out the line.
  const v = row[col];
  return v === undefined ? null : v;
}

function renderBlock(ctx: RenderCtx, block: ReportBlock): void {
  switch (block.kind) {
    case 'title':     renderTitle(ctx, block); break;
    case 'paragraph': renderParagraph(ctx, block); break;
    case 'spacer':    renderSpacer(ctx, block); break;
    case 'table':     renderTable(ctx, block); break;
  }
}

function renderSection(
  wb: ExcelJS.Workbook,
  section: ReportSection,
  model: ModelDef,
  evalResult: EvalResult,
  report: ReportDef,
  book: CellAddressBook,
  identity: IdentityResolver,
  emitter: InlineEmitter,
  deferred: Array<() => void>,
): void {
  const sheetName = escapeSheetName(section.label);
  const sheet = wb.addWorksheet(sheetName);
  const ctx: RenderCtx = {
    sheet, sheetName, rowCursor: 1, evalResult, report, model, book, identity, emitter, deferred,
  };
  if (section.hint) {
    const cell = sheet.getCell(`A${ctx.rowCursor}`);
    cell.value = section.hint;
    cell.font = { italic: true, color: { argb: 'FF6B7280' } };
    ctx.rowCursor++;
  }
  for (const block of section.blocks) renderBlock(ctx, block);

  sheet.getColumn(1).width = 32;
  for (let i = 2; i <= 80; i++) sheet.getColumn(i).width = 12;
}

// ─── Public API ──────────────────────────────────────────────────────────

export function renderReportToWorkbook(
  wb: ExcelJS.Workbook,
  model: ModelDef,
  evalResult: EvalResult,
  report: ReportDef,
): void {
  const book = new CellAddressBook();
  const identity = new IdentityResolver(model);
  const emitter = new InlineEmitter(model, evalResult, book, identity);
  const deferred: Array<() => void> = [];

  // Pass 0: materialise hidden helper sheets so their cells are addressed
  // before any formula emission walks the DAG. Lets long inline expansions
  // bottom out at a cell ref instead of repeating Excel sub-expressions.
  for (const ref of report.hiddenSheets ?? []) {
    renderHiddenHelperSheet(wb, ref, model, evalResult, book, identity);
  }

  // Pass 1: lay out every sheet, write canonical cells immediately, record
  // every address (canonical + derived), defer derived formula emission.
  for (const section of report.sections) {
    renderSection(wb, section, model, evalResult, report, book, identity, emitter, deferred);
  }

  // Pass 2: now that every block's address is in the book, emit derived
  // formulas. References can resolve regardless of section order.
  for (const fn of deferred) fn();
}

function renderHiddenHelperSheet(
  wb: ExcelJS.Workbook,
  ref: string,
  model: ModelDef,
  evalResult: EvalResult,
  book: CellAddressBook,
  identityRes: IdentityResolver,
): void {
  const table = evalResult.tables[ref];
  if (!table) return;
  const sheetName = escapeSheetName(`_helper_${ref}`);
  const sheet = wb.addWorksheet(sheetName);
  sheet.state = 'hidden';

  const cols = table.schema.columns;
  cols.forEach((c, i) => {
    const cell = sheet.getCell(`${colLetter(i + 1)}1`);
    cell.value = c.name;
    cell.font = { bold: true };
  });

  const idCols = identityRes.for(ref);
  table.rows.forEach((row, r) => {
    const excelRow = r + 2;
    const idRecord: Record<string, CellValue> = {};
    for (const k of idCols) idRecord[k] = row[k] as CellValue;
    cols.forEach((c, i) => {
      const colL = colLetter(i + 1);
      sheet.getCell(`${colL}${excelRow}`).value = row[c.name] as CellValue;
      const addr: CellAddress = { sheet: sheetName, row: excelRow, col: colL };
      book.record(ref, idCols.map((k) => row[k] as CellValue), c.name, addr);
      propagateAddressUpstream(model, evalResult, identityRes, book, ref, idRecord, c.name, addr);
    });
  });
}
