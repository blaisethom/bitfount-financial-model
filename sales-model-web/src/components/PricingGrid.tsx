import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import type { Pricing, TrialType } from '../types';
import { platformPricePerYear } from '../model';

interface Props {
  pricing: Pricing;
  onChange: (next: Pricing) => void;
}

const FIELDS: { key: keyof Pricing['A']; label: string; integer?: boolean }[] = [
  { key: 'sites', label: 'Number of Sites', integer: true },
  { key: 'bitfountLicense', label: 'Bitfount License / site / yr ($)' },
  { key: 'aiLicense', label: 'AI Model License / site / yr ($)' },
  { key: 'projectFee', label: 'Project Configuration Fee / trial ($)' },
  { key: 'pmFee', label: 'Monthly PM Fee / trial ($)' },
];

export default function PricingGrid({ pricing, onChange }: Props) {
  const rowData = useMemo(() => {
    const rows = FIELDS.map((f) => ({
      metric: f.label,
      key: f.key,
      A: pricing.A[f.key],
      B: pricing.B[f.key],
      C: pricing.C[f.key],
    }));
    rows.push({
      metric: 'Platform license / trial / yr (derived)',
      key: '__platform' as never,
      A: platformPricePerYear(pricing, 'A'),
      B: platformPricePerYear(pricing, 'B'),
      C: platformPricePerYear(pricing, 'C'),
    });
    return rows;
  }, [pricing]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      { field: 'metric', headerName: '', pinned: 'left', width: 280, editable: false },
      ...(['A', 'B', 'C'] as TrialType[]).map((t) => ({
        field: t,
        headerName: t === 'A' ? 'Small (A)' : t === 'B' ? 'Medium (B)' : 'Large (C)',
        width: 140,
        editable: (params: { data: { key: string } }) => params.data.key !== '__platform',
        valueFormatter: (p: { value: number }) => fmtMoney(p.value),
        cellStyle: (p: { data: { key: string } }) =>
          p.data.key === '__platform' ? { fontStyle: 'italic', color: '#666' } : null,
      })),
    ],
    [],
  );

  const onCellValueChanged = (params: {
    data: { key: keyof Pricing['A'] };
    colDef: { field?: string };
    newValue: number | string;
  }) => {
    const t = params.colDef.field as TrialType | undefined;
    if (!t || !['A', 'B', 'C'].includes(t)) return;
    const v = typeof params.newValue === 'string' ? parseFloat(params.newValue) : params.newValue;
    if (Number.isNaN(v)) return;
    const next: Pricing = JSON.parse(JSON.stringify(pricing));
    next[t][params.data.key] = v;
    onChange(next);
  };

  return (
    <div className="ag-theme-quartz" style={{ height: 240 }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        onCellValueChanged={onCellValueChanged}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
      />
    </div>
  );
}

function fmtMoney(v: number) {
  if (v == null) return '';
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
