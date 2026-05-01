import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import type { CommissionAssumptions } from '../types';

interface Props {
  commission: CommissionAssumptions;
  onChange: (next: CommissionAssumptions) => void;
}

interface Row {
  metric: string;
  key: keyof CommissionAssumptions;
  value: number;
  format: 'pct' | 'money';
  help: string;
}

export default function CommissionGrid({ commission, onChange }: Props) {
  const rowData = useMemo<Row[]>(
    () => [
      {
        metric: 'Modeller commission rate',
        key: 'rate',
        value: commission.rate,
        format: 'pct',
        help: 'Fraction of AI Model License revenue paid to the model provider as a Cost-of-Sales commission.',
      },
      {
        metric: 'Modeller commission cap ($/TA/month)',
        key: 'capPerMonth',
        value: commission.capPerMonth,
        format: 'money',
        help: 'Maximum modeller commission per therapeutic area per month — the rate × revenue calculation is capped at this value.',
      },
      {
        metric: 'Sales commission per new client ($)',
        key: 'salesPerClient',
        value: commission.salesPerClient,
        format: 'money',
        help: 'Flat commission paid to S&M staff when a new client trial starts. Multiplied by total client starts that month across all TAs and types.',
      },
      {
        metric: 'Sales commission per-invoice rate',
        key: 'salesInvoiceRate',
        value: commission.salesInvoiceRate,
        format: 'pct',
        help: 'Fraction of total invoiced revenue paid to S&M as a per-invoice commission. Default 12% per the spreadsheet\'s formula — verifies against the early Excel months ($960 = 12% × $8,000 of HubSpot revenue in Jan/Feb 2026). Excel\'s row 349 has hardcoded values that drift from 12% in later months; this engine applies it cleanly.',
      },
    ],
    [commission],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: 'metric',
        headerName: 'Parameter',
        width: 320,
        pinned: 'left',
        editable: false,
        tooltipValueGetter: (p) => (p.data as Row | undefined)?.help ?? null,
      },
      {
        field: 'value',
        headerName: 'Value',
        width: 180,
        editable: true,
        valueFormatter: (p) => {
          const fmt = (p.data as Row | undefined)?.format;
          if (fmt === 'pct') return (p.value * 100).toFixed(1) + '%';
          if (fmt === 'money') return '$' + Math.round(p.value).toLocaleString();
          return String(p.value ?? '');
        },
        valueParser: (p) => {
          const fmt = (p.data as Row | undefined)?.format;
          const raw = String(p.newValue ?? '').replace(/[%$,]/g, '').trim();
          const n = parseFloat(raw);
          if (Number.isNaN(n)) return p.oldValue;
          if (fmt === 'pct') return n / 100;
          return n;
        },
        cellStyle: { background: '#fefce8' },
      },
    ],
    [],
  );

  return (
    <div className="ag-theme-quartz" style={{ height: 28 + 30 * (rowData.length + 1) }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        onCellValueChanged={(p) => {
          const data = p.data as Row;
          const next = { ...commission, [data.key]: p.newValue as number };
          onChange(next);
        }}
      />
    </div>
  );
}
