import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import type { EmployeeAssumptions } from '../types';

interface Props {
  assumptions: EmployeeAssumptions;
  onChange: (next: EmployeeAssumptions) => void;
}

export default function EmployeeAssumptionsGrid({ assumptions, onChange }: Props) {
  const rowData = useMemo(
    () => [
      {
        metric: 'NI rate',
        key: 'niRate',
        value: assumptions.niRate,
        format: 'pct' as const,
      },
      {
        metric: 'Pension rate',
        key: 'pensionRate',
        value: assumptions.pensionRate,
        format: 'pct' as const,
      },
      {
        metric: 'Total on-costs (derived)',
        key: '__on',
        value: assumptions.niRate + assumptions.pensionRate,
        format: 'pct' as const,
        derived: true,
      },
      {
        metric: 'Annual inflation',
        key: 'annualInflationRate',
        value: assumptions.annualInflationRate,
        format: 'pct' as const,
      },
      {
        metric: 'Inflation start year',
        key: 'inflationStartYear',
        value: assumptions.inflationStartYear,
        format: 'int' as const,
      },
      {
        metric: 'Inflation start month (1-12)',
        key: 'inflationStartMonth',
        value: assumptions.inflationStartMonth,
        format: 'int' as const,
      },
    ],
    [assumptions],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      { field: 'metric', headerName: '', width: 280, pinned: 'left', editable: false },
      {
        field: 'value',
        headerName: 'Value',
        width: 180,
        editable: (p) => !p.data?.derived,
        valueFormatter: (p) => {
          const fmt = (p.data as { format: 'pct' | 'int' } | undefined)?.format;
          if (fmt === 'pct') return (p.value * 100).toFixed(2) + '%';
          if (fmt === 'int') return String(p.value);
          return String(p.value ?? '');
        },
        valueParser: (p) => {
          const fmt = (p.data as { format: 'pct' | 'int' } | undefined)?.format;
          const raw = String(p.newValue ?? '').replace(/%/g, '').trim();
          const n = parseFloat(raw);
          if (Number.isNaN(n)) return p.oldValue;
          if (fmt === 'pct') return n / 100;
          return n;
        },
        cellStyle: (p) => (p.data?.derived ? { fontStyle: 'italic', color: '#666' } : null),
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
          const data = p.data as { key: string; derived?: boolean };
          if (data.derived) return;
          const next = { ...assumptions, [data.key]: p.newValue };
          onChange(next);
        }}
      />
    </div>
  );
}
