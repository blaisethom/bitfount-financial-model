import { useMemo } from 'react';
import type { EvalResult, ModelDef } from '../engine';

const COLORS = [
  '#2563eb', '#16a34a', '#dc2626', '#ea580c',
  '#9333ea', '#0891b2', '#ca8a04', '#be123c',
  '#0284c7', '#65a30d',
];

function fmtY(v: number): string {
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

function niceRange(min: number, max: number, ticks = 5): number[] {
  const range = max - min || 1;
  const raw = range / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

interface Props {
  ref_: string;
  evalResult: EvalResult;
  model: ModelDef;
  title?: string;
}

export default function EngineChart({ ref_, evalResult, model, title }: Props) {
  const table = evalResult.tables[ref_];
  const axis = model.defaultAxis ?? 'month_idx';

  const dateMap = useMemo(() => {
    const m = new Map<number, string>();
    const dt = evalResult.tables['dates_t'];
    if (dt) for (const r of dt.rows) m.set(Number(r.month_idx), String(r.date ?? ''));
    return m;
  }, [evalResult]);

  if (!table) {
    return (
      <div className="engine-pivot-table-wrap">
        <h3 className="engine-pivot-table-title">{title ?? ref_}</h3>
        <p className="hint">{ref_} — not yet materialised</p>
      </div>
    );
  }

  type Col = { name: string; type: string };
  const cols = table.schema.columns as Col[];
  const axisCol = cols.find(c => c.name === axis);
  if (!axisCol) {
    return (
      <div className="engine-pivot-table-wrap">
        <h3 className="engine-pivot-table-title">{title ?? ref_}</h3>
        <p className="hint">No {axis} axis found in {ref_}</p>
      </div>
    );
  }

  const numericCols = cols.filter(c => c.type === 'number' && c.name !== axis);
  const keyCols = cols.filter(c => c.type !== 'number' && c.name !== axis);

  // Build series: if there's a key col, group by it; else each numeric col is a series
  type Series = { label: string; points: Map<number, number> };
  const seriesMap = new Map<string, Series>();

  for (const row of table.rows) {
    const axisVal = Number(row[axis]);
    if (!Number.isFinite(axisVal)) continue;

    if (keyCols.length > 0 && numericCols.length >= 1) {
      // Group by key + use first numeric col
      const key = keyCols.map(c => String(row[c.name] ?? '')).join(' / ');
      const valueCol = numericCols[0];
      if (!seriesMap.has(key)) seriesMap.set(key, { label: key, points: new Map() });
      seriesMap.get(key)!.points.set(axisVal, Number(row[valueCol.name] ?? 0));
    } else {
      // Each numeric col is a series
      for (const vc of numericCols) {
        if (!seriesMap.has(vc.name)) seriesMap.set(vc.name, { label: vc.name, points: new Map() });
        seriesMap.get(vc.name)!.points.set(axisVal, Number(row[vc.name] ?? 0));
      }
    }
  }

  // Collect all axis values (sorted)
  const axisVals = [...new Set(table.rows.map(r => Number(r[axis])).filter(Number.isFinite))].sort((a, b) => a - b);
  if (axisVals.length === 0) return <div className="engine-pivot-table-wrap"><h3 className="engine-pivot-table-title">{title ?? ref_}</h3><p className="hint">No data</p></div>;

  // Sort series by total and cap at 10
  const allSeries = [...seriesMap.values()]
    .map(s => ({ ...s, total: [...s.points.values()].reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // Y range
  const allY = allSeries.flatMap(s => [...s.points.values()]);
  const yMin = Math.min(0, ...allY);
  const yMax = Math.max(1, ...allY);
  const yTicks = niceRange(yMin, yMax, 5);
  const yLo = yTicks[0], yHi = yTicks[yTicks.length - 1];

  const PAD = { top: 16, right: 20, bottom: 60, left: 70 };
  const W = 700, H = 280;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const xPos = (i: number) => PAD.left + (i / Math.max(axisVals.length - 1, 1)) * innerW;
  const yPos = (v: number) => PAD.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH;

  const colorFor = (i: number) => COLORS[i % COLORS.length];

  return (
    <div className="engine-pivot-table-wrap">
      <h3 className="engine-pivot-table-title">{title ?? ref_}</h3>
      {/* Legend */}
      {allSeries.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
          {allSeries.map((s, i) => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
              <span style={{ width: 18, height: 2, background: colorFor(i), display: 'inline-block', borderRadius: 1 }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: '#fff', padding: 4 }}>
        <svg width={W} height={H} style={{ display: 'block' }}>
          {/* Grid + Y axis */}
          {yTicks.map(v => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={yPos(v)} y2={yPos(v)} stroke="#f0f0f5" strokeWidth={1} />
              <text x={PAD.left - 6} y={yPos(v) + 4} textAnchor="end" fontSize={10} fill="#9ca3af">{fmtY(v)}</text>
            </g>
          ))}
          {/* Zero line */}
          {yLo < 0 && <line x1={PAD.left} x2={W - PAD.right} y1={yPos(0)} y2={yPos(0)} stroke="#9ca3af" strokeWidth={1} />}
          {/* X axis labels (every Nth tick to avoid crowding) */}
          {axisVals.map((av, i) => {
            const every = Math.max(1, Math.ceil(axisVals.length / 18));
            if (i % every !== 0) return null;
            const label = dateMap.get(av) ?? String(av);
            return (
              <text key={av} x={xPos(i)} y={H - PAD.bottom + 14} textAnchor="end"
                fontSize={9} fill="#9ca3af"
                transform={`rotate(-45, ${xPos(i)}, ${H - PAD.bottom + 14})`}>
                {label}
              </text>
            );
          })}
          {/* Lines */}
          {allSeries.map((s, si) => {
            const pts = axisVals.map((av, i) => `${xPos(i)},${yPos(s.points.get(av) ?? 0)}`).join(' ');
            return (
              <polyline key={s.label}
                points={pts}
                fill="none"
                stroke={colorFor(si)}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
