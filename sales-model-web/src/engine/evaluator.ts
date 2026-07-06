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
    } else if (src.kind === 'sequence') {
      const rows: Row[] = Array.from({ length: src.count }, (_, i) => ({ [src.column]: i }));
      tables[name] = { schema: src.schema, rows };
    } else if (src.kind === 'api') {
      // API sources without prefetched data start empty — they need to be synced
      // via their registered adapter before evaluation can use real values.
      tables[name] = { schema: src.schema, rows: [] };
    } else {
      throw new Error(`Source "${name}" is kind "${(src as { kind: string }).kind}" — pass prefetched data via opts.prefetchedSources.`);
    }
  }

  const trace: Array<{ step: Step; output: Table }> = [];
  for (const step of model.steps) {
    const input = tables[step.input];
    if (!input) throw new Error(`Step "${step.id}": input table "${step.input}" not found.`);
    const output = applyOp(input, step.op, tables, step.id);
    tables[step.id] = output;
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
    case 'window': return windowOp(input, op);
  }
}

function windowOp(t: Table, op: Extract<TableOp, { op: 'window' }>): Table {
  const newColDefs: Column[] = Object.keys(op.derive).map((name) => ({ name, type: 'number' }));
  const schema: TableSchema = { columns: [...t.schema.columns, ...newColDefs] };

  // Group rows into partitions tracking their original index so we can write
  // results back in the same order as the input.
  const partitions = new Map<string, Array<{ row: Row; idx: number }>>();
  t.rows.forEach((r, idx) => {
    const key = op.partitionBy.map((k) => String(r[k] ?? '')).join('\x1f');
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key)!.push({ row: r, idx });
  });

  const out: Row[] = new Array(t.rows.length);
  for (const partition of partitions.values()) {
    partition.sort((a, b) => Number(a.row[op.orderBy] ?? 0) - Number(b.row[op.orderBy] ?? 0));
    for (const { row, idx } of partition) {
      const cur = Number(row[op.orderBy] ?? 0);
      const lo = cur - op.range.preceding;
      const hi = cur + op.range.following;
      const window = partition
        .filter(({ row: r }) => {
          const v = Number(r[op.orderBy] ?? 0);
          return v >= lo && v <= hi;
        })
        .map(({ row: r }) => r);
      const next: Row = { ...row };
      for (const [name, agg] of Object.entries(op.derive)) next[name] = aggregate(window, agg);
      out[idx] = next;
    }
  }
  return { schema, rows: out };
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
  for (const group of buckets.values()) {
    const sample = group[0];
    const row: Row = {};
    // Preserve original key value types by reading from a sample row, not from the stringified bucket key.
    for (const k of keys) row[k] = sample[k];
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

function joinOp(left: Table, right: Table, on: Array<{ left: string; right: string }>, type: 'inner' | 'left' | 'cross'): Table {
  const rightColsKept = right.schema.columns.filter((c) => !on.find((j) => j.right === c.name));
  const schema: TableSchema = { columns: [...left.schema.columns, ...rightColsKept] };

  if (type === 'cross' || on.length === 0) {
    const rows: Row[] = [];
    for (const lr of left.rows) {
      for (const rr of right.rows) {
        const out: Row = { ...lr };
        for (const col of rightColsKept) out[col.name] = rr[col.name];
        rows.push(out);
      }
    }
    return { schema, rows };
  }

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
        for (const col of rightColsKept) out[col.name] = null;
        rows.push(out);
      }
      continue;
    }
    for (const rr of matches) {
      const out: Row = { ...lr };
      for (const col of rightColsKept) out[col.name] = rr[col.name];
      rows.push(out);
    }
  }
  return { schema, rows };
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
        case 'pow': {
          if (typeof args[0] !== 'number' || typeof args[1] !== 'number') return null;
          return Math.pow(args[0], args[1]);
        }
        case 'year': return parseDatePart(args[0], 0, 4);
        case 'month': return parseDatePart(args[0], 5, 2);
        case 'day': return parseDatePart(args[0], 8, 2);
        case 'left': {
          const s = args[0] == null ? null : String(args[0]);
          const n = typeof args[1] === 'number' ? args[1] : 0;
          return s == null ? null : s.slice(0, Math.max(0, Math.floor(n)));
        }
        case 'right': {
          const s = args[0] == null ? null : String(args[0]);
          const n = typeof args[1] === 'number' ? args[1] : 0;
          if (s == null) return null;
          const m = Math.max(0, Math.floor(n));
          return m === 0 ? '' : s.slice(-m);
        }
        case 'mid': {
          const s = args[0] == null ? null : String(args[0]);
          const start = typeof args[1] === 'number' ? Math.max(1, Math.floor(args[1])) : 1;
          const len = typeof args[2] === 'number' ? Math.max(0, Math.floor(args[2])) : 0;
          return s == null ? null : s.slice(start - 1, start - 1 + len);
        }
        case 'len': return args[0] == null ? 0 : String(args[0]).length;
        case 'upper': return args[0] == null ? null : String(args[0]).toUpperCase();
        case 'lower': return args[0] == null ? null : String(args[0]).toLowerCase();
        case 'trim': return args[0] == null ? null : String(args[0]).trim();
        case 'int': return typeof args[0] === 'number' ? Math.floor(args[0]) : null;
        case 'floor': return typeof args[0] === 'number' ? Math.floor(args[0]) : null;
        case 'ceiling': return typeof args[0] === 'number' ? Math.ceil(args[0]) : null;
        case 'sqrt': return typeof args[0] === 'number' && args[0] >= 0 ? Math.sqrt(args[0]) : null;
        case 'mod': {
          if (typeof args[0] !== 'number' || typeof args[1] !== 'number') return null;
          if (args[1] === 0) return null;
          // Excel MOD matches the sign of the divisor — use a mathematical modulo, not JS %.
          return ((args[0] % args[1]) + args[1]) % args[1];
        }
        case 'isblank': return args[0] == null || args[0] === '';
        case 'value': {
          const v = args[0];
          if (typeof v === 'number') return v;
          if (typeof v === 'string') {
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : null;
          }
          return null;
        }
      }
      return null;
    }
  }
}

function parseDatePart(v: CellValue, offset: number, len: number): CellValue {
  if (typeof v !== 'string') return null;
  const slice = v.slice(offset, offset + len);
  if (slice.length !== len) return null;
  const n = parseInt(slice, 10);
  return Number.isFinite(n) ? n : null;
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

