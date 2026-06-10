// A tiny expression DSL <-> engine `Expr` bridge, used by the Engine Preview's
// formula editor. `parseExpr` turns a spreadsheet-like string
// (`ebitda - depreciation + interest_income`, `max(x, 0)`, `if(a > b, a, b)`)
// into the engine's `Expr` tree; `exprToSource` does the reverse so an existing
// formula can be shown as editable text. A model patch layer (`applyFormula
// Overrides`) swaps edited column formulas into a ModelDef before evaluation.

import type { Expr, BinaryOp, FunctionName, ModelDef, Step } from './engine';

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

// ─── Model patching ──────────────────────────────────────────────────────────

/** Per-step, per-column formula source overrides. */
export type FormulaOverrides = Record<string, Record<string, string>>;

/** Column refs available to a map step = its input table's columns. Used by the
 *  editor to validate / hint which identifiers are in scope. */
export function applyFormulaOverrides(model: ModelDef, overrides: FormulaOverrides): ModelDef {
  if (!overrides || Object.keys(overrides).length === 0) return model;
  const steps: Step[] = model.steps.map((step) => {
    const stepOv = overrides[step.output];
    if (!stepOv || step.op.op !== 'map') return step;
    const columns = { ...step.op.columns };
    for (const [col, src] of Object.entries(stepOv)) {
      try {
        columns[col] = parseExpr(src);
      } catch {
        // Leave the original formula in place if the override won't parse.
      }
    }
    return { ...step, op: { ...step.op, columns } };
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
