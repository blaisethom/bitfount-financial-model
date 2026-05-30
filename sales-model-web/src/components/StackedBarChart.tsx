import type { QuarterlyPivot } from '../hubspot';

const COLORS = [
  '#2563eb', '#16a34a', '#dc2626', '#ea580c',
  '#9333ea', '#0891b2', '#ca8a04', '#be123c',
  '#0284c7', '#65a30d', '#9f1239', '#7c3aed',
];

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function formatShort(v: number): string {
  if (Math.abs(v) >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

interface Props {
  pivot: QuarterlyPivot;
  height?: number;
  barWidth?: number;
  barGap?: number;
}

export default function StackedBarChart({ pivot, height = 340, barWidth = 48, barGap = 16 }: Props) {
  const PAD = { top: 20, right: 20, bottom: 56, left: 72 };
  const innerH = height - PAD.top - PAD.bottom;
  const innerW = Math.max(pivot.quarters.length, 1) * (barWidth + barGap);
  const totalW = innerW + PAD.left + PAD.right;

  const maxTotal = pivot.quarters.reduce((m, q) => Math.max(m, pivot.rowTotals[q] || 0), 0);
  const axisMax = niceCeil(maxTotal);
  const y = (v: number) => PAD.top + innerH - (v / axisMax) * innerH;
  const ticks = 5;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => (axisMax / ticks) * i);

  const colorFor: Record<string, string> = {};
  pivot.types.forEach((t, i) => (colorFor[t] = COLORS[i % COLORS.length]));

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 8 }}>
        {pivot.types.map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 12, height: 12, background: colorFor[t], borderRadius: 2 }} />
            {t}
          </span>
        ))}
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6, background: '#fff' }}>
        <svg width={totalW} height={height} style={{ display: 'block' }}>
          {tickValues.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={totalW - PAD.right} y1={y(v)} y2={y(v)} stroke="#eef" />
              <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6b7280">
                {formatShort(v)}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={totalW - PAD.right} y1={y(0)} y2={y(0)} stroke="#9ca3af" />
          {pivot.quarters.map((q, i) => {
            const x = PAD.left + i * (barWidth + barGap);
            let yTop = y(0);
            const segs = pivot.types
              .map((t) => ({ t, v: pivot.data[q]?.[t] || 0 }))
              .filter((s) => s.v > 0);
            return (
              <g key={q}>
                {segs.map((s) => {
                  const h = y(0) - y(s.v);
                  yTop -= h;
                  return (
                    <rect key={s.t} x={x} y={yTop} width={barWidth} height={h} fill={colorFor[s.t]}>
                      <title>{`${q} · ${s.t}: ${formatShort(s.v)}`}</title>
                    </rect>
                  );
                })}
                <text
                  x={x + barWidth / 2}
                  y={y(pivot.rowTotals[q] || 0) - 4}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight={600}
                  fill="#111827"
                >
                  {formatShort(pivot.rowTotals[q] || 0)}
                </text>
                <text x={x + barWidth / 2} y={height - PAD.bottom + 16} textAnchor="middle" fontSize="11">
                  {q}
                </text>
              </g>
            );
          })}
          {pivot.quarters.length === 0 && (
            <text x={totalW / 2} y={height / 2} textAnchor="middle" fontSize="13" fill="#9ca3af">
              No data
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
