// Renders a single engine step-output or source table as a month-pivot HTML
// table. Intended for use in composite web tabs where you want a lightweight
// pivot of a specific engine ref without writing a full ReportSection block.
//
// Layout rules (same logic as EnginePreview's SourceTablePreview):
//   - If the table contains the model's defaultAxis column → pivot mode:
//       row-key cols = every non-axis, non-numeric column (minus axis-dependent
//       cols like `date`); value cols = every numeric column;
//       axis values spread across the column header.
//   - Otherwise → flat row-per-record table.

import { useMemo } from 'react';
import type { EvalResult, ModelDef, Table } from '../engine';

interface Props {
  /** Engine step-output or source ref to display. */
  ref_: string;
  evalResult: EvalResult;
  model: ModelDef;
  /** Optional override heading; defaults to the ref name. */
  title?: string;
}

// ─── pivot helpers ───────────────────────────────────────────────────────────

type Column = { name: string; type: string };

function isAxisDependent(table: Table, col: string, axis: string): boolean {
  const mapping = new Map<string, string>();
  for (const r of table.rows) {
    const a = String(r[axis] ?? '');
    const v = String(r[col] ?? '');
    const prev = mapping.get(a);
    if (prev === undefined) mapping.set(a, v);
    else if (prev !== v) return false;
  }
  return true;
}

function detectPivot(
  table: Table,
  axis: string,
): { keyCols: Column[]; valueCols: Column[] } | null {
  const cols = table.schema.columns as Column[];
  if (!cols.find((c) => c.name === axis)) return null;
  const others = cols.filter((c) => c.name !== axis);
  const valueCols = others.filter((c) => c.type === 'number');
  const keyCols = others
    .filter((c) => c.type !== 'number')
    .filter((c) => !isAxisDependent(table, c.name, axis));
  if (valueCols.length === 0) return null;
  return { keyCols, valueCols };
}

function buildDateMap(evalResult: EvalResult): Map<number, string> {
  const m = new Map<number, string>();
  const dates = evalResult.tables['dates_t'];
  if (dates) {
    for (const r of dates.rows) {
      if (r.month_idx != null && r.date != null) {
        m.set(Number(r.month_idx), String(r.date));
      }
    }
  }
  return m;
}

function fmtNum(v: unknown): string {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n) || n === 0) return '';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

// ─── component ───────────────────────────────────────────────────────────────

export default function EnginePivotTable({ ref_, evalResult, model, title }: Props) {
  const table = evalResult.tables[ref_];
  const axis = model.defaultAxis;

  const dateMap = useMemo(() => buildDateMap(evalResult), [evalResult]);

  if (!table) {
    return (
      <div className="engine-pivot-table-wrap">
        <h3 className="engine-pivot-table-title">{title ?? ref_}</h3>
        <p className="hint">{ref_} — not yet materialised</p>
      </div>
    );
  }

  const pivot = axis ? detectPivot(table, axis) : null;

  const heading = title ?? ref_;

  if (!pivot || !axis) {
    // Flat table
    const cols = table.schema.columns as Column[];
    return (
      <div className="engine-pivot-table-wrap">
        <h3 className="engine-pivot-table-title">{heading}</h3>
        <div className="engine-table-scroll engine-table-scroll--bounded">
          <table className="yearly-emp-table" style={{ fontSize: 12 }}>
            <thead>
              <tr>{cols.map((c) => <th key={c.name}>{c.name}</th>)}</tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.name} style={{ textAlign: c.type === 'number' ? 'right' : 'left' }}>
                      {c.type === 'number' ? fmtNum(r[c.name]) : String(r[c.name] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // Pivot table
  const { keyCols, valueCols } = pivot;
  const showMetricCol = valueCols.length > 1 || keyCols.length === 0;

  type PivotRow = { keyValues: string[]; metric: string; byAxis: Map<string, unknown> };
  const rows = new Map<string, PivotRow>();
  const axisSet = new Set<string>();
  const axisNumeric = (table.schema.columns.find((c) => c.name === axis) as Column | undefined)?.type === 'number';

  for (const r of table.rows) {
    const av = r[axis];
    if (av == null) continue;
    const ak = String(av);
    axisSet.add(ak);
    const keyPart = keyCols.map((c) => String(r[c.name] ?? '')).join('\x1f');
    for (const vc of valueCols) {
      const fullKey = keyPart + '\x1f' + vc.name;
      if (!rows.has(fullKey)) {
        rows.set(fullKey, {
          keyValues: keyCols.map((c) => String(r[c.name] ?? '')),
          metric: vc.name,
          byAxis: new Map(),
        });
      }
      rows.get(fullKey)!.byAxis.set(ak, r[vc.name]);
    }
  }

  const axisValues = [...axisSet].sort((a, b) =>
    axisNumeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0,
  );

  const renderAxisHeader = (ak: string) => {
    if (axis === 'month_idx' && dateMap) return dateMap.get(Number(ak)) ?? `m${ak}`;
    return ak;
  };

  return (
    <div className="engine-pivot-table-wrap">
      <h3 className="engine-pivot-table-title">{heading}</h3>
      <div className="engine-pivot-axes" style={{ marginBottom: 4 }}>
        <span>
          <span className="engine-pivot-axes-label">x-axis: </span>
          <code className="engine-pivot-axes-name">{axis}</code>
        </span>
        <span>
          <span className="engine-pivot-axes-label">{valueCols.length === 1 ? 'value: ' : 'values: '}</span>
          {valueCols.map((c, i) => (
            <span key={c.name}>
              {i > 0 && <span style={{ color: 'var(--muted)' }}>, </span>}
              <code className="engine-pivot-axes-name">{c.name}</code>
            </span>
          ))}
        </span>
      </div>
      <div className="engine-table-scroll engine-table-scroll--bounded">
        <table className="yearly-emp-table engine-pivot-table" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              {keyCols.map((c) => (
                <th key={c.name} className="engine-pivot-key">{c.name}</th>
              ))}
              {showMetricCol && (
                <th className="engine-pivot-key engine-pivot-metric-col">metric</th>
              )}
              {axisValues.map((v) => (
                <th key={v} className="engine-pivot-month">{renderAxisHeader(v)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows.values()].map((row, i) => (
              <tr key={i}>
                {row.keyValues.map((kv, j) => (
                  <td key={j} className="engine-pivot-key">{kv}</td>
                ))}
                {showMetricCol && (
                  <td className="engine-pivot-key engine-pivot-metric-col">{row.metric}</td>
                )}
                {axisValues.map((v) => {
                  const val = row.byAxis.get(v);
                  return (
                    <td key={v} className="engine-pivot-cell" style={{ textAlign: 'right' }}>
                      {fmtNum(val)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
