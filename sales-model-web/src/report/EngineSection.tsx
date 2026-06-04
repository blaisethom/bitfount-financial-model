// React renderer for a ReportDef section. Mirrors the Excel renderer's
// behaviour: canonical blocks render editable cells; derived blocks render
// computed values from the eval result. Edits emit a {source, identity, col,
// value} event that the host application translates back into ModelInput
// mutations (see applyEdit.ts).
//
// Each TableBlock becomes an AG-Grid table. Three layouts:
//   - axis + pivot-rows / value-columns : month columns across, value rows
//   - no-axis value-columns             : parameter/value vertical list
//   - no-axis table-rows                : schema columns (roster style)

import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef, CellClassParams } from 'ag-grid-community';
import type { CellValue, EvalResult, ModelDef, Row, Table } from '../engine';
import type {
  CellFormat, ReportBlock, ReportDef, ReportSection, TableBlock,
  TitleBlock, ParagraphBlock, RowsSpec,
} from './types';
import { IdentityResolver, SOURCE_IDENTITY } from './identity';

export interface ReportEdit {
  source: string;
  identity: Record<string, CellValue>;
  col: string;
  value: number | string;
}

interface Props {
  report: ReportDef;
  evalResult: EvalResult;
  model: ModelDef;
  sectionId: string;
  onEdit?: (edit: ReportEdit) => void;
}


function dateLabels(evalResult: EvalResult, calendarRef?: string): string[] {
  if (!calendarRef) return [];
  const t = evalResult.tables[calendarRef];
  if (!t) return [];
  const out: string[] = [];
  for (const r of t.rows) out[Number(r.month_idx)] = String(r.date);
  return out;
}

function fmtValue(v: unknown, format: CellFormat): string {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  if (n === 0) return '';
  if (format === 'money') return '$' + Math.round(n).toLocaleString();
  if (format === 'count' || format === 'integer') return Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (format === 'percent') return (n * 100).toFixed(2) + '%';
  return String(v);
}

function findRow(t: Table, idCols: string[], identity: Record<string, CellValue>): Row | undefined {
  return t.rows.find((r) => idCols.every((k) => r[k] === identity[k]));
}

function isCanonical(model: ModelDef, block: TableBlock): boolean {
  const refs = block.canonical?.refs ?? [];
  if (refs.includes(block.source)) return true;
  if (refs.length) return false;
  const src = model.sources[block.source];
  return !!src && (src.kind === 'manual' || src.kind === 'literal');
}

function applyFilter(
  rows: Row[],
  filter?: Record<string, string | number | Array<string | number>>,
): Row[] {
  if (!filter) return rows;
  return rows.filter((r) =>
    Object.entries(filter).every(([k, v]) =>
      Array.isArray(v) ? (v as Array<string | number>).includes(r[k] as string | number) : r[k] === v,
    ),
  );
}

function uniqueAxisValues(rows: Row[], axisCol: string): Array<string | number> {
  const seen = new Set<string | number>();
  for (const r of rows) {
    const v = r[axisCol];
    if (v == null) continue;
    seen.add(v as string | number);
  }
  const arr = Array.from(seen);
  if (arr.every((v) => typeof v === 'number')) return (arr as number[]).sort((a, b) => a - b);
  return (arr as string[]).sort();
}

function yearGroups(
  evalResult: EvalResult, report: ReportDef, axisValues: Array<string | number>,
): Array<{ year: number; indexes: number[] }> {
  const dates = dateLabels(evalResult, report.calendarRef);
  const groups = new Map<number, number[]>();
  axisValues.forEach((v, i) => {
    const d = dates[Number(v)];
    if (!d) return;
    const y = parseInt(d.slice(0, 4), 10);
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y)!.push(i);
  });
  return Array.from(groups.entries())
    .sort(([a], [b]) => a - b).map(([year, indexes]) => ({ year, indexes }));
}

export default function EngineSection({ report, evalResult, model, sectionId, onEdit }: Props) {
  const section = report.sections.find((s) => s.id === sectionId);
  const identity = useMemo(() => new IdentityResolver(model), [model]);
  if (!section) return <p className="hint">Unknown section: <code>{sectionId}</code></p>;
  return (
    <div className="engine-section">
      {section.hint && <p className="hint">{section.hint}</p>}
      {section.blocks.map((block, i) => (
        <BlockRenderer
          key={i}
          block={block}
          report={report}
          evalResult={evalResult}
          model={model}
          identity={identity}
          onEdit={onEdit}
        />
      ))}
    </div>
  );
}

interface BlockProps {
  block: ReportBlock;
  report: ReportDef;
  evalResult: EvalResult;
  model: ModelDef;
  identity: IdentityResolver;
  onEdit?: (edit: ReportEdit) => void;
}

function BlockRenderer(p: BlockProps) {
  switch (p.block.kind) {
    case 'title':     return <TitleRenderer block={p.block} />;
    case 'paragraph': return <ParagraphRenderer block={p.block} />;
    case 'spacer':    return <div style={{ height: (p.block.rows ?? 1) * 12 }} />;
    case 'table':     return <TableRenderer {...p} block={p.block} />;
  }
}

function TitleRenderer({ block }: { block: TitleBlock }) {
  const level = block.level ?? 1;
  if (level === 1) return <h3 className="engine-title">{block.text}</h3>;
  if (level === 2) return <h4 className="engine-subtitle">{block.text}</h4>;
  return <h5 className="engine-subsubtitle">{block.text}</h5>;
}

function ParagraphRenderer({ block }: { block: ParagraphBlock }) {
  return <p className="hint" style={block.italic ? { fontStyle: 'italic' } : undefined}>{block.text}</p>;
}

interface TableProps extends BlockProps {
  block: TableBlock;
}

function TableRenderer({ block, report, evalResult, model, identity, onEdit }: TableProps) {
  const source = evalResult.tables[block.source];
  if (!source) return <p className="hint">missing engine table {block.source}</p>;

  const filtered = applyFilter(source.rows, block.filter);
  const filterKeys: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(block.filter ?? {})) {
    if (!Array.isArray(v)) filterKeys[k] = v;
  }
  const canonical = isCanonical(model, block);

  // Groups (per groupBy.keys); a single 'all' group if no groupBy.
  const groups = useMemo(() => {
    if (!block.groupBy) return [{ keyVals: filterKeys, label: null as string | null, rows: filtered }];
    const by = new Map<string, { keyVals: Record<string, CellValue>; rows: Row[] }>();
    for (const r of filtered) {
      const keyVals: Record<string, CellValue> = { ...filterKeys };
      for (const k of block.groupBy.keys) keyVals[k] = r[k];
      const k = block.groupBy.keys.map((kk) => String(keyVals[kk] ?? '')).join('\x1f');
      if (!by.has(k)) by.set(k, { keyVals, rows: [] });
      by.get(k)!.rows.push(r);
    }
    return Array.from(by.values()).map((g) => ({
      keyVals: g.keyVals,
      label: block.groupBy!.label(g.keyVals as Record<string, string | number>),
      rows: g.rows,
    }));
  }, [filtered, block.groupBy, filterKeys]);

  const axisCols = useMemo(() => block.axis ? uniqueAxisValues(source.rows, block.axis.col) : [], [source.rows, block.axis]);
  const axisLabels = useMemo(() => {
    if (!block.axis) return [];
    if (block.axis.labels === 'dates') {
      const dates = dateLabels(evalResult, report.calendarRef);
      return axisCols.map((v) => dates[Number(v)] ?? String(v));
    }
    return axisCols.map((v) => String(v));
  }, [axisCols, block.axis, evalResult, report.calendarRef]);
  const rollupYears = useMemo(() => block.rollup?.yearTotals ? yearGroups(evalResult, report, axisCols) : [], [evalResult, report, axisCols, block.rollup]);

  return (
    <div className="engine-block">
      {block.title && <h4 className="engine-subtitle">{block.title}</h4>}
      {groups.map((group, gi) => (
        <div key={gi} className="engine-table-group">
          {group.label && <h5 className="engine-subsubtitle">{group.label}</h5>}
          <TableGroupGrid
            block={block}
            group={group}
            source={source}
            axisCols={axisCols}
            axisLabels={axisLabels}
            rollupYears={rollupYears}
            canonical={canonical}
            evalResult={evalResult}
            identity={identity}
            onEdit={onEdit}
          />
        </div>
      ))}
    </div>
  );
}

interface GroupProps {
  block: TableBlock;
  group: { keyVals: Record<string, CellValue>; label: string | null; rows: Row[] };
  source: Table;
  axisCols: Array<string | number>;
  axisLabels: string[];
  rollupYears: Array<{ year: number; indexes: number[] }>;
  canonical: boolean;
  evalResult: EvalResult;
  identity: IdentityResolver;
  onEdit?: (edit: ReportEdit) => void;
}

function TableGroupGrid({ block, group, source, axisCols, axisLabels, rollupYears, canonical, evalResult, identity, onEdit }: GroupProps) {
  // Build rows according to RowsSpec; columns according to axis vs no-axis.
  const { rowData, columnDefs, height } = useMemo(() => {
    return buildGrid(block, group, source, axisCols, axisLabels, rollupYears, canonical, evalResult, identity);
  }, [block, group, source, axisCols, axisLabels, rollupYears, canonical, evalResult, identity]);

  const onCellValueChanged = (p: { data: Record<string, unknown>; colDef: ColDef; newValue: unknown }) => {
    if (!onEdit || !canonical) return;
    const data = p.data as { __identity?: Record<string, CellValue>; __valueCol?: string };
    const identity = { ...data.__identity };
    const colSpec = p.colDef as ColDef & { __axisVal?: string | number; __overrideCol?: string };
    const valueCol = colSpec.__overrideCol ?? data.__valueCol;
    if (!valueCol || !identity) return;
    // For axis-pivoted tables, the column also carries the axis value.
    if (block.axis && colSpec.__axisVal !== undefined) {
      identity[block.axis.col] = colSpec.__axisVal;
    }
    const raw = p.newValue;
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
    const value = Number.isNaN(num) ? (raw as string) : num;
    onEdit({ source: block.source, identity, col: valueCol, value });
  };

  return (
    <div className="ag-theme-quartz" style={{ height, marginBottom: 16 }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        onCellValueChanged={onCellValueChanged}
      />
    </div>
  );
}

interface GridSpec {
  rowData: Array<Record<string, unknown>>;
  columnDefs: ColDef[];
  height: number;
}

function buildGrid(
  block: TableBlock,
  group: GroupProps['group'],
  source: Table,
  axisCols: Array<string | number>,
  axisLabels: string[],
  rollupYears: GroupProps['rollupYears'],
  canonical: boolean,
  evalResult: EvalResult,
  identity: IdentityResolver,
): GridSpec {
  const fmt: CellFormat = block.defaultFormat ?? 'money';
  const rowsSpec: RowsSpec = block.rows;

  // ── Explicit rows (mixed sources) ──
  if (rowsSpec.kind === 'explicit' && axisCols.length) {
    return buildExplicitGrid(block, axisCols, axisLabels, rollupYears, fmt, evalResult, identity);
  }
  // ── Pivoted (axis + pivot-rows / value-columns) ──
  if (axisCols.length && (rowsSpec.kind === 'pivot-rows' || rowsSpec.kind === 'value-columns')) {
    return buildPivotGrid(block, group, source, axisCols, axisLabels, rollupYears, canonical, fmt, identity);
  }
  // ── No axis, value-columns: parameter / value list ──
  if (!axisCols.length && rowsSpec.kind === 'value-columns') {
    return buildKeyValueGrid(block, group, source, canonical, fmt);
  }
  // ── No axis, table-rows: schema columns as roster grid ──
  if (rowsSpec.kind === 'table-rows') {
    return buildRosterGrid(block, group, source, canonical, fmt);
  }
  return { rowData: [], columnDefs: [], height: 80 };
}

const FORMATTER_BY_FMT: Record<CellFormat, (v: unknown) => string> = {
  money: (v) => fmtValue(v, 'money'),
  count: (v) => fmtValue(v, 'count'),
  integer: (v) => fmtValue(v, 'integer'),
  percent: (v) => fmtValue(v, 'percent'),
  text: (v) => fmtValue(v, 'text'),
};

function buildPivotGrid(
  block: TableBlock,
  group: GroupProps['group'],
  source: Table,
  axisCols: Array<string | number>,
  axisLabels: string[],
  rollupYears: GroupProps['rollupYears'],
  canonical: boolean,
  defaultFmt: CellFormat,
  identity: IdentityResolver,
): GridSpec {
  const idCols = identity.for(block.source);
  // Fallback for sources that the resolver doesn't know about: take string cols.
  const idColsResolved = idCols.length
    ? idCols
    : source.schema.columns.filter((c) => c.type !== 'number').map((c) => c.name);

  const columnDefs: ColDef[] = [
    {
      field: 'metric',
      headerName: block.rows.kind === 'pivot-rows' ? (block.rows.labelHeader ?? '') : '',
      pinned: 'left',
      width: 220,
      editable: false,
    },
  ];

  axisCols.forEach((axisVal, i) => {
    columnDefs.push({
      field: `m${i}`,
      headerName: axisLabels[i],
      width: 84,
      editable: canonical,
      valueFormatter: (p) => FORMATTER_BY_FMT[defaultFmt](p.value),
      valueParser: (p) => {
        const n = parseFloat(p.newValue);
        return Number.isNaN(n) ? 0 : n;
      },
      // Carry the axis value so onCellValueChanged can build the identity.
      __axisVal: axisVal,
    } as ColDef & { __axisVal?: string | number });
  });

  rollupYears.forEach((yg, i) => {
    columnDefs.push({
      field: `y${i}`,
      headerName: String(yg.year),
      width: 96,
      editable: false,
      valueFormatter: (p) => FORMATTER_BY_FMT[defaultFmt](p.value),
      cellStyle: () => ({ fontWeight: 600, background: '#f5f5f5' }),
    });
  });

  if (block.rollup?.grandTotal) {
    columnDefs.push({
      field: 'grand',
      headerName: block.rollup.grandTotalLabel ?? 'Total',
      width: 104,
      editable: false,
      valueFormatter: (p) => FORMATTER_BY_FMT[defaultFmt](p.value),
      cellStyle: () => ({ fontWeight: 700, background: '#f5f5f5' }),
    });
  }

  const rowData: Array<Record<string, unknown>> = [];

  if (block.rows.kind === 'pivot-rows') {
    const pr = block.rows;
    const labelVals = Array.from(new Set(group.rows.map((r) => r[pr.labelCol] as string | number)))
      .sort((a, b) => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)));
    for (const labelVal of labelVals) {
      const obj: Record<string, unknown> = {
        metric: pr.labelMap?.[String(labelVal)] ?? String(labelVal),
        __identity: { ...group.keyVals, [pr.labelCol]: labelVal },
        __valueCol: pr.valueCol,
      };
      const valuesByAxis: number[] = [];
      axisCols.forEach((axisVal, i) => {
        const ident: Record<string, CellValue> = { ...group.keyVals, [pr.labelCol]: labelVal };
        if (block.axis) ident[block.axis.col] = axisVal;
        const row = findRow(source, idColsResolved, ident);
        const v = (row?.[pr.valueCol] ?? 0) as number;
        obj[`m${i}`] = v;
        valuesByAxis[i] = v;
      });
      rollupYears.forEach((yg, yi) => {
        obj[`y${yi}`] = yg.indexes.reduce((s, idx) => s + (valuesByAxis[idx] ?? 0), 0);
      });
      if (block.rollup?.grandTotal) {
        obj.grand = valuesByAxis.reduce((s, v) => s + (v ?? 0), 0);
      }
      rowData.push(obj);
    }
    // Totals row
    if (block.totalsRow && rowData.length) {
      const totRow: Record<string, unknown> = { metric: block.totalsRow.label, __identity: null };
      axisCols.forEach((_, i) => {
        totRow[`m${i}`] = rowData.reduce((s, r) => s + ((r[`m${i}`] as number) ?? 0), 0);
      });
      rollupYears.forEach((_, yi) => {
        totRow[`y${yi}`] = rowData.reduce((s, r) => s + ((r[`y${yi}`] as number) ?? 0), 0);
      });
      if (block.rollup?.grandTotal) {
        totRow.grand = rowData.reduce((s, r) => s + ((r.grand as number) ?? 0), 0);
      }
      totRow.__isTotal = true;
      rowData.push(totRow);
    }
  } else if (block.rows.kind === 'value-columns') {
    for (const spec of block.rows.rows) {
      const obj: Record<string, unknown> = {
        metric: spec.label ?? spec.col,
        __identity: { ...group.keyVals },
        __valueCol: spec.col,
        __bold: spec.bold,
      };
      const valuesByAxis: number[] = [];
      const fmtThis: CellFormat = spec.format ?? defaultFmt;
      axisCols.forEach((axisVal, i) => {
        const ident: Record<string, CellValue> = { ...group.keyVals };
        if (block.axis) ident[block.axis.col] = axisVal;
        const row = findRow(source, idColsResolved, ident);
        const v = (row?.[spec.col] ?? 0) as number;
        obj[`m${i}`] = v;
        valuesByAxis[i] = v;
      });
      rollupYears.forEach((yg, yi) => {
        obj[`y${yi}`] = yg.indexes.reduce((s, idx) => s + (valuesByAxis[idx] ?? 0), 0);
      });
      if (block.rollup?.grandTotal) {
        obj.grand = valuesByAxis.reduce((s, v) => s + (v ?? 0), 0);
      }
      obj.__fmt = fmtThis;
      rowData.push(obj);
    }
    if (block.totalsRow && rowData.length) {
      const totRow: Record<string, unknown> = { metric: block.totalsRow.label, __isTotal: true };
      axisCols.forEach((_, i) => {
        totRow[`m${i}`] = rowData.reduce((s, r) => s + ((r[`m${i}`] as number) ?? 0), 0);
      });
      rollupYears.forEach((_, yi) => {
        totRow[`y${yi}`] = rowData.reduce((s, r) => s + ((r[`y${yi}`] as number) ?? 0), 0);
      });
      if (block.rollup?.grandTotal) {
        totRow.grand = rowData.reduce((s, r) => s + ((r.grand as number) ?? 0), 0);
      }
      rowData.push(totRow);
    }
  }

  // Apply bold / total styling
  columnDefs.forEach((cd) => {
    const base = cd.cellStyle;
    cd.cellStyle = (p: { data: { __isTotal?: boolean; __bold?: boolean } }) => {
      const baseStyle = typeof base === 'function' ? base(p as unknown as CellClassParams) : null;
      if (p.data?.__isTotal) return { ...(baseStyle || {}), fontWeight: 700, background: '#f5f5f5' };
      if (p.data?.__bold) return { ...(baseStyle || {}), fontWeight: 600 };
      return baseStyle;
    };
    if (cd.editable === true) {
      cd.editable = (p: { data: { __isTotal?: boolean } }) => !p.data?.__isTotal;
    }
  });

  const height = Math.max(80, 32 + rowData.length * 32);
  return { rowData, columnDefs, height };
}

function buildExplicitGrid(
  block: TableBlock,
  axisCols: Array<string | number>,
  axisLabels: string[],
  rollupYears: GroupProps['rollupYears'],
  defaultFmt: CellFormat,
  evalResult: EvalResult,
  identity: IdentityResolver,
): GridSpec {
  if (block.rows.kind !== 'explicit') return { rowData: [], columnDefs: [], height: 80 };
  const axisCol = block.axis?.col;

  const columnDefs: ColDef[] = [
    {
      field: 'metric',
      headerName: block.rows.labelHeader ?? '',
      pinned: 'left',
      width: 220,
      editable: false,
    },
  ];
  axisCols.forEach((_, i) => {
    columnDefs.push({
      field: `m${i}`,
      headerName: axisLabels[i],
      width: 84,
      editable: false,
      valueFormatter: (p) => {
        const fmt = (p.data as { __fmt?: CellFormat })?.__fmt ?? defaultFmt;
        return FORMATTER_BY_FMT[fmt](p.value);
      },
    });
  });
  rollupYears.forEach((yg, i) => {
    columnDefs.push({
      field: `y${i}`,
      headerName: String(yg.year),
      width: 96,
      editable: false,
      valueFormatter: (p) => {
        const fmt = (p.data as { __fmt?: CellFormat })?.__fmt ?? defaultFmt;
        return FORMATTER_BY_FMT[fmt](p.value);
      },
      cellStyle: () => ({ fontWeight: 600, background: '#f5f5f5' }),
    });
  });
  if (block.rollup?.grandTotal) {
    columnDefs.push({
      field: 'grand',
      headerName: block.rollup.grandTotalLabel ?? 'Total',
      width: 104,
      editable: false,
      valueFormatter: (p) => {
        const fmt = (p.data as { __fmt?: CellFormat })?.__fmt ?? defaultFmt;
        return FORMATTER_BY_FMT[fmt](p.value);
      },
      cellStyle: () => ({ fontWeight: 700, background: '#f5f5f5' }),
    });
  }

  const rowData: Array<Record<string, unknown>> = [];
  for (const spec of block.rows.rows) {
    const sourceRef = spec.source ?? block.source;
    const t = evalResult.tables[sourceRef];
    if (!t) continue;
    const idCols = identity.for(sourceRef);
    const obj: Record<string, unknown> = {
      metric: spec.label,
      __fmt: spec.format ?? defaultFmt,
      __bold: spec.bold,
    };
    const valuesByAxis: number[] = [];
    axisCols.forEach((axisVal, i) => {
      const ident: Record<string, CellValue> = { ...spec.identity };
      if (axisCol) ident[axisCol] = axisVal;
      const row = findRow(t, idCols, ident);
      const v = (row?.[spec.valueCol] ?? 0) as number;
      obj[`m${i}`] = v;
      valuesByAxis[i] = v;
    });
    rollupYears.forEach((yg, yi) => {
      obj[`y${yi}`] = yg.indexes.reduce((s, idx) => s + (valuesByAxis[idx] ?? 0), 0);
    });
    if (block.rollup?.grandTotal) {
      obj.grand = valuesByAxis.reduce((s, v) => s + (v ?? 0), 0);
    }
    rowData.push(obj);
  }

  // Apply per-row bold styling
  columnDefs.forEach((cd) => {
    const base = cd.cellStyle;
    cd.cellStyle = (p: { data: { __bold?: boolean } }) => {
      const baseStyle = typeof base === 'function' ? base(p as unknown as CellClassParams) : null;
      if (p.data?.__bold) return { ...(baseStyle || {}), fontWeight: 700, background: '#f5f5f5' };
      return baseStyle;
    };
  });

  const height = Math.max(80, 32 + rowData.length * 32);
  return { rowData, columnDefs, height };
}

function buildKeyValueGrid(
  block: TableBlock,
  group: GroupProps['group'],
  _source: Table,
  canonical: boolean,
  defaultFmt: CellFormat,
): GridSpec {
  if (block.rows.kind !== 'value-columns') return { rowData: [], columnDefs: [], height: 80 };
  const baseRow = group.rows[0];
  const idCols = SOURCE_IDENTITY[block.source] ?? [];
  const identity: Record<string, CellValue> = { ...group.keyVals };
  if (baseRow) for (const c of idCols) identity[c] = baseRow[c];
  const rowData = block.rows.rows.map((spec) => ({
    metric: spec.label ?? spec.col,
    value: baseRow?.[spec.col] ?? 0,
    __identity: identity,
    __valueCol: spec.col,
    __fmt: spec.format ?? defaultFmt,
  }));
  const columnDefs: ColDef[] = [
    { field: 'metric', headerName: 'Parameter', pinned: 'left', width: 280, editable: false },
    {
      field: 'value',
      headerName: 'Value',
      width: 160,
      editable: canonical,
      valueFormatter: (p) => {
        const fmt = (p.data as { __fmt?: CellFormat })?.__fmt ?? defaultFmt;
        return FORMATTER_BY_FMT[fmt](p.value);
      },
      valueParser: (p) => {
        const n = parseFloat(p.newValue);
        return Number.isNaN(n) ? p.newValue : n;
      },
    } as ColDef,
  ];
  const height = Math.max(80, 32 + rowData.length * 32);
  return { rowData, columnDefs, height };
}

function buildRosterGrid(
  block: TableBlock,
  group: GroupProps['group'],
  source: Table,
  canonical: boolean,
  _defaultFmt: CellFormat,
): GridSpec {
  if (block.rows.kind !== 'table-rows') return { rowData: [], columnDefs: [], height: 80 };
  const rowsSpec = block.rows;
  const idCols = SOURCE_IDENTITY[block.source] ?? [];
  const otherCols = source.schema.columns.filter((c) => !idCols.includes(c.name) && c.name !== rowsSpec.labelCol);

  const columnDefs: ColDef[] = [
    {
      field: 'metric',
      headerName: rowsSpec.labelHeader ?? '',
      pinned: 'left',
      width: 140,
      editable: false,
    },
    ...otherCols.map((c): ColDef => ({
      field: c.name,
      headerName: c.name,
      width: 140,
      editable: canonical,
      valueFormatter: c.type === 'number'
        ? (p) => fmtValue(p.value, 'money')
        : undefined,
      valueParser: c.type === 'number'
        ? (p) => {
            const n = parseFloat(p.newValue);
            return Number.isNaN(n) ? p.newValue : n;
          }
        : undefined,
      __overrideCol: c.name,
    } as ColDef & { __overrideCol?: string })),
  ];

  const rowData = group.rows.map((r) => {
    const obj: Record<string, unknown> = {
      metric: r[rowsSpec.labelCol],
      __identity: Object.fromEntries(idCols.map((c) => [c, r[c]])),
    };
    for (const c of otherCols) obj[c.name] = r[c.name];
    return obj;
  });

  const height = Math.max(120, 32 + rowData.length * 32);
  return { rowData, columnDefs, height };
}

// Re-export the section ID list for routing.
export function reportSectionIds(report: ReportDef): ReportSection[] {
  return report.sections;
}
