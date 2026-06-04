// Engine public entry point. Re-exports types, evaluator, builders, and the
// source-adapter registry so most callers can do `import { defineModel, ops,
// col, lit, evaluateModel } from './engine'`.

export type {
  AggExpr, AggFn, BinaryOp, CellValue, Column, ColumnType, EvalResult,
  Expr, FunctionName, ModelDef, ModelGroup, ModelOutputDef, Row, SourceDef, Step,
  Table, TableOp, TableRef, TableSchema,
} from './types';

export { evaluateModel, evalExpr } from './evaluator';
export type { EvalOptions } from './evaluator';

export {
  defineModel, literal, apiSource, manual, sequence, step, ops,
  col, lit, bin, add, sub, mul, div, eq, ne, lt, le, gt, ge, and, or,
  neg, not, fn, min, max, iff, abs, round, concat, coalesce, pow, agg,
  // Excel-style functions
  year, month, day,
  left, right, mid, len, upper, lower, trim,
  int, floor, ceiling, sqrt, mod,
  isBlank, value,
} from './builders';

export {
  emitExprFormula, columnLetter, columnLetterMap, quoteSheet,
} from './excel';
export type { ColumnLetterMap } from './excel';

export {
  renderModelToWorkbook, renderStepAsSheet, renderTableAsValueSheet,
} from './excelRenderer';
export type { SheetEmission, RenderContext } from './excelRenderer';

export {
  registerSourceAdapter, getSourceAdapter, materializeApiSources,
} from './sources';
export type { SourceAdapter } from './sources';
