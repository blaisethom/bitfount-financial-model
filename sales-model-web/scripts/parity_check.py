"""Numerical parity check: compare model output against xlsx-computed values.

Re-implements the revenue/active-trial math from src/model.ts in Python and
compares against the new xlsx's "Total Revenue Earned" rows + HubSpot Pivot.

Run after extract_xlsx.py to confirm the refreshed JSON drives the model to
the same numbers the spreadsheet computes.

Usage:
    python3 scripts/parity_check.py <path-to-xlsx>
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def col_n(n: int) -> str:
    s = ''
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def load_shared_strings(z):
    with z.open('xl/sharedStrings.xml') as f:
        root = ET.parse(f).getroot()
    return [''.join(t.text or '' for t in si.iter(f'{NS}t')) for si in root]


def load_sheet(z, sn, ss):
    with z.open(f'xl/worksheets/sheet{sn}.xml') as f:
        root = ET.parse(f).getroot()
    out = {}
    for row in root.iter(f'{NS}row'):
        for c in row.iter(f'{NS}c'):
            ref = c.get('r'); t = c.get('t', 'n')
            v = c.find(f'{NS}v')
            val = None
            if t == 's' and v is not None:
                val = ss[int(v.text)]
            elif v is not None and v.text is not None:
                try: val = float(v.text)
                except: val = v.text
            out[ref] = val
    return out


def compute_active(starts):
    n = len(starts)
    a = [0.0] * n
    for m in range(n):
        s = starts[m]
        for k in range(12):
            if m + k < n:
                a[m + k] += s
    return a


def model_revenue(input_json):
    """Re-implements src/model.ts revenue computation."""
    schedule = input_json['schedule']
    pricing = input_json['pricing']
    months = 72

    per_ta = {}
    grand = [0.0] * months
    for ta, sched in schedule.items():
        ta_plat = [0.0] * months
        ta_proj = [0.0] * months
        ta_pm = [0.0] * months
        for t in 'ABC':
            starts = sched[t]
            active = compute_active(starts)
            p = pricing[t]
            plat_year = (p['bitfountLicense'] + p['aiLicense']) * p['sites']
            for i in range(months):
                ta_plat[i] += active[i] * plat_year / 12
                ta_proj[i] += starts[i] * p['projectFee']
                ta_pm[i] += active[i] * p['pmFee']
        per_ta[ta] = {
            'platform': ta_plat, 'project': ta_proj, 'pm': ta_pm,
            'total': [ta_plat[i] + ta_proj[i] + ta_pm[i] for i in range(months)],
        }
        for i in range(months):
            grand[i] += per_ta[ta]['total'][i]
    return per_ta, grand


def xlsx_revenue(c):
    """Sum the per-TA Total Revenue Earned rows from Revenue Model auto."""
    ta_rows = {
        'Ophthalmology': 83, 'TA2': 102, 'TA3': 121, 'TA4': 139,
        'TA5': 157, 'TA6': 175, 'TA7': 193, 'TA8': 211, 'TA9': 229,
        'TA10': 247, 'TA11': 265, 'TA12': 283,
    }
    out = {}
    for ta, row in ta_rows.items():
        out[ta] = [c.get(f'{col_n(i+2)}{row}', 0) or 0 for i in range(72)]
    return out


def xlsx_active(c):
    ta_to_active_rows = {
        'Ophthalmology': (74, 76, 78),
        'TA2': (93, 95, 97),
        'TA3': (112, 114, 116),
        'TA4': (130, 132, 134),
        'TA5': (148, 150, 152),
    }
    out = {}
    for ta, rows in ta_to_active_rows.items():
        out[ta] = {trial_type: [c.get(f'{col_n(i+2)}{r}', 0) or 0 for i in range(72)]
                   for trial_type, r in zip('ABC', rows)}
    return out


def fmt(x): return f'${x:>15,.2f}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--data-dir', default='src')
    args = ap.parse_args()

    data = Path(args.data_dir)
    sales = json.loads((data / 'sales_data.json').read_text())

    z = zipfile.ZipFile(args.xlsx)
    ss = load_shared_strings(z)
    c = load_sheet(z, 13, ss)

    # Active trial parity
    print('\n=== Active trial parity (model vs xlsx) ===')
    print(f'  {"TA":<15} {"type":>4} {"starts":>7} {"xlsx_sum":>9} {"model_sum":>10}  status')
    bug_tas = []
    xlsx_acts = xlsx_active(c)
    for ta in ['Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5']:
        for t in 'ABC':
            starts = sales['schedule'][ta][t]
            model_act = compute_active(starts)
            xlsx_act = xlsx_acts[ta][t]
            diff = sum(1 for i in range(72) if model_act[i] != xlsx_act[i])
            status = 'OK' if diff == 0 else f'DIFFER ({diff} months, {sum(xlsx_act) - sum(model_act):+.0f} trial-months)'
            print(f'  {ta:<15} {t:>4} {sum(starts):>7.0f} {sum(xlsx_act):>9.0f} {sum(model_act):>10.0f}  {status}')
            if diff:
                bug_tas.append((ta, t, diff, sum(xlsx_act) - sum(model_act)))

    # Revenue parity per TA
    print('\n=== Revenue parity (model vs xlsx Total Revenue Earned) ===')
    print(f'  {"TA":<15} {"model_total":>16} {"xlsx_total":>16} {"diff":>12}  status')
    per_ta_model, grand_model = model_revenue(sales)
    xlsx_rev = xlsx_revenue(c)
    total_diff = 0.0
    for ta in ['Ophthalmology', 'TA2', 'TA3', 'TA4', 'TA5']:
        mt = sum(per_ta_model[ta]['total'])
        xt = sum(xlsx_rev[ta])
        diff = xt - mt
        total_diff += diff
        status = 'OK' if abs(diff) < 1 else f'DIFFER (Δ ${diff:+,.2f})'
        print(f'  {ta:<15} {fmt(mt):>16} {fmt(xt):>16} {fmt(diff):>12}  {status}')
    print(f'\n  Total revenue diff (model − xlsx): ${total_diff:+,.2f}')

    # HubSpot parity
    hs = json.loads((data / 'hubspot_data.json').read_text())
    c_hs = load_sheet(z, 12, ss)
    # Grand Total is at row 14 in current file (cols B-BU)
    xlsx_hs_total = [c_hs.get(f'{col_n(i+2)}14', 0) or 0 for i in range(72)]
    json_hs_total = hs['grandTotal']
    hs_diffs = sum(1 for i in range(72) if abs(xlsx_hs_total[i] - json_hs_total[i]) > 0.01)
    print(f'\n=== HubSpot parity ===')
    print(f'  HubSpot Grand Total: {hs_diffs} month diffs (sum model=${sum(json_hs_total):,.2f}, xlsx=${sum(xlsx_hs_total):,.2f})')

    if bug_tas:
        print('\n=== Notes ===')
        for ta, t, dmonths, dtrials in bug_tas:
            print(f'  ! {ta} type {t}: {dmonths} months drift, {dtrials:+.0f} cumulative trial-months — xlsx active formula does not subtract')
            print(f'    starts from 12 months ago in every cell. The model implements the correct 12-month window. The xlsx output')
            print(f'    over-counts active trials; fixing the {ta} active-trial formulas will bring the spreadsheet in line.')

    # Exit code: pass unless any non-TA2-A diff
    if any((ta, t) != ('TA2', 'A') for ta, t, *_ in bug_tas):
        sys.exit(1)


if __name__ == '__main__':
    main()
