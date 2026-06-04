// Generic Step → ExcelJS sheet emitter. Walks the model DAG and produces one
// worksheet per table, preferring Excel formulas when the op maps cleanly:
//
//   - source tables (literal/api/manual)  → values
//   - map                                  → formulas (existing cols = refs to
//                                            input sheet; derived cols emitted
//                                            via emitExprFormula)
//   - select / rename                      → cross-sheet references
//   - groupBy                              → SUMIFS / COUNTIFS / AVERAGEIFS /
//                                            MINIFS / MAXIFS pointing at the
//                                            input sheet
//   - window                               → SUMIFS with comparison criteria
//                                            for the order column (sum only;
//                                            other aggregations fall back)
//   - join (inner/left, single-key)        → INDEX/MATCH lookups
//   - filter / sort / limit / union / multi-key join → values
//
// Each emission records its sheet name + column letter map + data row range,
// so downstream steps can reference its cells.

import ExcelJS from 'exceljs';
import type {
  AggExpr, EvalResult, ModelDef, Step, Table, TableOp,
} from './types';
import { columnLetter, emitExprFormula, quoteSheet } from './excel';
import type { ColumnLetterMap } from './excel';

export interface SheetEmission {
  name: string;
  columnMap: ColumnLetterMap;
  firstDataRow: number;
  lastDataRow: number;
}

export interface RenderContext {
  sheets: Record<string, SheetEmission>;
}

const MONEY = '"$"#,##0';
const COUNT = '0';

function escapeSheetName(s: string): string {
  // Excel limits sheet names to 31 chars and disallows : \ / ? * [ ]
  return s.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
}

function writeHeader(sheet: ExcelJS.Worksheet, table: Table): ColumnLetterMap {
  const map: ColumnLetterMap = {};
  table.schema.columns.forEach((c, i) => {
    const letter = columnLetter(i + 1);
    map[c.name] = letter;
    const cell = sheet.getCell(`${letter}1`);
    cell.value = c.name;
    cell.font = { bold: true };
  });
  return map;
}

function setNumFmtForColumn(sheet: ExcelJS.Worksheet, col: string, fmt: string, fromRow: number, toRow: number) {
  for (let r = fromRow; r <= toRow; r++) sheet.getCell(`${col}${r}`).numFmt = fmt;
}

function applyNumberFormats(sheet: ExcelJS.Worksheet, table: Table, columnMap: ColumnLetterMap, firstRow: number, lastRow: number) {
  for (const c of table.schema.columns) {
    if (c.type !== 'number') continue;
    const letter = columnMap[c.name];
    // Money for likely-currency columns; plain count otherwise.
    const isMoney = /amount|revenue|cost|salary|fee|price|expected|total|opex|ebitda|commission|gross|hubspot|platform|project|pm|model_rev|staff|non_staff|derived|depreciation|value|cap/i.test(c.name);
    setNumFmtForColumn(sheet, letter, isMoney ? MONEY : COUNT, firstRow, lastRow);
  }
}

/** Render a fully-materialized table as values on a fresh worksheet. */
export function renderTableAsValueSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  table: Table,
): SheetEmission {
  const sheet = wb.addWorksheet(escapeSheetName(sheetName));
  const columnMap = writeHeader(sheet, table);
  table.rows.forEach((row, ri) => {
    const r = ri + 2;
    for (const c of table.schema.columns) {
      sheet.getCell(`${columnMap[c.name]}${r}`).value = row[c.name];
    }
  });
  applyNumberFormats(sheet, table, columnMap, 2, table.rows.length + 1);
  // Auto-width: rough estimate based on column header + sample data length
  table.schema.columns.forEach((c) => {
    const headerLen = c.name.length;
    const sampleLen = String(table.rows[0]?.[c.name] ?? '').length;
    sheet.getColumn(columnMap[c.name]).width = Math.max(10, Math.min(40, Math.max(headerLen, sampleLen) + 2));
  });
  return {
    name: sheet.name,
    columnMap,
    firstDataRow: 2,
    lastDataRow: table.rows.length + 1,
  };
}

/** Translate an Expr's column refs to point at the input sheet, for use in map / window. */
function inputCellExpr(name: string, rowIdx: number, input: SheetEmission): string {
  return `${quoteSheet(input.name)}!${input.columnMap[name]}${rowIdx}`;
}

/** Build a column map that resolves col refs to sheet-qualified addresses
 *  (e.g. `'Inputs'!A`). emitExprFormula appends the row index at call time. */
function inputColumnMap(input: SheetEmission): ColumnLetterMap {
  const out: ColumnLetterMap = {};
  for (const [name, letter] of Object.entries(input.columnMap)) {
    out[name] = `${quoteSheet(input.name)}!${letter}`;
  }
  return out;
}

/** Render a single step's output as a worksheet, preferring formulas when possible. */
export function renderStepAsSheet(
  wb: ExcelJS.Workbook,
  step: Step,
  output: Table,
  context: RenderContext,
): SheetEmission {
  const input = context.sheets[step.input];
  // Fallback for any unsupported case: write values.
  if (!input) return renderTableAsValueSheet(wb, step.output, output);

  switch (step.op.op) {
    case 'map':       return renderMap(wb, step, output, input);
    case 'select':    return renderSelectOrRename(wb, step.output, output, input);
    case 'rename':    return renderSelectOrRename(wb, step.output, output, input);
    case 'groupBy':   return renderGroupBy(wb, step, output, input);
    case 'window':    return renderWindow(wb, step, output, input);
    case 'join':      return renderJoin(wb, step, output, input, context);
    case 'sort':
    case 'limit':
    case 'union':
    case 'filter':
    default:          return renderTableAsValueSheet(wb, step.output, output);
  }
}

// ─── map ─────────────────────────────────────────────────────────────────

function renderMap(
  wb: ExcelJS.Workbook,
  step: Step,
  output: Table,
  input: SheetEmission,
): SheetEmission {
  const sheet = wb.addWorksheet(escapeSheetName(step.output));
  const columnMap = writeHeader(sheet, output);
  const mapOp = step.op as Extract<TableOp, { op: 'map' }>;
  const inMap = inputColumnMap(input);

  output.rows.forEach((row, ri) => {
    const r = ri + 2;
    const inputRow = input.firstDataRow + ri;
    for (const c of output.schema.columns) {
      const cell = sheet.getCell(`${columnMap[c.name]}${r}`);
      if (mapOp.columns[c.name]) {
        // Derived column: emit formula referencing the input sheet at inputRow.
        const formula = emitExprFormula(mapOp.columns[c.name], inputRow, inMap);
        cell.value = { formula };
      } else if (input.columnMap[c.name]) {
        // Existing column: reference the input sheet cell directly.
        cell.value = { formula: inputCellExpr(c.name, inputRow, input) };
      } else {
        cell.value = row[c.name];
      }
    }
  });
  applyNumberFormats(sheet, output, columnMap, 2, output.rows.length + 1);
  return { name: sheet.name, columnMap, firstDataRow: 2, lastDataRow: output.rows.length + 1 };
}

// ─── select / rename ─────────────────────────────────────────────────────

function renderSelectOrRename(
  wb: ExcelJS.Workbook,
  sheetName: string,
  output: Table,
  input: SheetEmission,
): SheetEmission {
  const sheet = wb.addWorksheet(escapeSheetName(sheetName));
  const columnMap = writeHeader(sheet, output);
  output.rows.forEach((row, ri) => {
    const r = ri + 2;
    const inputRow = input.firstDataRow + ri;
    for (const c of output.schema.columns) {
      const cell = sheet.getCell(`${columnMap[c.name]}${r}`);
      if (input.columnMap[c.name]) {
        cell.value = { formula: inputCellExpr(c.name, inputRow, input) };
      } else {
        cell.value = row[c.name];
      }
    }
  });
  applyNumberFormats(sheet, output, columnMap, 2, output.rows.length + 1);
  return { name: sheet.name, columnMap, firstDataRow: 2, lastDataRow: output.rows.length + 1 };
}

// ─── groupBy ─────────────────────────────────────────────────────────────

function renderGroupBy(
  wb: ExcelJS.Workbook,
  step: Step,
  output: Table,
  input: SheetEmission,
): SheetEmission {
  const sheet = wb.addWorksheet(escapeSheetName(step.output));
  const columnMap = writeHeader(sheet, output);
  const gb = step.op as Extract<TableOp, { op: 'groupBy' }>;

  // Validate all key + agg cols exist on input where needed
  for (const k of gb.keys) {
    if (!input.columnMap[k]) {
      // key col not on input — fall back to values
      return renderTableAsValueSheet(wb, step.output, output);
    }
  }

  output.rows.forEach((row, ri) => {
    const r = ri + 2;
    for (const c of output.schema.columns) {
      const cell = sheet.getCell(`${columnMap[c.name]}${r}`);
      if (gb.keys.includes(c.name)) {
        // Key cell: literal value
        cell.value = row[c.name];
        continue;
      }
      // Aggregation cell: SUMIFS / COUNTIFS / AVERAGEIFS / MINIFS / MAXIFS
      const aggExpr = gb.aggs[c.name];
      if (!aggExpr) { cell.value = row[c.name]; continue; }
      const formula = buildAggIfsFormula(aggExpr, gb.keys, columnMap, r, input);
      cell.value = formula ? { formula } : row[c.name];
    }
  });
  applyNumberFormats(sheet, output, columnMap, 2, output.rows.length + 1);
  return { name: sheet.name, columnMap, firstDataRow: 2, lastDataRow: output.rows.length + 1 };
}

function buildAggIfsFormula(
  agg: AggExpr,
  keys: string[],
  outputColumnMap: ColumnLetterMap,
  outputRow: number,
  input: SheetEmission,
): string | null {
  if (agg.fn === 'count' && agg.column === null) {
    // COUNTIFS(criteria_range1, criteria1, ...)
    const parts: string[] = [];
    for (const k of keys) {
      const ir = inputRange(input, k);
      const ref = `${outputColumnMap[k]}${outputRow}`;
      parts.push(ir, ref);
    }
    return `COUNTIFS(${parts.join(',')})`;
  }
  if (!agg.column || !input.columnMap[agg.column]) return null;
  const fnName: Record<string, string> = {
    sum: 'SUMIFS', count: 'COUNTIFS', avg: 'AVERAGEIFS', min: 'MINIFS', max: 'MAXIFS',
  };
  const xlFn = fnName[agg.fn];
  if (!xlFn) return null;
  const valueRange = inputRange(input, agg.column);
  const parts: string[] = [];
  if (agg.fn === 'count') {
    // COUNTIFS(criteria_range, criteria, ...) — no value range needed
    for (const k of keys) {
      parts.push(inputRange(input, k), `${outputColumnMap[k]}${outputRow}`);
    }
    return `COUNTIFS(${parts.join(',')})`;
  }
  parts.push(valueRange);
  for (const k of keys) {
    parts.push(inputRange(input, k), `${outputColumnMap[k]}${outputRow}`);
  }
  return `${xlFn}(${parts.join(',')})`;
}

function inputRange(input: SheetEmission, col: string): string {
  const letter = input.columnMap[col];
  return `${quoteSheet(input.name)}!${letter}${input.firstDataRow}:${letter}${input.lastDataRow}`;
}

// ─── window ──────────────────────────────────────────────────────────────

function renderWindow(
  wb: ExcelJS.Workbook,
  step: Step,
  output: Table,
  input: SheetEmission,
): SheetEmission {
  const sheet = wb.addWorksheet(escapeSheetName(step.output));
  const columnMap = writeHeader(sheet, output);
  const winOp = step.op as Extract<TableOp, { op: 'window' }>;

  // For each row, pre-existing columns reference the input sheet; derived
  // columns use SUMIFS (when agg is sum) constrained by partition keys + order
  // column range. Other aggs fall back to value.
  output.rows.forEach((row, ri) => {
    const r = ri + 2;
    const inputRow = input.firstDataRow + ri;
    for (const c of output.schema.columns) {
      const cell = sheet.getCell(`${columnMap[c.name]}${r}`);
      const derived = winOp.derive[c.name];
      if (derived) {
        const formula = buildWindowFormula(derived, winOp, columnMap, r, input);
        cell.value = formula ? { formula } : row[c.name];
      } else if (input.columnMap[c.name]) {
        cell.value = { formula: inputCellExpr(c.name, inputRow, input) };
      } else {
        cell.value = row[c.name];
      }
    }
  });
  applyNumberFormats(sheet, output, columnMap, 2, output.rows.length + 1);
  return { name: sheet.name, columnMap, firstDataRow: 2, lastDataRow: output.rows.length + 1 };
}

function buildWindowFormula(
  agg: AggExpr,
  winOp: Extract<TableOp, { op: 'window' }>,
  outputColumnMap: ColumnLetterMap,
  outputRow: number,
  input: SheetEmission,
): string | null {
  if (agg.fn === 'sum' && agg.column && input.columnMap[agg.column]) {
    const valueRange = inputRange(input, agg.column);
    const orderRange = inputRange(input, winOp.orderBy);
    const orderRef = `${outputColumnMap[winOp.orderBy]}${outputRow}`;
    const parts: string[] = [valueRange];
    for (const k of winOp.partitionBy) {
      if (!input.columnMap[k]) return null;
      parts.push(inputRange(input, k), `${outputColumnMap[k]}${outputRow}`);
    }
    parts.push(orderRange, `">="&(${orderRef}-${winOp.range.preceding})`);
    parts.push(orderRange, `"<="&(${orderRef}+${winOp.range.following})`);
    return `SUMIFS(${parts.join(',')})`;
  }
  return null;
}

// ─── join (inner / left, single-key only) ────────────────────────────────

function renderJoin(
  wb: ExcelJS.Workbook,
  step: Step,
  output: Table,
  input: SheetEmission,
  context: RenderContext,
): SheetEmission {
  const joinOp = step.op as Extract<TableOp, { op: 'join' }>;
  const right = context.sheets[joinOp.right];
  // Multi-key joins or cross joins → values
  if (!right || joinOp.on.length !== 1 || joinOp.type === 'cross') {
    return renderTableAsValueSheet(wb, step.output, output);
  }
  const sheet = wb.addWorksheet(escapeSheetName(step.output));
  const columnMap = writeHeader(sheet, output);
  const j = joinOp.on[0];
  const rightKeyRange = inputRange(right, j.right);

  // Caveat: join output ordering depends on the evaluator. We assume each
  // output row maps 1:1 to a left-side row (which is true when join keys are
  // unique on the right and we're not doing fan-out). For one-to-many joins,
  // this lookup falls back to "first match" which matches the evaluator's
  // value for those rows often enough.
  output.rows.forEach((row, ri) => {
    const r = ri + 2;
    const inputRow = input.firstDataRow + ri;
    const keyRef = input.columnMap[j.left]
      ? inputCellExpr(j.left, inputRow, input)
      : null;
    for (const c of output.schema.columns) {
      const cell = sheet.getCell(`${columnMap[c.name]}${r}`);
      if (input.columnMap[c.name]) {
        cell.value = { formula: inputCellExpr(c.name, inputRow, input) };
      } else if (right.columnMap[c.name] && keyRef) {
        const valRange = inputRange(right, c.name);
        cell.value = { formula: `IFERROR(INDEX(${valRange},MATCH(${keyRef},${rightKeyRange},0)),"")` };
      } else {
        cell.value = row[c.name];
      }
    }
  });
  applyNumberFormats(sheet, output, columnMap, 2, output.rows.length + 1);
  return { name: sheet.name, columnMap, firstDataRow: 2, lastDataRow: output.rows.length + 1 };
}

// ─── Top-level: render a whole model ─────────────────────────────────────

/**
 * Render a fully-evaluated model into an ExcelJS workbook. Source tables are
 * written as values; step outputs use formulas where the op is supported. Each
 * sheet's column letters + data row range are tracked so downstream steps can
 * reference cells cross-sheet.
 */
export function renderModelToWorkbook(
  wb: ExcelJS.Workbook,
  model: ModelDef,
  evalResult: EvalResult,
): RenderContext {
  const context: RenderContext = { sheets: {} };

  // Sources → value sheets
  for (const name of Object.keys(model.sources)) {
    const table = evalResult.tables[name];
    if (!table) continue;
    context.sheets[name] = renderTableAsValueSheet(wb, name, table);
  }

  // Steps in declared order
  for (const { step, output } of evalResult.trace) {
    const emission = renderStepAsSheet(wb, step, output, context);
    context.sheets[step.output] = emission;
  }

  return context;
}
