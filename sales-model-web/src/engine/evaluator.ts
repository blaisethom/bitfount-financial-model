// In-memory evaluator for the declarative model. Computes each step's output
// in declared order and returns the materialized tables plus a per-step trace.

import type {
  AggExpr, CellValue, Column, ColumnType, EvalResult, Expr, ModelDef,
  Row, Step, Table, TableOp, TableSchema,
} from './types';

export interface EvalOptions {
  /** Materialized tables for sources that need external fetching (api / json). */
  prefetchedSources?: Record<string, Table>;
}

export function evaluateModel(model: ModelDef, opts: EvalOptions = {}): EvalResult {
  const tables: Record<string, Table> = {};

  for (const [name, src] of Object.entries(model.sources)) {
    if (opts.prefetchedSources?.[name]) {
      tables[name] = opts.prefetchedSources[name];
      continue;
    }
    if (src.kind === 'literal') {
      tables[name] = { schema: src.schema, rows: src.rows.slice() };
    } else if (src.kind === 'manual') {
      tables[name] = { schema: src.schema, rows: src.defaults.slice() };
    } else {
      throw new Error(`Source "${name}" is kind "${src.kind}" — pass prefetched data via opts.prefetchedSources.`);
    }
  }

  const trace: Array<{ step: Step; output: Table }> = [];
  for (const step of model.steps) {
    const input = tables[step.input];
    if (!input) throw new Error(`Step "${step.id}": input table "${step.input}" not found.`);
    const output = applyOp(input, step.op, tables, step.id);
    tables[step.output] = output;
    trace.push({ step, output });
  }

  return { tables, trace };
}

function applyOp(input: Table, op: TableOp, all: Record<string, Table>, stepId: string): Table {
  switch (op.op) {
    case 'select': return selectOp(input, op.columns);
    case 'rename': return renameOp(input, op.renames);
    case 'filter': return filterOp(input, op.predicate);
    case 'map': return mapOp(input, op.columns);
    case 'groupBy': return groupByOp(input, op.keys, op.aggs);
    case 'join': {
      const right = all[op.right];
      if (!right) throw new Error(`Step "${stepId}" join: right table "${op.right}" not found.`);
      return joinOp(input, right, op.on, op.type);
    }
    case 'union': {
      const others = op.tables.map((t) => {
        const r = all[t];
        if (!r) throw new Error(`Step "${stepId}" union: table "${t}" not found.`);
        return r;
      });
      return unionOp([input, ...others]);
    }
    case 'sort': return sortOp(input, op.by);
    case 'limit': return { schema: input.schema, rows: input.rows.slice(0, op.n) };
  }
}

function selectOp(t: Table, cols: string[]): Table {
  const schemaCols = cols.map((c) => {
    const found = t.schema.columns.find((x) => x.name === c);
    if (!found) throw new Error(`select: column "${c}" not in input schema`);
    return found;
  });
  return {
    schema: { columns: schemaCols },
    rows: t.rows.map((r) => {
      const out: Row = {};
      for (const c of cols) out[c] = r[c] ?? null;
      return out;
    }),
  };
}

function renameOp(t: Table, renames: Record<string, string>): Table {
  return {
    schema: { columns: t.schema.columns.map((c) => (renames[c.name] ? { ...c, name: renames[c.name] } : c)) },
    rows: t.rows.map((r) => {
      const out: Row = {};
      for (const k of Object.keys(r)) out[renames[k] ?? k] = r[k];
      return out;
    }),
  };
}

function filterOp(t: Table, predicate: Expr): Table {
  return { schema: t.schema, rows: t.rows.filter((r) => Boolean(evalExpr(predicate, r))) };
}

function mapOp(t: Table, cols: Record<string, Expr>): Table {
  const existing = new Set(t.schema.columns.map((c) => c.name));
  const sampleRow = t.rows[0] ?? {};
  const newColDefs = Object.keys(cols)
    .filter((c) => !existing.has(c))
    .map((name) => {
      const v = evalExpr(cols[name], sampleRow);
      const type: ColumnType =
        typeof v === 'number' ? 'number'
        : typeof v === 'boolean' ? 'boolean'
        : 'string';
      return { name, type };
    });
  const schema: TableSchema = { columns: [...t.schema.columns, ...newColDefs] };
  const rows: Row[] = t.rows.map((r) => {
    const out: Row = { ...r };
    for (const [k, expr] of Object.entries(cols)) out[k] = evalExpr(expr, r);
    return out;
  });
  return { schema, rows };
}

function groupByOp(t: Table, keys: string[], aggs: Record<string, AggExpr>): Table {
  const buckets = new Map<string, Row[]>();
  for (const r of t.rows) {
    const key = keys.map((k) => String(r[k] ?? '')).join('\x1f');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  const rows: Row[] = [];
  for (const [keyStr, group] of buckets) {
    const keyValues = keyStr.split('\x1f');
    const row: Row = {};
    keys.forEach((k, i) => (row[k] = keyValues[i]));
    for (const [outName, agg] of Object.entries(aggs)) row[outName] = aggregate(group, agg);
    rows.push(row);
  }
  const keyCols: Column[] = keys.map((k) => {
    const col = t.schema.columns.find((c) => c.name === k);
    return col ?? { name: k, type: 'string' };
  });
  const aggCols: Column[] = Object.keys(aggs).map((name) => ({ name, type: 'number' }));
  return { schema: { columns: [...keyCols, ...aggCols] }, rows };
}

function aggregate(group: Row[], agg: AggExpr): CellValue {
  if (agg.fn === 'count' && agg.column === null) return group.length;
  const values: CellValue[] = group.map((r) => r[agg.column!]);
  const nums = values.filter((v): v is number => typeof v === 'number');
  switch (agg.fn) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'count': return values.filter((v) => v != null).length;
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : null;
    case 'max': return nums.length ? Math.max(...nums) : null;
    case 'first': return values[0] ?? null;
    case 'last': return values[values.length - 1] ?? null;
  }
}

function joinOp(left: Table, right: Table, on: Array<{ left: string; right: string }>, type: 'inner' | 'left'): Table {
  const rightIdx = new Map<string, Row[]>();
  for (const r of right.rows) {
    const key = on.map((j) => String(r[j.right] ?? '')).join('\x1f');
    if (!rightIdx.has(key)) rightIdx.set(key, []);
    rightIdx.get(key)!.push(r);
  }
  const rows: Row[] = [];
  for (const lr of left.rows) {
    const key = on.map((j) => String(lr[j.left] ?? '')).join('\x1f');
    const matches = rightIdx.get(key) ?? [];
    if (matches.length === 0) {
      if (type === 'left') {
        const out: Row = { ...lr };
        for (const col of right.schema.columns) {
          if (!on.find((j) => j.right === col.name)) out[col.name] = null;
        }
        rows.push(out);
      }
      continue;
    }
    for (const rr of matches) {
      const out: Row = { ...lr };
      for (const col of right.schema.columns) {
        if (!on.find((j) => j.right === col.name)) out[col.name] = rr[col.name];
      }
      rows.push(out);
    }
  }
  const rightCols = right.schema.columns.filter((c) => !on.find((j) => j.right === c.name));
  return { schema: { columns: [...left.schema.columns, ...rightCols] }, rows };
}

function unionOp(tables: Table[]): Table {
  if (tables.length === 0) throw new Error('union: no tables');
  const rows: Row[] = [];
  for (const t of tables) for (const r of t.rows) rows.push(r);
  return { schema: tables[0].schema, rows };
}

function sortOp(t: Table, by: Array<{ column: string; desc?: boolean }>): Table {
  return {
    schema: t.schema,
    rows: t.rows.slice().sort((a, b) => {
      for (const { column, desc } of by) {
        const av = a[column];
        const bv = b[column];
        if (av === bv) continue;
        if (av === null || av === undefined) return desc ? 1 : -1;
        if (bv === null || bv === undefined) return desc ? -1 : 1;
        if (av < bv) return desc ? 1 : -1;
        if (av > bv) return desc ? -1 : 1;
      }
      return 0;
    }),
  };
}

// ─── Expression evaluator ────────────────────────────────────────────────

export function evalExpr(expr: Expr, row: Row): CellValue {
  switch (expr.node) {
    case 'col': return row[expr.name] ?? null;
    case 'lit': return expr.value;
    case 'unary': {
      const v = evalExpr(expr.operand, row);
      if (expr.op === '-') return typeof v === 'number' ? -v : null;
      if (expr.op === 'not') return !v;
      return null;
    }
    case 'binary': {
      const l = evalExpr(expr.left, row);
      const r = evalExpr(expr.right, row);
      switch (expr.op) {
        case '+': return numOp(l, r, (a, b) => a + b);
        case '-': return numOp(l, r, (a, b) => a - b);
        case '*': return numOp(l, r, (a, b) => a * b);
        case '/': return numOp(l, r, (a, b) => (b === 0 ? null : a / b));
        case '%': return numOp(l, r, (a, b) => a % b);
        case '=': return l == r;
        case '!=': return l != r;
        case '<': return safeCompare(l, r) < 0;
        case '<=': return safeCompare(l, r) <= 0;
        case '>': return safeCompare(l, r) > 0;
        case '>=': return safeCompare(l, r) >= 0;
        case 'and': return Boolean(l) && Boolean(r);
        case 'or': return Boolean(l) || Boolean(r);
      }
      return null;
    }
    case 'fn': {
      const args = expr.args.map((a) => evalExpr(a, row));
      switch (expr.name) {
        case 'min': {
          const nums = args.filter((v): v is number => typeof v === 'number');
          return nums.length ? Math.min(...nums) : null;
        }
        case 'max': {
          const nums = args.filter((v): v is number => typeof v === 'number');
          return nums.length ? Math.max(...nums) : null;
        }
        case 'if': return args[0] ? args[1] : args[2] ?? null;
        case 'abs': return typeof args[0] === 'number' ? Math.abs(args[0]) : null;
        case 'round': {
          if (typeof args[0] !== 'number') return null;
          const digits = typeof args[1] === 'number' ? args[1] : 0;
          const f = Math.pow(10, digits);
          return Math.round(args[0] * f) / f;
        }
        case 'concat': return args.map((v) => (v == null ? '' : String(v))).join('');
        case 'coalesce': {
          for (const v of args) if (v != null) return v;
          return null;
        }
      }
      return null;
    }
  }
}

function numOp(l: CellValue, r: CellValue, fn: (a: number, b: number) => number | null): CellValue {
  if (typeof l !== 'number' || typeof r !== 'number') return null;
  return fn(l, r);
}

function safeCompare(l: CellValue, r: CellValue): number {
  if (l == null && r == null) return 0;
  if (l == null) return -1;
  if (r == null) return 1;
  if (l < r) return -1;
  if (l > r) return 1;
  return 0;
}

