import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import type { ModelOutput } from '../types';

interface Props {
  output: ModelOutput;
  taNames: string[];
  /** "modeled" omits the HubSpot row and grand-total row. "total" includes them. */
  variant?: 'modeled' | 'total';
}

export default function YearlySummary({ output, taNames, variant = 'total' }: Props) {
  const rowData = useMemo(() => {
    const rows: Record<string, unknown>[] = [];
    const activeTAs = taNames.filter((ta) => output.yearly.perTA[ta].total.some((v) => v > 0));
    for (const ta of activeTAs) {
      const y = output.yearly.perTA[ta];
      const total6y = y.total.reduce((a, b) => a + b, 0);
      const obj: Record<string, unknown> = { ta, total: total6y };
      for (let i = 0; i < output.years.length; i++) obj[`y${output.years[i]}`] = y.total[i];
      rows.push(obj);
    }
    const modeledRow: Record<string, unknown> = {
      ta: variant === 'modeled' ? 'TOTAL' : 'Modeled subtotal',
      isModeledTotal: variant === 'total',
      isTotal: variant === 'modeled',
    };
    let modeledGrand = 0;
    for (let i = 0; i < output.years.length; i++) {
      modeledRow[`y${output.years[i]}`] = output.yearly.totals.total[i];
      modeledGrand += output.yearly.totals.total[i];
    }
    modeledRow.total = modeledGrand;
    rows.push(modeledRow);

    if (variant === 'total') {
      const hsRow: Record<string, unknown> = { ta: 'HubSpot pipeline' };
      let hsGrand = 0;
      for (let i = 0; i < output.years.length; i++) {
        hsRow[`y${output.years[i]}`] = output.yearly.hubspot[i];
        hsGrand += output.yearly.hubspot[i];
      }
      hsRow.total = hsGrand;
      rows.push(hsRow);

      const grandRow: Record<string, unknown> = { ta: 'GRAND TOTAL', isTotal: true };
      let grand = 0;
      for (let i = 0; i < output.years.length; i++) {
        grandRow[`y${output.years[i]}`] = output.yearly.grandTotal[i];
        grand += output.yearly.grandTotal[i];
      }
      grandRow.total = grand;
      rows.push(grandRow);
    }
    return rows;
  }, [output, taNames, variant]);

  const columnDefs = useMemo<ColDef[]>(() => {
    const cols: ColDef[] = [
      {
        field: 'ta',
        headerName: 'Therapeutic Area',
        pinned: 'left',
        width: 180,
        cellStyle: (p) =>
          p.data?.isTotal
            ? { fontWeight: 700, background: '#eef' }
            : p.data?.isModeledTotal
              ? { fontWeight: 600, background: '#f3f4f6' }
              : null,
      },
    ];
    for (const y of output.years) {
      cols.push({
        field: `y${y}`,
        headerName: String(y),
        width: 140,
        valueFormatter: (p) => money(p.value),
        type: 'rightAligned',
        cellStyle: (p) =>
          p.data?.isTotal
            ? { fontWeight: 700, background: '#eef' }
            : p.data?.isModeledTotal
              ? { fontWeight: 600, background: '#f3f4f6' }
              : null,
      });
    }
    cols.push({
      field: 'total',
      headerName: '6-yr Total',
      width: 160,
      valueFormatter: (p) => money(p.value),
      type: 'rightAligned',
      cellStyle: (p) =>
        p.data?.isTotal
          ? { fontWeight: 700, background: '#eef' }
          : p.data?.isModeledTotal
            ? { fontWeight: 600, background: '#f3f4f6' }
            : { fontWeight: 600, background: 'transparent' },
    });
    return cols;
  }, [output.years]);

  return (
    <div className="ag-theme-quartz" style={{ height: 28 + 28 * (rowData.length + 1) }}>
      <AgGridReact rowData={rowData} columnDefs={columnDefs} />
    </div>
  );
}

function money(v?: number): string {
  if (v == null || v === 0) return '';
  return '$' + Math.round(v).toLocaleString();
}
