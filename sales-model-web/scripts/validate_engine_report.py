"""Validate engine-rendered xlsx values against the engine eval result.

Looks up cells by row label + month index rather than hardcoded addresses,
so the script survives report layout changes.

Usage:
    python3 scripts/validate_engine_report.py [path-to-xlsx]
"""

import subprocess
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import formulas

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def get_eval_result():
    """Run a tsx script that dumps the eval result as JSON."""
    script = Path(__file__).parent / 'dump_engine_eval.mts'
    if not script.exists():
        script.write_text(
            "import { loadInitialInput } from '../src/data.js';\n"
            "import { evaluateSalesModel } from '../src/models/evaluateSalesModel.js';\n"
            "const r = evaluateSalesModel(loadInitialInput());\n"
            "const out: Record<string, unknown[]> = {};\n"
            "for (const [k, t] of Object.entries(r.tables)) {\n"
            "  out[k] = t.rows;\n"
            "}\n"
            "process.stdout.write(JSON.stringify(out));\n"
        )
    result = subprocess.run(
        ['npx', 'tsx', str(script)],
        cwd=Path(__file__).parent.parent,
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def col_letter(n):
    """1-indexed column number → Excel letter."""
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def find_row_by_label(xlsx_path, sheet_name, label):
    """Find the first row whose col A text equals `label`. Returns 1-based row, or None."""
    z = zipfile.ZipFile(xlsx_path)
    with z.open('xl/workbook.xml') as f:
        wb = ET.parse(f).getroot()
    with z.open('xl/sharedStrings.xml') as f:
        ss = [''.join(t.text or '' for t in si.iter(f'{NS}t')) for si in ET.parse(f).getroot()]
    sheets = wb.find(f'{NS}sheets')
    NSR = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
    rid_to_n = {}
    for i, s in enumerate(sheets, 1):
        rid_to_n[s.get('name')] = i
    sn = rid_to_n.get(sheet_name)
    if sn is None: return None
    with z.open(f'xl/worksheets/sheet{sn}.xml') as f:
        root = ET.parse(f).getroot()
    for row in root.iter(f'{NS}row'):
        for c in row.iter(f'{NS}c'):
            if c.get('r').startswith('A') and c.get('t') == 's':
                v = c.find(f'{NS}v')
                if v is not None and ss[int(v.text)] == label:
                    return int(row.get('r'))
            break  # only check col A
    return None


def main():
    xlsx_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/engine-report-final.xlsx'

    print(f'Loading + evaluating {xlsx_path} …')
    xl_model = formulas.ExcelModel().loads(xlsx_path).finish()
    sol = xl_model.calculate()

    print('Running engine eval result via tsx …')
    eval_tables = get_eval_result()
    name = Path(xlsx_path).name

    def xl_value(sheet, addr):
        full = f"'[{name}]{sheet.upper()}'!{addr}"
        v = sol.get(full)
        if v is None:
            return None
        try: return float(v.value[0][0])
        except Exception:
            try: return float(v)
            except Exception: return None

    def engine_value(table, identity, col):
        rows = eval_tables.get(table, [])
        for r in rows:
            if all(r.get(k) == identity[k] for k in identity):
                v = r.get(col)
                return float(v) if v is not None else 0.0
        return 0.0

    # Each check looks up the row by label, then reads cell at month column.
    checks = [
        # (description, sheet, row_label, month_idx, engine table/identity/col)
        ('Ophthalmology revenue Jan 27', 'Revenue Model', 'Ophthalmology', 12,
         'ta_monthly_total', {'ta': 'Ophthalmology', 'month_idx': 12}, 'total'),
        ('TA2 revenue m=29', 'Revenue Model', 'TA2', 29,
         'ta_monthly_total', {'ta': 'TA2', 'month_idx': 29}, 'total'),
        ('Modeled subtotal m=12', 'Revenue Model', 'Modeled TAs (subtotal)', 12,
         'modeled_total_monthly', {'month_idx': 12}, 'total'),
        ('HubSpot subtotal Jan 26', 'Revenue Model', 'HubSpot pipeline (subtotal)', 0,
         'hubspot_total_monthly', {'month_idx': 0}, 'hubspot'),
        ('Grand total m=29 (in Rev Model)', 'Revenue Model', 'Grand total (HubSpot + modeled)', 29,
         'revenue_monthly', {'month_idx': 29}, 'revenue'),
        ('Total client starts m=12', 'Revenue Model', 'Total client starts', 12,
         'starts_per_month', {'month_idx': 12}, 'total_starts'),
        ('Total modeller commission m=12', 'Revenue Model', 'Total modeller commission', 12,
         'modeller_commission_monthly', {'month_idx': 12}, 'modeller_commission'),
        ('Revenue Grand Total Jan 26', 'Total Revenue', 'Grand total (HubSpot + modeled)', 0,
         'revenue_monthly', {'month_idx': 0}, 'revenue'),
        ('Revenue Grand Total m=29', 'Total Revenue', 'Grand total (HubSpot + modeled)', 29,
         'revenue_monthly', {'month_idx': 29}, 'revenue'),
        ('EBITDA m=29', 'Budget P&L', 'EBITDA', 29,
         'budget_monthly', {'month_idx': 29}, 'ebitda'),
        ('Total opex m=29', 'Budget P&L', 'Total opex', 29,
         'total_opex_monthly', {'month_idx': 29}, 'total_opex'),
    ]

    failed = 0
    for label, sheet, row_label, month_idx, table, ident, col in checks:
        row = find_row_by_label(xlsx_path, sheet, row_label)
        if row is None:
            print(f'  [FAIL] {label:42}  row label not found: {row_label!r}')
            failed += 1
            continue
        addr = f'{col_letter(2 + month_idx)}{row}'
        xl = xl_value(sheet, addr)
        eng = engine_value(table, ident, col)
        ok = xl is not None and abs(float(xl) - eng) < 0.01
        status = 'OK' if ok else 'FAIL'
        print(f'  [{status}] {label:42}  {addr:>5}  xlsx={xl!r:>20}  engine={eng:>16.2f}')
        if not ok: failed += 1

    if failed:
        print(f'\n{failed}/{len(checks)} failed')
        sys.exit(1)
    print(f'\nAll {len(checks)} checks passed.')


if __name__ == '__main__':
    main()
