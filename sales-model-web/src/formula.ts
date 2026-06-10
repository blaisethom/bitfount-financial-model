// A tiny expression DSL <-> engine `Expr` bridge, used by the Engine Preview's
// formula editor. `parseExpr` turns a spreadsheet-like string
// (`ebitda - depreciation + interest_income`, `max(x, 0)`, `if(a > b, a, b)`)
// into the engine's `Expr` tree; `exprToSource` does the reverse so an existing
// formula can be shown as editable text. A model patch layer (`applyFormula
// Overrides`) swaps edited column formulas into a ModelDef before evaluation.

import type { Expr, BinaryOp, FunctionName, ModelDef, Step, AggExpr, AggFn } from './engine';

const FUNCTIONS = new Set<string>([
  'min', 'max', 'if', 'abs', 'round', 'concat', 'coalesce', 'pow',
  'year', 'month', 'day',
  'left', 'right', 'mid', 'len', 'upper', 'lower', 'trim',
  'int', 'floor', 'ceiling', 'sqrt', 'mod',
  'isblank', 'value',
]);

// ─── Tokenizer ─────────────────────────────────────────────────────────────

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punc'; v: '(' | ')' | ',' };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdPart = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { toks.push({ t: 'punc', v: c }); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c; let j = i + 1; let s = '';
      while (j < n && src[j] !== quote) { s += src[j]; j++; }
      if (j >= n) throw new Error(`Unterminated string starting at position ${i}`);
      toks.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; while (j < n && /[0-9.]/.test(src[j])) j++;
      const numStr = src.slice(i, j);
      const num = Number(numStr);
      if (Number.isNaN(num)) throw new Error(`Invalid number "${numStr}"`);
      toks.push({ t: 'num', v: num }); i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i; while (j < n && isIdPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) }); i = j; continue;
    }
    // Multi-char operators first.
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      toks.push({ t: 'op', v: two }); i += 2; continue;
    }
    if ('+-*/%=<>'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Unexpected character "${c}" at position ${i}`);
  }
  return toks;
}

// ─── Parser (recursive descent, precedence climbing) ─────────────────────────

const NORMALIZE_BIN: Record<string, BinaryOp> = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%',
  '=': '=', '==': '=', '!=': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=',
  and: 'and', or: 'or',
};

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const isOp = (v: string) => { const t = peek(); return t && t.t === 'op' && t.v === v; };
  const isKw = (v: string) => { const t = peek(); return t && t.t === 'id' && t.v.toLowerCase() === v; };

  function parseOr(): Expr {
    let left = parseAnd();
    while (isKw('or')) { next(); left = { node: 'binary', op: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseCmp();
    while (isKw('and')) { next(); left = { node: 'binary', op: 'and', left, right: parseCmp() }; }
    return left;
  }
  function parseCmp(): Expr {
    let left = parseAdd();
    while (['=', '==', '!=', '<', '<=', '>', '>='].some(isOp)) {
      const op = (next() as { v: string }).v;
      left = { node: 'binary', op: NORMALIZE_BIN[op], left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd(): Expr {
    let left = parseMul();
    while (isOp('+') || isOp('-')) {
      const op = (next() as { v: string }).v;
      left = { node: 'binary', op: NORMALIZE_BIN[op], left, right: parseMul() };
    }
    return left;
  }
  function parseMul(): Expr {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (next() as { v: string }).v;
      left = { node: 'binary', op: NORMALIZE_BIN[op], left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Expr {
    if (isOp('-')) { next(); return { node: 'unary', op: '-', operand: parseUnary() }; }
    if (isKw('not')) { next(); return { node: 'unary', op: 'not', operand: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary(): Expr {
    const t = peek();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.t === 'punc' && t.v === '(') {
      next(); const e = parseOr();
      const close = next();
      if (!close || close.t !== 'punc' || close.v !== ')') throw new Error('Expected ")"');
      return e;
    }
    if (t.t === 'num') { next(); return { node: 'lit', value: t.v }; }
    if (t.t === 'str') { next(); return { node: 'lit', value: t.v }; }
    if (t.t === 'id') {
      const name = t.v; const lower = name.toLowerCase();
      next();
      if (lower === 'true') return { node: 'lit', value: true };
      if (lower === 'false') return { node: 'lit', value: false };
      if (lower === 'null') return { node: 'lit', value: null };
      // Function call?
      if (peek() && peek().t === 'punc' && (peek() as { v: string }).v === '(') {
        if (!FUNCTIONS.has(lower)) throw new Error(`Unknown function "${name}"`);
        next(); // consume '('
        const args: Expr[] = [];
        if (!(peek() && peek().t === 'punc' && (peek() as { v: string }).v === ')')) {
          args.push(parseOr());
          while (peek() && peek().t === 'punc' && (peek() as { v: string }).v === ',') { next(); args.push(parseOr()); }
        }
        const close = next();
        if (!close || close.t !== 'punc' || close.v !== ')') throw new Error(`Expected ")" to close ${name}(...)`);
        return { node: 'fn', name: lower as FunctionName, args };
      }
      return { node: 'col', name };
    }
    throw new Error(`Unexpected token ${JSON.stringify(t)}`);
  }

  const expr = parseOr();
  if (pos < toks.length) {
    throw new Error(`Unexpected trailing token ${JSON.stringify(toks[pos])}`);
  }
  return expr;
}

// ─── Unparser (Expr -> source text) ──────────────────────────────────────────

const BIN_PREC: Record<BinaryOp, number> = {
  or: 1, and: 2,
  '=': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5, '%': 5,
};

export function exprToSource(expr: Expr, parentPrec = 0): string {
  switch (expr.node) {
    case 'col': return expr.name;
    case 'lit':
      if (expr.value === null) return 'null';
      if (typeof expr.value === 'string') return JSON.stringify(expr.value);
      return String(expr.value);
    case 'unary': {
      const inner = exprToSource(expr.operand, 6);
      return expr.op === '-' ? `-${inner}` : `not ${inner}`;
    }
    case 'fn':
      return `${expr.name}(${expr.args.map((a) => exprToSource(a, 0)).join(', ')})`;
    case 'binary': {
      const prec = BIN_PREC[expr.op];
      const left = exprToSource(expr.left, prec);
      const right = exprToSource(expr.right, prec + 1); // right side needs higher bind to keep left-assoc
      const opTxt = expr.op === 'and' || expr.op === 'or' ? ` ${expr.op} ` : ` ${expr.op} `;
      const s = `${left}${opTxt}${right}`;
      return prec < parentPrec ? `(${s})` : s;
    }
  }
}

// ─── Aggregations (groupBy / window) ────────────────────────────────────────

const AGG_FNS = new Set<string>(['sum', 'count', 'avg', 'min', 'max', 'first', 'last']);

/** Parse an aggregation like `sum(value)`, `max(month_idx)`, or `count()`. */
export function parseAgg(src: string): AggExpr {
  const m = src.trim().match(/^([A-Za-z_]\w*)\s*\(\s*(\*|[A-Za-z_]\w*)?\s*\)$/);
  if (!m) throw new Error('Expected an aggregation like sum(column) or count()');
  const fn = m[1].toLowerCase();
  if (!AGG_FNS.has(fn)) throw new Error(`Unknown aggregation "${m[1]}". Use one of: ${[...AGG_FNS].join(', ')}`);
  const col = m[2];
  const column = !col || col === '*' ? null : col;
  if (fn !== 'count' && column === null) throw new Error(`${fn}(...) needs a column, e.g. ${fn}(value)`);
  return { fn: fn as AggFn, column };
}

export function aggToSource(a: AggExpr): string {
  return `${a.fn}(${a.column ?? ''})`;
}

/** Column names referenced by an aggregation (none for count(*)). */
export function aggColNames(a: AggExpr): string[] {
  return a.column ? [a.column] : [];
}

// ─── Structural-parameter parsers (the "Operation" line) ─────────────────────

export const FILTER_SLOT = '$predicate';
export const STRUCT = {
  input: '$input', keys: '$keys', partitionBy: '$partitionBy', orderBy: '$orderBy',
  range: '$range', right: '$right', type: '$type', on: '$on', columns: '$columns',
  renames: '$renames', by: '$by', n: '$n', members: '$members',
} as const;

const ident = (s: string): string => {
  const t = s.trim();
  if (!/^[A-Za-z_]\w*$/.test(t)) throw new Error(`"${s.trim()}" is not a valid name`);
  return t;
};
const colList = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean).map(ident);
const tableRef = (s: string): string => {
  const t = s.trim();
  if (!t) throw new Error('expected a table name');
  return t;
};
const parseRange = (s: string): { preceding: number; following: number } => {
  const nums = s.replace(/[[\]]/g, '').split(',').map((x) => Number(x.trim()));
  if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error('range must be "preceding, following", e.g. "11, 0"');
  }
  return { preceding: Math.abs(nums[0]), following: Math.abs(nums[1]) };
};
const parseJoinType = (s: string): 'inner' | 'left' | 'cross' => {
  const t = s.trim().toLowerCase();
  if (t !== 'inner' && t !== 'left' && t !== 'cross') throw new Error('join type must be inner, left, or cross');
  return t;
};
const parseJoinOn = (s: string): Array<{ left: string; right: string }> =>
  s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const [l, r] = p.split('=').map((x) => x.trim());
    if (!l || !r) throw new Error(`each "on" clause must be left=right, got "${p}"`);
    return { left: ident(l), right: ident(r) };
  });
const parseRenames = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [f, t] = p.split(/=|→/).map((x) => x.trim());
    if (!f || !t) throw new Error(`each rename must be from=to, got "${p}"`);
    out[ident(f)] = ident(t);
  }
  return out;
};
const parseSortBy = (s: string): Array<{ column: string; desc?: boolean }> =>
  s.split(',').map((x) => x.trim()).filter(Boolean).map((p) => {
    const parts = p.split(/\s+/);
    const column = ident(parts[0]);
    const desc = (parts[1] ?? '').toLowerCase() === 'desc';
    return desc ? { column, desc } : { column };
  });
const parseCount = (s: string): number => {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n < 0) throw new Error('expected a non-negative number');
  return Math.floor(n);
};

// ─── Model patching ──────────────────────────────────────────────────────────

/** Per-step override sources, keyed by a "slot":
 *  - expression slots: a map output column, an agg output column, or `$predicate`
 *  - structural slots: `$input`, `$keys`, `$partitionBy`, `$orderBy`, `$range`,
 *    `$right`, `$type`, `$on`, `$columns`, `$renames`, `$by`, `$n`, `$members` */
export type FormulaOverrides = Record<string, Record<string, string>>;

/** Apply one slot override onto a working (deep-cloned) step. Throws on a parse
 *  error so the caller can decide to skip (lenient) or reject (strict). */
function applySlot(step: Step, slot: string, src: string): void {
  if (slot === STRUCT.input) { step.input = tableRef(src); return; }
  const op = step.op;
  switch (op.op) {
    case 'map':
      if (slot.startsWith('$')) throw new Error(`map has no "${slot}"`);
      op.columns[slot] = parseExpr(src); return;
    case 'filter':
      if (slot !== FILTER_SLOT) throw new Error(`filter has no "${slot}"`);
      op.predicate = parseExpr(src); return;
    case 'groupBy':
      if (slot === STRUCT.keys) { const k = colList(src); if (!k.length) throw new Error('need at least one key'); op.keys = k; return; }
      op.aggs[slot] = parseAgg(src); return;
    case 'window':
      if (slot === STRUCT.partitionBy) { op.partitionBy = src.trim() ? colList(src) : []; return; }
      if (slot === STRUCT.orderBy) { op.orderBy = ident(src); return; }
      if (slot === STRUCT.range) { op.range = parseRange(src); return; }
      op.derive[slot] = parseAgg(src); return;
    case 'join':
      if (slot === STRUCT.right) { op.right = tableRef(src); return; }
      if (slot === STRUCT.type) { op.type = parseJoinType(src); return; }
      if (slot === STRUCT.on) { op.on = parseJoinOn(src); return; }
      throw new Error(`join has no "${slot}"`);
    case 'select':
      if (slot === STRUCT.columns) { op.columns = colList(src); return; }
      throw new Error(`select has no "${slot}"`);
    case 'rename':
      if (slot === STRUCT.renames) { op.renames = parseRenames(src); return; }
      throw new Error(`rename has no "${slot}"`);
    case 'sort':
      if (slot === STRUCT.by) { op.by = parseSortBy(src); return; }
      throw new Error(`sort has no "${slot}"`);
    case 'limit':
      if (slot === STRUCT.n) { op.n = parseCount(src); return; }
      throw new Error(`limit has no "${slot}"`);
    case 'union':
      if (slot === STRUCT.members) { op.tables = colList(src); return; }
      throw new Error(`union has no "${slot}"`);
  }
}

/** Patch a model's steps from the override sources. Lenient by default — a slot
 *  that won't parse is skipped, leaving the original in place. With
 *  `{ strict: true }`, throws on the first bad slot (used to validate an edit
 *  before committing it). */
export function applyFormulaOverrides(
  model: ModelDef,
  overrides: FormulaOverrides,
  opts: { strict?: boolean } = {},
): ModelDef {
  if (!overrides || Object.keys(overrides).length === 0) return model;
  const steps: Step[] = model.steps.map((step) => {
    const stepOv = overrides[step.output];
    if (!stepOv || Object.keys(stepOv).length === 0) return step;
    const next: Step = { ...step, op: structuredClone(step.op) };
    for (const [slot, src] of Object.entries(stepOv)) {
      try {
        applySlot(next, slot, src);
      } catch (e) {
        if (opts.strict) throw new Error(`${step.output} · ${slot.replace(/^\$/, '')}: ${e instanceof Error ? e.message : String(e)}`);
        // lenient: leave the original definition in place
      }
    }
    return next;
  });
  return { ...model, steps };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'bitfount-model.formulaOverrides.v1';

export function loadFormulaOverrides(): FormulaOverrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FormulaOverrides) : {};
  } catch {
    return {};
  }
}

export function saveFormulaOverrides(o: FormulaOverrides): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}
