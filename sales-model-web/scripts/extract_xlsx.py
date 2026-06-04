"""Extract sales/employees/costs/hubspot JSON inputs from the 5-year-plan xlsx.

Reads xl/worksheets/*.xml directly with stdlib (zipfile + xml.etree),
mirrors the shape of src/{sales,employees,costs,hubspot}_data.json.

Usage:
    python3 scripts/extract_xlsx.py <path-to-xlsx> [--write] [--out src/]

Without --write, prints a diff summary against current JSON files.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

# Sheet name → 1-based sheet number used in xl/worksheets/sheetN.xml.
# These are stable across recent versions of the workbook; check workbook.xml
# if a future file reorders sheets.
SHEET = {
    'Revenue Model auto': 13,
    'Employees': 14,
    'HubSpot Pivot': 12,
    'Sales and Marketing': 17,
    'G&A': 18,
    'Engineering': 19,
    'Product Support': 20,
    'Capital Purchases': 22,
}

DATES = [f'{y:04d}-{m:02d}' for y in range(2026, 2032) for m in range(1, 13)]
TA_NAMES = ['Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5',
            'TA6', 'TA7', 'TA8', 'TA9', 'TA10', 'TA11', 'TA12']

# Excel serial → Y-M. Excel epoch is 1899-12-30, with the 1900 leap-year bug.
# 2026-01-01 = serial 46023.
EXCEL_2026_01 = 46023


def col_to_n(letters: str) -> int:
    n = 0
    for c in letters:
        n = n * 26 + (ord(c) - 64)
    return n


def n_to_col(n: int) -> str:
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def excel_serial_to_ym(serial: int | float) -> str:
    """Convert Excel date serial to YYYY-MM (1900 date system).

    Base = 1899-12-30 so that serial 46023 → 2026-01-01. This is correct for
    any date after 1900-02-28; the phantom 1900-02-29 makes Jan–Feb 1900
    dates off by one day, which doesn't matter for this workbook.
    """
    from datetime import date, timedelta
    return (date(1899, 12, 30) + timedelta(days=int(serial))).strftime('%Y-%m')


def load_shared_strings(z: zipfile.ZipFile) -> list[str]:
    with z.open('xl/sharedStrings.xml') as f:
        root = ET.parse(f).getroot()
    out = []
    for si in root:
        out.append(''.join(t.text or '' for t in si.iter(f'{NS}t')))
    return out


def load_sheet(z: zipfile.ZipFile, n: int, ss: list[str]) -> dict[str, object]:
    """Return {ref: value} for a worksheet. Numeric values are int|float, strings are str."""
    with z.open(f'xl/worksheets/sheet{n}.xml') as f:
        root = ET.parse(f).getroot()
    out: dict[str, object] = {}
    for row in root.iter(f'{NS}row'):
        for c in row.iter(f'{NS}c'):
            ref = c.get('r')
            t = c.get('t', 'n')
            v = c.find(f'{NS}v')
            val: object | None = None
            if t == 's' and v is not None and v.text is not None:
                val = ss[int(v.text)]
            elif t == 'inlineStr':
                te = c.find(f'.//{NS}t')
                val = te.text if te is not None else None
            elif v is not None and v.text is not None:
                try:
                    fv = float(v.text)
                    val = int(fv) if fv.is_integer() else fv
                except ValueError:
                    val = v.text
            if val is not None:
                out[ref] = val
    return out


def find_2026_01_col(cells: dict[str, object], row: int) -> int | None:
    """Find the column number in `row` whose value is the serial for 2026-01."""
    for col_n in range(1, 200):
        v = cells.get(f'{n_to_col(col_n)}{row}')
        if isinstance(v, (int, float)) and EXCEL_2026_01 - 2 <= v <= EXCEL_2026_01 + 2:
            return col_n
    return None


def row_to_arr(cells: dict[str, object], row: int, start_col: int, n: int) -> list[float]:
    out = []
    for i in range(n):
        v = cells.get(f'{n_to_col(start_col + i)}{row}')
        out.append(float(v) if isinstance(v, (int, float)) else 0.0)
    return out


# ------- Revenue Model auto ----------

def extract_revenue(z, ss):
    c = load_sheet(z, SHEET['Revenue Model auto'], ss)

    # Pricing (rows 62-66, cols B=Type A, C=Type B, D=Type C)
    pricing = {
        'A': {
            'sites': int(c['B62']),
            'bitfountLicense': int(c['B63']),
            'aiLicense': int(c['B65']),
            'projectFee': int(c['B64']),
            'pmFee': int(c['B66']),
        },
        'B': {
            'sites': int(c['C62']),
            'bitfountLicense': int(c['C63']),
            'aiLicense': int(c['C65']),
            'projectFee': int(c['C64']),
            'pmFee': int(c['C66']),
        },
        'C': {
            'sites': int(c['D62']),
            'bitfountLicense': int(c['D63']),
            'aiLicense': int(c['D65']),
            'projectFee': int(c['D64']),
            'pmFee': int(c['D66']),
        },
    }

    # Schedule: per-TA, per-Type, monthly. Each TA block has a "Metric" header
    # then offset +1 = Type A starts, +3 = Type B starts, +5 = Type C starts.
    # Date row (with 2026-01 serial) is the metric header row.
    schedule: dict[str, dict[str, list[float]]] = {}
    expected_totals: dict[str, dict[str, float]] = {}

    # Find each TA's metric row by walking col A
    ta_to_metric_row: dict[str, int] = {}
    for row in range(60, 300):
        a = c.get(f'A{row}')
        if not isinstance(a, str):
            continue
        # row labels: "<TA> – Type A client starts per month"
        m = re.match(r'^(.+?)\s*[–-]\s*Type A client starts per month', a)
        if m:
            ta_name = m.group(1).strip()
            # Locate the "Metric" header row above it
            for hr in range(row - 1, row - 5, -1):
                if c.get(f'A{hr}') == 'Metric':
                    ta_to_metric_row[ta_name] = hr
                    break

    # Map xlsx TA labels to canonical names
    alias = {'Ophthalmology': 'Ophthalmology', 'Opthamology': 'Ophthalmology'}
    for ta in ['TA2', 'TA3', 'TA4', 'TA5', 'TA6', 'TA7', 'TA8', 'TA9', 'TA10', 'TA11', 'TA12']:
        alias[ta] = ta

    for ta, metric_row in ta_to_metric_row.items():
        canon = alias.get(ta, ta)
        start_col = find_2026_01_col(c, metric_row)
        if start_col is None:
            raise RuntimeError(f'Could not find 2026-01 col for {ta} at row {metric_row}')
        schedule[canon] = {
            'A': [int(v) for v in row_to_arr(c, metric_row + 1, start_col, 72)],
            'B': [int(v) for v in row_to_arr(c, metric_row + 3, start_col, 72)],
            'C': [int(v) for v in row_to_arr(c, metric_row + 5, start_col, 72)],
        }
        # Expected totals: sum the per-month "Platform Revenue (earned)", "Project Revenue (earned)",
        # "Project Management Fee (earned)" rows. These appear 8-10 rows below metric_row for
        # Ophthalmology (R80/81/82 with metric R72; offset +8/+9/+10), and 8-9-10 for others (eg TA2 R99/100/101 with metric R91; offset +8/+9/+10).
        # Search by label.
        plat_row = proj_row = pm_row = None
        for r in range(metric_row + 1, metric_row + 25):
            a = c.get(f'A{r}')
            if isinstance(a, str):
                if '–' in a and 'Platform Revenue (earned)' in a:
                    plat_row = r
                elif '–' in a and 'Project Revenue (earned)' in a:
                    proj_row = r
                elif '–' in a and ('Project Management Fee' in a) and ('earned' in a or 'Revenue' in a):
                    pm_row = r
        plat = sum(row_to_arr(c, plat_row, start_col, 72)) if plat_row else 0.0
        proj = sum(row_to_arr(c, proj_row, start_col, 72)) if proj_row else 0.0
        pm = sum(row_to_arr(c, pm_row, start_col, 72)) if pm_row else 0.0
        expected_totals[canon] = {
            'platform': round(plat, 2),
            'project': round(proj, 2),
            'pm': round(pm, 2),
            'total': round(plat + proj + pm, 2),
        }

    # Make sure every TA in TA_NAMES has a schedule entry (empty if missing)
    for ta in TA_NAMES:
        if ta not in schedule:
            schedule[ta] = {'A': [0] * 72, 'B': [0] * 72, 'C': [0] * 72}
            expected_totals[ta] = {'platform': 0, 'project': 0, 'pm': 0, 'total': 0}

    return {
        'dates': list(DATES),
        'schedule': schedule,
        'pricing': pricing,
        'expected_totals': expected_totals,
    }


# ------- Employees ----------

# Rows in the v4 Employees sheet whose monthly cost feeds the S&M sales-commission
# salary cap (`Total Sales Salary × 1.5`). v4 hardcodes SUM(L11:L19) — the first
# nine S&M slots: Sales Director, Sales Manager, Marketing, two Enterprise Sales,
# two Therapeutic, plus two placeholders. Other S&M roles (Sales manager at row
# 21, Sales Ops, Product Marketeer, Comms) are *excluded* from the cap.
SALES_CAP_ROWS = set(range(11, 20))


def extract_employees(z, ss):
    c = load_sheet(z, SHEET['Employees'], ss)

    ni_rate = float(c.get('H1', 0))
    pension_rate = float(c.get('H2', 0))

    # Determine the month range of populated date columns — used to detect end
    # dates by scanning each employee row's per-month cost cells.
    # Header row 7 has Excel-date serials starting at col I (Oct 2025) and
    # running through to col CE (Dec 2031). Build {col_letter → YYYY-MM}.
    col_to_ym: dict[str, str] = {}
    for col_n in range(9, 100):  # I..CV — covers full Oct 2025 → Dec 2031 range
        col = n_to_col(col_n)
        v = c.get(f'{col}7')
        if isinstance(v, (int, float)):
            col_to_ym[col] = excel_serial_to_ym(v)
    sorted_cols = sorted(col_to_ym.keys(), key=col_to_n)

    employees = []
    for row in range(8, 200):
        first = c.get(f'A{row}')
        last = c.get(f'B{row}')
        position = c.get(f'C{row}')
        start = c.get(f'D{row}')
        dept = c.get(f'E{row}')
        loc = c.get(f'F{row}')
        salary = c.get(f'G{row}')

        # Skip rows with no salary (placeholders, empty rows)
        if not isinstance(salary, (int, float)) or salary == 0:
            continue
        if not dept:
            continue

        if start == 'Current':
            sd = 'Current'
        elif isinstance(start, (int, float)):
            sd = excel_serial_to_ym(start)
        else:
            sd = ''

        # End date: the last month for which the employee has a non-zero cost.
        # If the last populated cell is in or after Dec 2031 (end of horizon),
        # treat as "no end date" (employee runs the full forecast).
        last_active_col = None
        for col in sorted_cols:
            cv = c.get(f'{col}{row}')
            if isinstance(cv, (int, float)) and cv != 0:
                last_active_col = col
        end_date: str | None = None
        if last_active_col is not None:
            last_ym = col_to_ym[last_active_col]
            # Only emit endDate when the employee stops *before* the forecast
            # horizon ends. The last in-range column is BZ ≈ 2031-12 — anyone
            # whose last-active month is 2031-12 or later runs to horizon end.
            if last_ym < '2031-12':
                end_date = last_ym

        employees.append({
            'firstName': str(first) if first else '',
            'surname': str(last) if last else '',
            'position': str(position) if position else '',
            'department': str(dept),
            'location': str(loc) if loc else '',
            'startDate': sd,
            'endDate': end_date,
            'salary': salary,
            'salesCapEligible': row in SALES_CAP_ROWS,
        })

    return {
        'employees': employees,
        'assumptions': {
            'niRate': ni_rate,
            'pensionRate': pension_rate,
            'annualInflationRate': 0.05,  # constant in original file
            'inflationStartYear': 2027,
            'inflationStartMonth': 4,
            # v4 has two formula bugs in the Employees tab. Defaults below
            # reproduce those exactly so totals match v4; "fix" them by editing
            # the Employees assumptions in the UI.
            'maxInflationSteps': 4,        # v4 skips the Apr 2031 step
            'inflateFutureHires': False,   # v4 leaves future-start hires flat
        },
    }


# ------- HubSpot Pivot ----------

def extract_hubspot(z, ss):
    c = load_sheet(z, SHEET['HubSpot Pivot'], ss)

    # Row 1 has month headers; values start at col B and proceed for 72 months.
    # Col A is the line-item label. Data rows from row 2 until "Grand Total".
    line_items: dict[str, list[float]] = {}
    grand_total: list[float] = []

    for row in range(2, 30):
        label = c.get(f'A{row}')
        if not isinstance(label, str) or not label.strip():
            continue
        if label == 'Grand Total':
            grand_total = row_to_arr(c, row, 2, 72)
            break
        arr = row_to_arr(c, row, 2, 72)
        line_items[label] = arr

    # If we didn't find a Grand Total row, sum the line items.
    if not grand_total:
        grand_total = [sum(li[i] for li in line_items.values()) for i in range(72)]

    return {
        'lineItems': line_items,
        'grandTotal': grand_total,
    }


# ------- Costs ----------

# Mapping cost sheet → list of (json_label, xlsx_label).
# Labels are stable across versions; values come from col C row labels.
# Order matters — matches the order in existing costs_data.json.
COST_LINE_ITEMS = {
    'Sales and Marketing': [
        'Commission', 'US staff on-costs', 'Events', 'Comms', 'Web site',
        'Advertising', 'Consultants', 'Sales literature', 'Entertainment ',
        'Travel - National', 'Travel - International',
    ],
    'G&A': [
        'Bonus', 'Staff Welfare', 'Recruitment', 'Insurance', 'Rent',
        'Building costs', 'Cleaning', 'Telephone & Internet', 'IT costs',
        'Printing and stationery', 'Postage, freight and courier services',
        'Accounting and Audit', 'Professional Fees', 'Legal Fees', 'Consultants',
        'Subscriptions', 'Training', 'Travel', 'Entertaining', 'Bank charges',
        'Management Expenses',
    ],
    'Engineering': [
        'Bonus', 'Contractors', 'Consumables', 'Travel', 'Approvals',
        'Validation Data', 'Expenses and Consumables', 'IT Software and Consumables',
    ],
    'Product Support': [
        'Bonus', 'Travel', 'Technical services', 'IT Security',
    ],
}


def extract_cost_sheet(z, ss, sheet_name: str, labels: list[str]) -> dict[str, list[float]]:
    n = SHEET[sheet_name]
    c = load_sheet(z, n, ss)
    # Find a header row whose col D|G has a serial near 2026-01
    # The cost sheets put dates in row 5 typically; scan rows 1-20 for a row whose
    # earliest serial is close to 2026-01.
    start_col = None
    header_row = None
    for hr in range(1, 25):
        col = find_2026_01_col(c, hr)
        if col is not None:
            start_col = col
            header_row = hr
            break
    if start_col is None:
        raise RuntimeError(f'Could not locate 2026-01 in {sheet_name}')

    # Find each label by scanning col C from header_row onwards
    label_row: dict[str, int] = {}
    for row in range(header_row, header_row + 60):
        cval = c.get(f'C{row}')
        if isinstance(cval, str):
            for lbl in labels:
                if cval.strip() == lbl.strip() and lbl not in label_row:
                    label_row[lbl] = row

    missing = [l for l in labels if l not in label_row]
    if missing:
        raise RuntimeError(f'{sheet_name}: could not locate rows for {missing}')

    out = {}
    for lbl in labels:
        out[lbl] = row_to_arr(c, label_row[lbl], start_col, 72)
    return out


def extract_depreciation(z, ss) -> list[float]:
    """Total amortisation per month from Capital Purchases sheet (row 155 in current file)."""
    c = load_sheet(z, SHEET['Capital Purchases'], ss)
    # Look for the "Amortisation schedule" header row, then find the row whose
    # cells span from "Opening Asset Register" + many Computer rows. The TOTAL
    # row appears once at the bottom of the amortisation block with no col A label
    # but populated date cells.
    # In the current file: header at row 86 (dates), totals at row 155.
    amort_header = None
    for row in range(80, 200):
        if c.get(f'A{row}') == 'Item' and c.get(f'B{row}') == 'Cost':
            amort_header = row
            break
    if amort_header is None:
        raise RuntimeError('Could not find Amortisation schedule header')
    start_col = find_2026_01_col(c, amort_header)
    if start_col is None:
        raise RuntimeError('Could not find 2026-01 col in Capital Purchases')

    # Sum every row from amort_header+1 down until we hit an empty stretch
    # but exclude rows that themselves have a Total label or that already
    # appear to be totals.
    # Simpler: find the LAST row in the sheet that has a value in start_col
    # and treat it as the total row.
    last_row = None
    for row in range(amort_header + 1, amort_header + 300):
        v = c.get(f'{n_to_col(start_col)}{row}')
        if isinstance(v, (int, float)) and v != 0:
            last_row = row
    # The total row in current files has only date-col values and no label —
    # so prefer the last row that has values in date cols but no col A label.
    total_row = None
    for row in range(amort_header + 1, amort_header + 300):
        a = c.get(f'A{row}')
        v = c.get(f'{n_to_col(start_col)}{row}')
        if (a is None or a == '') and isinstance(v, (int, float)) and v != 0:
            total_row = row
    if total_row is None:
        total_row = last_row
    raw = row_to_arr(c, total_row, start_col, 72)

    # v4 hand-overrides Jan/Feb/Mar 2026 in the Budgets sheet (row 23, "Computer")
    # rather than pulling Capital Purchases via formula for those months. Jan
    # has a hardcoded formula `-256 * 1.32` (≈$337.92), Feb/Mar are empty cells.
    # The Apr 2026 onward cells *do* pull from Capital Purchases — so we trust
    # the Capital Purchases values from Apr 2026 (index 3) onwards and patch
    # the first three months to match v4's actual budgeted depreciation.
    raw[0] = 256 * 1.32  # Jan 2026
    raw[1] = 0.0         # Feb 2026
    raw[2] = 0.0         # Mar 2026
    return raw


def extract_costs(z, ss):
    line_items = {}
    for sheet, labels in COST_LINE_ITEMS.items():
        line_items[sheet] = extract_cost_sheet(z, ss, sheet, labels)

    depreciation = extract_depreciation(z, ss)

    # Existing JSON also carries:
    #   - costOfSales.modellerCommission  (derived in current data; we keep it from old JSON if present)
    #   - salesCommissionAdjustments      (likewise)
    # These are computed in src/model.ts at evaluation time, but the JSON preserves a
    # cached copy. We re-emit them as zeros — downstream code recomputes regardless.
    return {
        'lineItems': line_items,
        'deptToTab': {
            'S&M': 'Sales and Marketing',
            'G&A': 'G&A',
            'Engineering': 'Engineering',
            'Product Support': 'Product Support',
        },
        'costOfSales': {
            'modellerCommission': [0.0] * 72,
            'depreciation': depreciation,
        },
        'salesCommissionAdjustments': [0.0] * 72,
    }


# ------- Diff helper ----------

def diff_arrays(a: list[float], b: list[float], label: str, eps: float = 0.005) -> list[str]:
    out = []
    if len(a) != len(b):
        out.append(f'  {label}: length differs old={len(a)} new={len(b)}')
        return out
    for i in range(len(a)):
        av = a[i] or 0
        bv = b[i] or 0
        if abs(av - bv) > eps:
            out.append(f'  {label}[{i}] {DATES[i] if i < len(DATES) else i}: old={av} new={bv} Δ={bv-av:+.2f}')
    return out


def summarise_diff(old: object, new: object, prefix: str = '') -> list[str]:
    out = []
    if isinstance(old, dict) and isinstance(new, dict):
        old_keys = set(old.keys()); new_keys = set(new.keys())
        for k in sorted(old_keys - new_keys):
            out.append(f'  {prefix}{k}: REMOVED')
        for k in sorted(new_keys - old_keys):
            out.append(f'  {prefix}{k}: ADDED')
        for k in sorted(old_keys & new_keys):
            out.extend(summarise_diff(old[k], new[k], prefix + k + '.'))
    elif isinstance(old, list) and isinstance(new, list):
        if all(isinstance(x, (int, float)) for x in old + new):
            d = diff_arrays(old, new, prefix.rstrip('.'))
            if d:
                out.append(f'  {prefix.rstrip(".")}: {len(d)} cells differ; first 3:')
                out.extend(d[:3])
        elif len(old) != len(new):
            out.append(f'  {prefix.rstrip(".")}: length old={len(old)} new={len(new)}')
        else:
            for i, (o, n) in enumerate(zip(old, new)):
                out.extend(summarise_diff(o, n, f'{prefix}[{i}].'))
    elif isinstance(old, (int, float)) and isinstance(new, (int, float)):
        if abs(float(old) - float(new)) > 0.005:
            out.append(f'  {prefix.rstrip(".")}: old={old} new={new}')
    elif old != new:
        out.append(f'  {prefix.rstrip(".")}: old={old!r} new={new!r}')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx', help='Path to source xlsx file')
    ap.add_argument('--out', default='src', help='Output directory for JSON files')
    ap.add_argument('--write', action='store_true', help='Write JSON; otherwise just diff')
    args = ap.parse_args()

    out_dir = Path(args.out)
    z = zipfile.ZipFile(args.xlsx)
    ss = load_shared_strings(z)

    extracted = {
        'sales_data.json': extract_revenue(z, ss),
        'employees_data.json': extract_employees(z, ss),
        'hubspot_data.json': extract_hubspot(z, ss),
        'costs_data.json': extract_costs(z, ss),
    }

    for fname, new_data in extracted.items():
        existing = out_dir / fname
        if existing.exists():
            old = json.loads(existing.read_text())
            print(f'\n=== {fname} ===')
            diff = summarise_diff(old, new_data)
            if not diff:
                print('  (no diff)')
            else:
                for line in diff[:50]:
                    print(line)
                if len(diff) > 50:
                    print(f'  ... and {len(diff) - 50} more diff lines')
        if args.write:
            existing.write_text(json.dumps(new_data, indent=2) + '\n')
            print(f'  → wrote {existing}')


if __name__ == '__main__':
    main()
