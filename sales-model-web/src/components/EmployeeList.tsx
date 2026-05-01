import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import type { ColDef } from 'ag-grid-community';
import type { Employee, EmployeeAssumptions } from '../types';
import { loadedSalary } from '../model';

interface Props {
  employees: Employee[];
  assumptions: EmployeeAssumptions;
  onChange: (id: string, field: 'salary' | 'startDate' | 'department' | 'position', value: string | number) => void;
}

const DEPARTMENTS = ['Direct', 'S&M', 'G&A', 'Engineering', 'Product Support'];

export default function EmployeeList({ employees, assumptions, onChange }: Props) {
  const rowData = useMemo(
    () =>
      employees.map((e) => ({
        id: e.id,
        name: [e.firstName, e.surname].filter(Boolean).join(' ') || '—',
        position: e.position,
        department: e.department,
        location: e.location,
        startDate: e.startDate ?? '',
        salary: e.salary,
        loaded: loadedSalary(e.salary, assumptions),
      })),
    [employees, assumptions],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      { field: 'name', headerName: 'Name', width: 170, pinned: 'left' },
      { field: 'position', headerName: 'Position', width: 200, editable: true },
      {
        field: 'department',
        headerName: 'Dept',
        width: 130,
        editable: true,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: DEPARTMENTS },
      },
      { field: 'location', headerName: 'Loc', width: 70 },
      {
        field: 'startDate',
        headerName: 'Start',
        width: 110,
        editable: true,
      },
      {
        field: 'salary',
        headerName: 'Salary ($)',
        width: 130,
        editable: true,
        type: 'rightAligned',
        valueFormatter: (p) => money(p.value),
        valueParser: (p) => parseFloat(String(p.newValue).replace(/[, $]/g, '')) || 0,
      },
      {
        field: 'loaded',
        headerName: 'Loaded ($)',
        width: 130,
        type: 'rightAligned',
        valueFormatter: (p) => money(p.value),
        cellStyle: { fontStyle: 'italic', color: '#666' },
      },
    ],
    [],
  );

  return (
    <div className="ag-theme-quartz" style={{ height: 28 + 28 * (rowData.length + 1) }}>
      <AgGridReact
        rowData={rowData}
        columnDefs={columnDefs}
        singleClickEdit
        stopEditingWhenCellsLoseFocus
        onCellValueChanged={(p) => {
          const data = p.data as { id: string };
          const field = p.colDef.field as 'salary' | 'startDate' | 'department' | 'position' | undefined;
          if (!field || !['salary', 'startDate', 'department', 'position'].includes(field)) return;
          onChange(data.id, field, p.newValue as string | number);
        }}
      />
    </div>
  );
}

function money(v?: number): string {
  if (v == null || Number.isNaN(v)) return '';
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
