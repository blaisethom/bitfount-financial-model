// Step-explorer preview for the v2 declarative engine. Demonstrates loading a
// `ModelDef`, evaluating it, and walking the resulting step trace forward/back
// with explanations. Run against `exampleModel` for now; once the existing
// model is re-expressed via the engine this view becomes the canonical UI.

import { useMemo, useState } from 'react';
import { evaluateModel, type ModelDef, type Table, type Step } from '../engine';

interface Props {
  model: ModelDef;
}

export default function EnginePreview({ model }: Props) {
  const result = useMemo(() => evaluateModel(model), [model]);
  const [stepIdx, setStepIdx] = useState(0);

  const totalSteps = result.trace.length;
  const current = result.trace[stepIdx];

  return (
    <>
      <section>
        <div className="ta-summary">
          <span className="ta-name">Model Engine — preview</span>
          <span className="ta-total">
            {Object.keys(model.sources).length} sources · {model.steps.length} steps · {model.outputs.length} outputs
          </span>
        </div>
        <p className="hint">
          v2 declarative engine. The model is a DAG of named tables; each step has an explanation and can be stepped
          through forward/back. This view runs the example model in <code>src/models/example.ts</code>; the next milestone
          is to re-express the existing sales/cost model in the same shape so the engine drives both the web UI and the
          Excel export.
        </p>
      </section>

      <section>
        <h2>Sources <span className="hint">(input tables)</span></h2>
        <div style={{ display: 'grid', gap: 12 }}>
          {Object.entries(model.sources).map(([name, src]) => (
            <div key={name} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{name}</strong>
                <span className="hint" style={{ margin: 0 }}>kind: {src.kind}</span>
              </div>
              {'description' in src && src.description && (
                <p className="hint" style={{ margin: '4px 0' }}>{src.description}</p>
              )}
              <TablePreview table={result.tables[name]} maxRows={5} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Step explorer</h2>
        {totalSteps === 0 ? (
          <p className="hint">No steps defined.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16 }}>
            <div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button className="btn" onClick={() => setStepIdx(Math.max(0, stepIdx - 1))} disabled={stepIdx === 0}>
                  ← Prev
                </button>
                <button
                  className="btn"
                  onClick={() => setStepIdx(Math.min(totalSteps - 1, stepIdx + 1))}
                  disabled={stepIdx === totalSteps - 1}
                >
                  Next →
                </button>
              </div>
              <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {result.trace.map(({ step }, i) => (
                  <li key={step.id}>
                    <button
                      onClick={() => setStepIdx(i)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        background: i === stepIdx ? 'var(--accent-light)' : '#fff',
                        color: i === stepIdx ? 'var(--accent)' : 'var(--text)',
                        marginBottom: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{i + 1}. {step.name}</div>
                      <div className="hint" style={{ margin: 0, fontSize: 11 }}>
                        {step.input} → {step.output}
                      </div>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
            <div>
              {current && <StepDetail step={current.step} input={result.tables[current.step.input]} output={current.output} />}
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Outputs <span className="hint">(declared for renderers)</span></h2>
        {model.outputs.map((o) => (
          <div key={o.ref} style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '8px 0 4px' }}>{o.label}</h3>
            {o.description && <p className="hint" style={{ margin: '0 0 6px' }}>{o.description}</p>}
            <TablePreview table={result.tables[o.ref]} maxRows={20} />
          </div>
        ))}
      </section>
    </>
  );
}

function StepDetail({ step, input, output }: { step: Step; input: Table; output: Table }) {
  return (
    <div>
      <h3 style={{ margin: '0 0 4px' }}>{step.name}</h3>
      <p style={{ margin: '0 0 8px', fontSize: 13 }}>{step.description}</p>

      <div className="hint" style={{ margin: '12px 0 4px', fontWeight: 600 }}>Operation</div>
      <pre style={{
        margin: 0, padding: 10, background: '#f5f5f5', borderRadius: 4,
        fontSize: 11, overflow: 'auto', maxHeight: 180,
      }}>{JSON.stringify(step.op, null, 2)}</pre>

      <div className="hint" style={{ margin: '12px 0 4px', fontWeight: 600 }}>Input ({step.input})</div>
      <TablePreview table={input} maxRows={6} />

      <div className="hint" style={{ margin: '12px 0 4px', fontWeight: 600 }}>Output ({step.output})</div>
      <TablePreview table={output} maxRows={20} />
    </div>
  );
}

function TablePreview({ table, maxRows = 10 }: { table: Table; maxRows?: number }) {
  if (!table) return <span className="hint">(table not yet materialized)</span>;
  const cols = table.schema.columns;
  const shown = table.rows.slice(0, maxRows);
  const more = table.rows.length - shown.length;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="yearly-emp-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.name} title={`${c.type}${c.description ? ' — ' + c.description : ''}`}>
                {c.name} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>{c.type[0]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.name} style={{ textAlign: c.type === 'number' ? 'right' : 'left' }}>
                  {formatCell(row[c.name], c.type)}
                </td>
              ))}
            </tr>
          ))}
          {more > 0 && (
            <tr>
              <td colSpan={cols.length} style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
                … {more} more rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown, type: string): string {
  if (v == null) return '';
  if (type === 'number' && typeof v === 'number') return Math.round(v).toLocaleString();
  return String(v);
}
