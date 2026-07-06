// Ergonomic builders for the engine: source(), step(), ops, expressions, aggs.
// Keeps model definitions readable without writing raw AST nodes by hand.

import type {
  AggExpr, BinaryOp, CellValue, ColumnType, Expr, FunctionName, ModelDef, Row,
  SourceDef, Step, TableOp, TableRef, TableSchema,
} from './types';

// ─── Top-level builder ───────────────────────────────────────────────────

export function defineModel(model: ModelDef): ModelDef {
  return model;
}

// ─── Source builders ─────────────────────────────────────────────────────

export function literal(opts: {
  schema: TableSchema;
  rows: Row[];
  description?: string;
}): SourceDef {
  return { kind: 'literal', schema: opts.schema, rows: opts.rows, description: opts.description };
}

export function apiSource(opts: {
  adapter: string;
  config?: unknown;
  schema: TableSchema;
  description?: string;
}): SourceDef {
  return {
    kind: 'api',
    adapter: opts.adapter,
    config: opts.config ?? null,
    schema: opts.schema,
    description: opts.description,
  };
}

export function manual(opts: {
  schema: TableSchema;
  defaults: Row[];
  description?: string;
}): SourceDef {
  return { kind: 'manual', schema: opts.schema, defaults: opts.defaults, description: opts.description };
}

export function sequence(opts: {
  column: string;
  count: number;
  description?: string;
  type?: ColumnType;
}): SourceDef {
  const type: ColumnType = opts.type ?? 'number';
  return {
    kind: 'sequence',
    column: opts.column,
    count: opts.count,
    description: opts.description,
    schema: { columns: [{ name: opts.column, type }] },
  };
}

// ─── Step builder ────────────────────────────────────────────────────────

export function step(s: Step): Step {
  return s;
}

// ─── Op builders ─────────────────────────────────────────────────────────

export const ops = {
  select: (columns: string[]): TableOp => ({ op: 'select', columns }),
  rename: (renames: Record<string, string>): TableOp => ({ op: 'rename', renames }),
  filter: (predicate: Expr): TableOp => ({ op: 'filter', predicate }),
  map: (columns: Record<string, Expr>): TableOp => ({ op: 'map', columns }),
  groupBy: (keys: string[], aggs: Record<string, AggExpr>): TableOp => ({ op: 'groupBy', keys, aggs }),
  join: (
    right: TableRef,
    on: Array<{ left: string; right: string }>,
    type: 'inner' | 'left' | 'cross' = 'inner',
  ): TableOp => ({ op: 'join', right, on, type }),
  cross: (right: TableRef): TableOp => ({ op: 'join', right, on: [], type: 'cross' }),
  union: (tables: TableRef[]): TableOp => ({ op: 'union', tables }),
  sort: (by: Array<{ column: string; desc?: boolean }>): TableOp => ({ op: 'sort', by }),
  limit: (n: number): TableOp => ({ op: 'limit', n }),
  window: (opts: {
    partitionBy: string[];
    orderBy: string;
    range: { preceding: number; following: number };
    derive: Record<string, AggExpr>;
  }): TableOp => ({ op: 'window', ...opts }),
};

// ─── Expression builders ─────────────────────────────────────────────────

export const col = (name: string): Expr => ({ node: 'col', name });
export const lit = (value: CellValue): Expr => ({ node: 'lit', value });

export const bin = (op: BinaryOp, left: Expr, right: Expr): Expr =>
  ({ node: 'binary', op, left, right });

export const add = (a: Expr, b: Expr) => bin('+', a, b);
export const sub = (a: Expr, b: Expr) => bin('-', a, b);
export const mul = (a: Expr, b: Expr) => bin('*', a, b);
export const div = (a: Expr, b: Expr) => bin('/', a, b);
export const eq = (a: Expr, b: Expr) => bin('=', a, b);
export const ne = (a: Expr, b: Expr) => bin('!=', a, b);
export const lt = (a: Expr, b: Expr) => bin('<', a, b);
export const le = (a: Expr, b: Expr) => bin('<=', a, b);
export const gt = (a: Expr, b: Expr) => bin('>', a, b);
export const ge = (a: Expr, b: Expr) => bin('>=', a, b);
export const and = (a: Expr, b: Expr) => bin('and', a, b);
export const or = (a: Expr, b: Expr) => bin('or', a, b);

export const neg = (a: Expr): Expr => ({ node: 'unary', op: '-', operand: a });
export const not = (a: Expr): Expr => ({ node: 'unary', op: 'not', operand: a });

export const fn = (name: FunctionName, args: Expr[]): Expr => ({ node: 'fn', name, args });
export const min = (...args: Expr[]) => fn('min', args);
export const max = (...args: Expr[]) => fn('max', args);
export const iff = (cond: Expr, t: Expr, e: Expr) => fn('if', [cond, t, e]);
export const abs = (a: Expr) => fn('abs', [a]);
export const round = (a: Expr, digits: Expr = lit(0)) => fn('round', [a, digits]);
export const concat = (...args: Expr[]) => fn('concat', args);
export const coalesce = (...args: Expr[]) => fn('coalesce', args);
export const pow = (base: Expr, exponent: Expr) => fn('pow', [base, exponent]);

// Date functions — assume YYYY-MM[-DD] string input.
export const year = (date: Expr) => fn('year', [date]);
export const month = (date: Expr) => fn('month', [date]);
export const day = (date: Expr) => fn('day', [date]);

// String functions.
export const left = (s: Expr, n: Expr) => fn('left', [s, n]);
export const right = (s: Expr, n: Expr) => fn('right', [s, n]);
export const mid = (s: Expr, start: Expr, len: Expr) => fn('mid', [s, start, len]);
export const len = (s: Expr) => fn('len', [s]);
export const upper = (s: Expr) => fn('upper', [s]);
export const lower = (s: Expr) => fn('lower', [s]);
export const trim = (s: Expr) => fn('trim', [s]);

// Math.
export const int = (n: Expr) => fn('int', [n]);
export const floor = (n: Expr) => fn('floor', [n]);
export const ceiling = (n: Expr) => fn('ceiling', [n]);
export const sqrt = (n: Expr) => fn('sqrt', [n]);
export const mod = (a: Expr, b: Expr) => fn('mod', [a, b]);

// Logical / coercion.
export const isBlank = (a: Expr) => fn('isblank', [a]);
export const value = (s: Expr) => fn('value', [s]);

// ─── Aggregation builders ────────────────────────────────────────────────

export const agg = {
  sum: (column: string): AggExpr => ({ fn: 'sum', column }),
  count: (column: string | null = null): AggExpr => ({ fn: 'count', column }),
  avg: (column: string): AggExpr => ({ fn: 'avg', column }),
  min: (column: string): AggExpr => ({ fn: 'min', column }),
  max: (column: string): AggExpr => ({ fn: 'max', column }),
  first: (column: string): AggExpr => ({ fn: 'first', column }),
  last: (column: string): AggExpr => ({ fn: 'last', column }),
};
