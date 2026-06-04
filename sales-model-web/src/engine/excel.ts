// Excel-formula emission for engine expressions and ops.
//
// Phase 1: emitExprFormula — converts an `Expr` (per-row cell expression) into
// an Excel formula string, given a map from logical column name → Excel column
// letter and a row index. This is the building block the wider Excel renderer
// will compose on top of when emitting `map`, `filter`, `derive` etc.
//
// Future work: emitOpToSheet — given a step, write its output as an ExcelJS
// worksheet with formulas (where the op type supports it) referencing the input
// sheet's cells. For ops without a clean formula equivalent (pivot, complex
// groupBy), the renderer will fall back to writing values + a note.

import type { Expr, BinaryOp, FunctionName } from './types';

/** Map from logical column name → Excel column letter (e.g. { type: 'A', sites: 'B' }). */
export type ColumnLetterMap = Record<string, string>;

/** Convert a 1-indexed column number to its Excel letter (1 → 'A', 27 → 'AA'). */
export function columnLetter(col: number): string {
  let s = '';
  while (col > 0) {
    col--;
    s = String.fromCharCode(65 + (col % 26)) + s;
    col = Math.floor(col / 26);
  }
  return s;
}

/** Build a ColumnLetterMap by zipping ordered column names against letters A, B, … */
export function columnLetterMap(names: string[]): ColumnLetterMap {
  const out: ColumnLetterMap = {};
  names.forEach((n, i) => { out[n] = columnLetter(i + 1); });
  return out;
}

/** Quote a sheet name for use in a cross-sheet reference. */
export function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

const BINARY_INFIX: Partial<Record<BinaryOp, string>> = {
  '+': '+', '-': '-', '*': '*', '/': '/',
  '=': '=', '!=': '<>', '<': '<', '<=': '<=', '>': '>', '>=': '>=',
};

// Straightforward 1:1 mappings. Functions needing special handling (coalesce
// nesting, YEAR/MONTH/DAY string-slicing) are intercepted in emitExprFormula.
const FN_NAME: Partial<Record<FunctionName, string>> = {
  min: 'MIN', max: 'MAX', if: 'IF', abs: 'ABS', round: 'ROUND',
  concat: 'CONCATENATE', pow: 'POWER',
  left: 'LEFT', right: 'RIGHT', mid: 'MID', len: 'LEN',
  upper: 'UPPER', lower: 'LOWER', trim: 'TRIM',
  int: 'INT', sqrt: 'SQRT', mod: 'MOD',
  isblank: 'ISBLANK', value: 'VALUE',
  // FLOOR/CEILING — use the *.MATH variants so a single argument works.
  floor: 'FLOOR.MATH', ceiling: 'CEILING.MATH',
};

/**
 * Convert an `Expr` into an Excel formula string.
 *
 * @param expr        the expression to emit
 * @param rowIdx      1-indexed Excel row number where this formula will live
 * @param columnMap   logical column name → Excel column letter (may include
 *                    sheet prefix like `'Inputs'!A` for cross-sheet refs)
 *
 * Notes:
 * - Returned string does NOT include the leading `=`; callers prepend it when
 *   setting a cell's formula value.
 * - `coalesce(a, b)` maps to `IFERROR(a, b)` for two-arg use; longer chains
 *   become nested IFERRORs.
 */
export function emitExprFormula(expr: Expr, rowIdx: number, columnMap: ColumnLetterMap): string {
  switch (expr.node) {
    case 'col': {
      const letter = columnMap[expr.name];
      if (!letter) throw new Error(`emitExprFormula: column "${expr.name}" not in column map`);
      return `${letter}${rowIdx}`;
    }
    case 'lit': {
      const v = expr.value;
      if (v === null) return '""';
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()';
      return `"${v.replace(/"/g, '""')}"`;
    }
    case 'unary': {
      const v = emitExprFormula(expr.operand, rowIdx, columnMap);
      if (expr.op === '-') return `(-${v})`;
      return `NOT(${v})`;
    }
    case 'binary': {
      const l = emitExprFormula(expr.left, rowIdx, columnMap);
      const r = emitExprFormula(expr.right, rowIdx, columnMap);
      const infix = BINARY_INFIX[expr.op];
      if (infix) return `(${l}${infix}${r})`;
      if (expr.op === '%') return `MOD(${l},${r})`;
      if (expr.op === 'and') return `AND(${l},${r})`;
      if (expr.op === 'or') return `OR(${l},${r})`;
      throw new Error(`emitExprFormula: unsupported binary op "${expr.op}"`);
    }
    case 'fn': {
      const args = expr.args.map((a) => emitExprFormula(a, rowIdx, columnMap));
      if (expr.name === 'coalesce') {
        // IFERROR is the closest Excel equivalent: IFERROR(a, b) returns a unless a errors, else b.
        // For chains, nest from the right: IFERROR(a, IFERROR(b, c)).
        return args.reduceRight((acc, cur, i) =>
          i === args.length - 1 ? cur : `IFERROR(${cur},${acc})`,
        '');
      }
      // YEAR/MONTH/DAY: our convention is a YYYY-MM[-DD] string, not an Excel
      // serial date. Emit explicit substring extraction so it works regardless
      // of cell formatting / locale.
      if (expr.name === 'year') return `VALUE(LEFT(${args[0]},4))`;
      if (expr.name === 'month') return `VALUE(MID(${args[0]},6,2))`;
      if (expr.name === 'day') return `VALUE(MID(${args[0]},9,2))`;
      const xl = FN_NAME[expr.name];
      if (!xl) throw new Error(`emitExprFormula: no Excel mapping for fn "${expr.name}"`);
      return `${xl}(${args.join(',')})`;
    }
  }
}
