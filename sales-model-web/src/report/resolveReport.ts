/**
 * Resolves a raw YAML-parsed report config object into a typed `ReportDef`.
 *
 * The YAML uses snake_case field names; this module converts the known schema
 * field names to camelCase for the TypeScript output. Engine column names
 * (filter keys, identity keys, label_map keys) are NOT converted.
 */

import type {
  ReportDef,
  ReportSection,
  ReportBlock,
  TableBlock,
  TitleBlock,
  ParagraphBlock,
  SpacerBlock,
  ColumnSpec,
  AxisSpec,
  RowsSpec,
  TotalsRow,
  YearRollup,
  CellFormat,
  CanonicalDecl,
} from './types';

// ─── Raw YAML types ──────────────────────────────────────────────────────────

type RawVal = string | number | boolean | null | RawObj | RawVal[];
type RawObj = { [key: string]: RawVal };

// ─── Context ──────────────────────────────────────────────────────────────────

type Vars = Record<string, RawVal>;
type Ctx = Record<string, string | number>;

// ─── String interpolation ─────────────────────────────────────────────────────

/** Replace `{varname}` placeholders in a string with values from ctx. */
function interpolate(s: string, ctx: Ctx): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    return v !== undefined ? String(v) : `{${k}}`;
  });
}

// ─── Variable resolution ──────────────────────────────────────────────────────

/**
 * Resolve a single value node:
 *   - `$varname`        → entire var
 *   - `$varname.{key}`  → resolve `{key}` in ctx, then index var[resolvedKey]
 *   - `$varname.litkey` → var[litkey]
 *   - `{...}` string    → interpolate
 *   - anything else     → as-is
 */
function resolveVal(val: RawVal, vars: Vars, ctx: Ctx): RawVal {
  if (typeof val === 'string') {
    // Full $var reference
    const mFull = /^\$(\w+)$/.exec(val);
    if (mFull) {
      const varVal = vars[mFull[1]];
      return varVal !== undefined ? varVal : val;
    }
    // $var.{key} or $var.literal_key
    const mDot = /^\$(\w+)\.(.+)$/.exec(val);
    if (mDot) {
      const varName = mDot[1];
      const keyExpr = mDot[2];
      const varVal = vars[varName];
      if (varVal !== null && typeof varVal === 'object' && !Array.isArray(varVal)) {
        // Resolve key — may contain {ctx} interpolation
        const resolvedKey = interpolate(keyExpr.replace(/^\{(.+)\}$/, '$1'), ctx);
        const nested = (varVal as RawObj)[resolvedKey];
        return nested !== undefined ? nested : val;
      }
      return val;
    }
    // String interpolation
    if (val.includes('{')) {
      return interpolate(val, ctx);
    }
    return val;
  }
  return val;
}

/** Resolve a value and ensure it is a string. */
function resolveStr(val: RawVal | undefined, vars: Vars, ctx: Ctx, fallback?: string): string | undefined {
  if (val === undefined || val === null) return fallback;
  const r = resolveVal(val, vars, ctx);
  return r !== null && r !== undefined ? String(r) : fallback;
}

/** Resolve a value and ensure it is an array. */
function resolveList(val: RawVal | undefined, vars: Vars, ctx: Ctx): RawVal[] {
  if (val === undefined || val === null) return [];
  const r = resolveVal(val, vars, ctx);
  if (Array.isArray(r)) return r;
  return [];
}

/** Cast to RawObj or return undefined. */
function asObj(val: RawVal | undefined): RawObj | undefined {
  if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
    return val as RawObj;
  }
  return undefined;
}

// ─── Block resolution ─────────────────────────────────────────────────────────

function resolveColumnSpec(raw: RawVal, vars: Vars, ctx: Ctx): ColumnSpec {
  const obj = asObj(raw) ?? {};
  return {
    col: resolveStr(obj.col, vars, ctx) ?? '',
    ...(obj.label !== undefined ? { label: resolveStr(obj.label, vars, ctx) } : {}),
    ...(obj.format !== undefined ? { format: resolveStr(obj.format, vars, ctx) as CellFormat } : {}),
    ...(obj.bold !== undefined ? { bold: Boolean(obj.bold) } : {}),
  };
}

function resolveAxis(raw: RawVal | undefined, vars: Vars, ctx: Ctx): AxisSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = resolveVal(raw, vars, ctx);
  const obj = asObj(r);
  if (!obj) return undefined;
  return {
    col: resolveStr(obj.col, vars, ctx) ?? '',
    ...(obj.labels !== undefined ? { labels: resolveStr(obj.labels, vars, ctx) as AxisSpec['labels'] } : {}),
  };
}

function resolveRowsSpec(raw: RawVal | undefined, vars: Vars, ctx: Ctx): RowsSpec {
  const obj = asObj(raw) ?? {};
  const kind = resolveStr(obj.kind, vars, ctx) ?? '';

  if (kind === 'table-rows') {
    const cfRaw = asObj(obj.column_formats);
    const columnFormats = cfRaw
      ? Object.fromEntries(Object.entries(cfRaw).map(([k, v]) => [k, String(v) as CellFormat]))
      : undefined;
    return {
      kind: 'table-rows',
      labelCol: resolveStr(obj.label_col, vars, ctx) ?? '',
      ...(obj.label_header !== undefined ? { labelHeader: resolveStr(obj.label_header, vars, ctx) } : {}),
      ...(columnFormats ? { columnFormats } : {}),
    };
  }

  if (kind === 'value-columns') {
    // YAML uses `columns:` to avoid collision with parent `rows:` field
    const colsRaw = Array.isArray(obj.columns) ? obj.columns : [];
    return {
      kind: 'value-columns',
      rows: colsRaw.map((c) => resolveColumnSpec(c, vars, ctx)),
    };
  }

  if (kind === 'pivot-rows') {
    const labelMap = resolveVal(obj.label_map, vars, ctx);
    const labelMapObj = asObj(labelMap);
    return {
      kind: 'pivot-rows',
      labelCol: resolveStr(obj.label_col, vars, ctx) ?? '',
      ...(obj.label_header !== undefined ? { labelHeader: resolveStr(obj.label_header, vars, ctx) } : {}),
      valueCol: resolveStr(obj.value_col, vars, ctx) ?? '',
      ...(labelMapObj ? { labelMap: Object.fromEntries(Object.entries(labelMapObj).map(([k, v]) => [k, String(v)])) } : {}),
      ...(obj.format !== undefined ? { format: resolveStr(obj.format, vars, ctx) as CellFormat } : {}),
      ...(obj.bold !== undefined ? { bold: Boolean(obj.bold) } : {}),
    };
  }

  if (kind === 'explicit') {
    const rowsRaw = Array.isArray(obj.rows) ? obj.rows : [];
    const rows = expandExplicitRows(rowsRaw, vars, ctx);
    return {
      kind: 'explicit',
      ...(obj.label_header !== undefined ? { labelHeader: resolveStr(obj.label_header, vars, ctx) } : {}),
      rows,
    };
  }

  // Fallback: explicit with no rows
  return { kind: 'explicit', rows: [] };
}

type ExplicitRow = {
  source?: string;
  identity: Record<string, string | number>;
  valueCol: string;
  label: string;
  bold?: boolean;
  format?: CellFormat;
};

function expandExplicitRows(rowsRaw: RawVal[], vars: Vars, ctx: Ctx): ExplicitRow[] {
  const result: ExplicitRow[] = [];
  for (const raw of rowsRaw) {
    const obj = asObj(raw);
    if (!obj) continue;

    if (obj.for_each !== undefined) {
      // Expand a for_each row into N rows
      const list = resolveList(obj.for_each, vars, ctx);
      const bindKey = resolveStr(obj.as, vars, ctx) ?? 'item';
      for (const item of list) {
        const innerCtx = { ...ctx, [bindKey]: item as string | number };
        const row = buildExplicitRow(obj, vars, innerCtx);
        if (row) result.push(row);
      }
    } else {
      const row = buildExplicitRow(obj, vars, ctx);
      if (row) result.push(row);
    }
  }
  return result;
}

function buildExplicitRow(obj: RawObj, vars: Vars, ctx: Ctx): ExplicitRow | null {
  const label = resolveStr(obj.label, vars, ctx);
  const valueCol = resolveStr(obj.value_col, vars, ctx);
  if (label === undefined || !valueCol) return null;

  const identityRaw = asObj(resolveVal(obj.identity, vars, ctx) ?? obj.identity);
  const identity: Record<string, string | number> = {};
  if (identityRaw) {
    for (const [k, v] of Object.entries(identityRaw)) {
      // Keys are engine column names — do NOT camelCase
      const resolved = resolveVal(v, vars, ctx);
      if (typeof resolved === 'string' || typeof resolved === 'number') {
        identity[k] = resolved;
      }
    }
  }

  const row: ExplicitRow = { identity, valueCol, label };
  if (obj.source !== undefined) {
    const src = resolveStr(obj.source, vars, ctx);
    if (src) row.source = src;
  }
  if (obj.bold !== undefined) row.bold = Boolean(obj.bold);
  if (obj.format !== undefined) {
    const fmt = resolveStr(obj.format, vars, ctx) as CellFormat;
    if (fmt) row.format = fmt;
  }
  return row;
}

function resolveTotalsRow(raw: RawVal | undefined, vars: Vars, ctx: Ctx): TotalsRow | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = resolveVal(raw, vars, ctx);
  const obj = asObj(r);
  if (!obj) return undefined;
  return {
    label: resolveStr(obj.label, vars, ctx) ?? '',
    ...(obj.bold !== undefined ? { bold: Boolean(obj.bold) } : {}),
    ...(obj.mode !== undefined ? { mode: resolveStr(obj.mode, vars, ctx) as TotalsRow['mode'] } : {}),
  };
}

function resolveRollup(raw: RawVal | undefined, vars: Vars, ctx: Ctx): YearRollup | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = resolveVal(raw, vars, ctx);
  const obj = asObj(r);
  if (!obj) return undefined;
  return {
    ...(obj.year_totals !== undefined ? { yearTotals: Boolean(obj.year_totals) } : {}),
    ...(obj.grand_total !== undefined ? { grandTotal: Boolean(obj.grand_total) } : {}),
    ...(obj.grand_total_label !== undefined ? { grandTotalLabel: resolveStr(obj.grand_total_label, vars, ctx) } : {}),
  };
}

function resolveCanonical(raw: RawVal | undefined, vars: Vars, ctx: Ctx): CanonicalDecl | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = resolveVal(raw, vars, ctx);
  // YAML canonical is a list: [schedule_t]
  if (Array.isArray(r)) {
    return { refs: r.map((x) => String(x)) };
  }
  // Could also be an object with refs key
  const obj = asObj(r);
  if (obj && Array.isArray(obj.refs)) {
    return { refs: (obj.refs as RawVal[]).map((x) => String(x)) };
  }
  return undefined;
}

function resolveFilter(
  raw: RawVal | undefined,
  vars: Vars,
  ctx: Ctx,
): Record<string, string | number | Array<string | number>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = resolveVal(raw, vars, ctx);
  const obj = asObj(r);
  if (!obj) return undefined;
  const out: Record<string, string | number | Array<string | number>> = {};
  for (const [k, v] of Object.entries(obj)) {
    // Filter keys are engine column names — do NOT camelCase
    const resolved = resolveVal(v, vars, ctx);
    if (Array.isArray(resolved)) {
      out[k] = resolved.map((x) => {
        const rx = resolveVal(x, vars, ctx);
        return typeof rx === 'string' || typeof rx === 'number' ? rx : String(rx);
      });
    } else if (typeof resolved === 'string' || typeof resolved === 'number') {
      out[k] = resolved;
    }
  }
  return out;
}

// ─── Template resolution ──────────────────────────────────────────────────────

type Template = { params: string[]; blocks: RawVal[] };

function resolveTemplates(raw: RawObj | undefined): Record<string, Template> {
  if (!raw) return {};
  const out: Record<string, Template> = {};
  for (const [name, def] of Object.entries(raw)) {
    const obj = asObj(def);
    if (!obj) continue;
    const params = Array.isArray(obj.params) ? obj.params.map(String) : [];
    const blocks = Array.isArray(obj.blocks) ? obj.blocks : [];
    out[name] = { params, blocks };
  }
  return out;
}

// ─── Block expansion ──────────────────────────────────────────────────────────

function resolveBlocks(
  rawBlocks: RawVal[],
  vars: Vars,
  ctx: Ctx,
  templates: Record<string, Template>,
): ReportBlock[] {
  const result: ReportBlock[] = [];
  for (const raw of rawBlocks) {
    const obj = asObj(raw);
    if (!obj) continue;
    const kind = resolveStr(obj.kind, vars, ctx);

    if (kind === 'repeat') {
      const tmplName = resolveStr(obj.template, vars, ctx) ?? '';
      const tmpl = templates[tmplName];
      if (!tmpl) continue;
      const overList = resolveList(obj.over, vars, ctx);
      const bindKey = resolveStr(obj.bind, vars, ctx) ?? 'item';
      for (const item of overList) {
        const innerCtx = { ...ctx, [bindKey]: item as string | number };
        const expanded = resolveBlocks(tmpl.blocks, vars, innerCtx, templates);
        result.push(...expanded);
      }
      continue;
    }

    const block = resolveBlock(obj, vars, ctx, templates);
    if (block) result.push(block);
  }
  return result;
}

function resolveBlock(
  obj: RawObj,
  vars: Vars,
  ctx: Ctx,
  templates: Record<string, Template>,
): ReportBlock | null {
  const kind = resolveStr(obj.kind, vars, ctx);

  if (kind === 'title') {
    const block: TitleBlock = {
      kind: 'title',
      text: resolveStr(obj.text, vars, ctx) ?? '',
    };
    if (obj.level !== undefined) {
      const lvl = Number(obj.level);
      if (lvl === 1 || lvl === 2 || lvl === 3) block.level = lvl;
    }
    return block;
  }

  if (kind === 'paragraph') {
    const block: ParagraphBlock = {
      kind: 'paragraph',
      text: resolveStr(obj.text, vars, ctx) ?? '',
    };
    if (obj.italic !== undefined) block.italic = Boolean(obj.italic);
    return block;
  }

  if (kind === 'spacer') {
    const block: SpacerBlock = { kind: 'spacer' };
    if (obj.rows !== undefined) block.rows = Number(obj.rows);
    return block;
  }

  if (kind === 'chart') {
    const ref = resolveStr(obj.ref, vars, ctx) ?? '';
    return {
      kind: 'chart',
      ref,
      ...(obj.title !== undefined ? { title: resolveStr(obj.title, vars, ctx) } : {}),
    };
  }

  if (kind === 'table') {
    const source = resolveStr(obj.source, vars, ctx) ?? '';
    const block: TableBlock = {
      kind: 'table',
      source,
      rows: resolveRowsSpec(obj.rows, vars, ctx),
    };
    if (obj.title !== undefined) block.title = resolveStr(obj.title, vars, ctx);
    block.axis = resolveAxis(obj.axis, vars, ctx);
    if (block.axis === undefined) delete block.axis;
    const totalsRow = resolveTotalsRow(obj.totals_row, vars, ctx);
    if (totalsRow) block.totalsRow = totalsRow;
    const rollup = resolveRollup(obj.rollup, vars, ctx);
    if (rollup) block.rollup = rollup;
    if (obj.default_format !== undefined) {
      block.defaultFormat = resolveStr(obj.default_format, vars, ctx) as CellFormat;
    }
    const canonical = resolveCanonical(obj.canonical, vars, ctx);
    if (canonical) block.canonical = canonical;
    const filter = resolveFilter(obj.filter, vars, ctx);
    if (filter) block.filter = filter;
    return block;
  }

  // Unknown kind — skip
  return null;
}

// ─── Section resolution ───────────────────────────────────────────────────────

function resolveSection(
  rawSection: RawObj,
  vars: Vars,
  templates: Record<string, Template>,
  idPrefix: string,
): ReportSection {
  const ctx: Ctx = {};
  const id = idPrefix + (resolveStr(rawSection.id, vars, ctx) ?? '');
  const label = resolveStr(rawSection.label, vars, ctx) ?? '';
  const rawBlocks = Array.isArray(rawSection.blocks) ? rawSection.blocks : [];
  const blocks = resolveBlocks(rawBlocks, vars, ctx, templates);

  const section: ReportSection = { id, label, blocks };
  if (rawSection.hint !== undefined) section.hint = resolveStr(rawSection.hint, vars, ctx);
  if (rawSection.engine_ref !== undefined) section.engineRef = resolveStr(rawSection.engine_ref, vars, ctx);
  return section;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function resolveReport(raw: unknown, idPrefix = ''): ReportDef {
  const top = asObj(raw as RawVal) ?? {};

  // Resolve top-level vars
  const rawVars = asObj(top.vars) ?? {};
  const vars: Vars = {};
  for (const [k, v] of Object.entries(rawVars)) {
    vars[k] = v;
  }

  // Resolve templates
  const rawTemplates = asObj(top.templates) ?? {};
  const templates = resolveTemplates(rawTemplates);

  // Resolve sections
  const rawSections = Array.isArray(top.sections) ? top.sections : [];
  const rawSectionObjs = rawSections
    .map((s) => asObj(s))
    .filter((s): s is RawObj => s !== undefined);

  const sections: ReportSection[] = rawSectionObjs.map((s) =>
    resolveSection(s, vars, templates, idPrefix),
  );

  const def: ReportDef = { sections };
  if (top.calendar !== undefined) {
    const ctx: Ctx = {};
    def.calendarRef = resolveStr(top.calendar, vars, ctx);
  }
  if (Array.isArray(top.hidden_sheets)) {
    def.hiddenSheets = top.hidden_sheets.map((x) => String(x));
  }

  return def;
}
