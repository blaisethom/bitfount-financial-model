import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import FormulaTooltip from './FormulaTooltip';

export interface MonthlyRow {
  metric: string;
  rowKey: string;
  type?: 'A' | 'B' | 'C' | 'total';
  isTotal?: boolean;
  values: number[];
  /** General formula description shown when hovering the row label. */
  rowTooltip?: string;
  /** Per-cell explanation: receives the month index and the value, returns a multi-section string. */
  cellTooltip?: (monthIdx: number, value: number) => string | null;
  /** Override the grid-level `editable` for this row (e.g. allow editing HubSpot rows in an otherwise-read-only grid). */
  editable?: boolean;
}

interface Props {
  dates: string[];
  rows: MonthlyRow[];
  editable?: boolean;
  onCellEdit?: (rowKey: string, monthIdx: number, value: number) => void;
  format?: 'money' | 'count';
  height?: number;
}

export default function MonthlyGrid({
  dates,
  rows,
  editable = false,
  onCellEdit,
  format = 'money',
  height = 220,
}: Props) {
  const rowData = useMemo(
    () =>
      rows.map((r) => {
        const obj: Record<string, unknown> = {
          metric: r.metric,
          rowKey: r.rowKey,
          isTotal: r.isTotal,
          rowTooltip: r.rowTooltip,
          cellTooltip: r.cellTooltip,
          rowEditable: r.editable,
        };
        for (let i = 0; i < dates.length; i++) obj[`m${i}`] = r.values[i];
        return obj;
      }),
    [rows, dates],
  );

  const anyEditable = editable || rows.some((r) => r.editable);

  const columnDefs = useMemo<ColDef[]>(() => {
    const cols: ColDef[] = [
      {
        field: 'metric',
        headerName: '',
        pinned: 'left',
        width: 240,
        editable: false,
        tooltipValueGetter: (p) => (p.data as { rowTooltip?: string } | undefined)?.rowTooltip ?? null,
        tooltipComponent: FormulaTooltip,
        cellStyle: (p) => (p.data?.isTotal ? { fontWeight: 600, background: '#f5f5f5' } : null),
      },
    ];
    for (let i = 0; i < dates.length; i++) {
      cols.push({
        field: `m${i}`,
        headerName: dates[i],
        width: 78,
        editable: (p) => {
          if (p.data?.isTotal) return false;
          if (typeof p.data?.rowEditable === 'boolean') return p.data.rowEditable;
          return !!editable;
        },
        valueFormatter: (p) => fmt(p.value, format),
        cellStyle: (p) => {
          if (p.data?.isTotal) return { fontWeight: 600, background: '#f5f5f5' };
          if (p.data?.rowEditable) return { fontWeight: 400, background: '#fefce8' };
          return null;
        },
        valueParser: (p) => {
          const n = parseFloat(p.newValue);
          return Number.isNaN(n) ? 0 : n;
        },
        tooltipValueGetter: (p) => {
          const data = p.data as { cellTooltip?: (i: number, v: number) => string | null } | undefined;
          if (!data?.cellTooltip) return null;
          return data.cellTooltip(i, p.value);
        },
        tooltipComponent: FormulaTooltip,
      });
    }
    return cols;
  }, [dates, editable, format]);

  return (
    <div className="ag-theme-quartz" style={{ height }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        tooltipShowDelay={250}
        tooltipHideDelay={20000}
        tooltipMouseTrack
        onCellValueChanged={(p) => {
          if (!anyEditable || !onCellEdit) return;
          const data = p.data as { rowKey: string; rowEditable?: boolean; isTotal?: boolean };
          if (data.isTotal) return;
          if (typeof data.rowEditable === 'boolean' && !data.rowEditable) return;
          const idx = parseInt((p.colDef.field || 'm0').slice(1), 10);
          const v = typeof p.newValue === 'string' ? parseFloat(p.newValue) : p.newValue;
          onCellEdit(data.rowKey, idx, Number.isNaN(v) ? 0 : v);
        }}
      />
    </div>
  );
}

function fmt(v: number | undefined, format: 'money' | 'count'): string {
  if (v == null) return '';
  if (format === 'count') {
    if (v === 0) return '';
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  if (v === 0) return '';
  return Math.round(v).toLocaleString();
}
