import { useEffect, useRef, useState } from 'react';
import type { Scenario } from '../scenarios';
import { overrideCount, overrideSummary } from '../scenarios';

interface ScenarioBarProps {
  scenarios: Scenario[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onResetActive: () => void;
}

export default function ScenarioBar({
  scenarios,
  activeId,
  onSwitch,
  onNew,
  onRename,
  onDelete,
  onResetActive,
}: ScenarioBarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = scenarios.find((s) => s.id === activeId) ?? scenarios[0];
  const activeOverrides = overrideSummary(active);

  useEffect(() => {
    if (editingId) inputRef.current?.select();
  }, [editingId]);

  const startRename = (s: Scenario) => {
    setEditingId(s.id);
    setDraftName(s.name);
  };
  const commitRename = () => {
    if (editingId && draftName.trim()) onRename(editingId, draftName.trim());
    setEditingId(null);
  };

  return (
    <div className="scenario-bar">
      <span className="scenario-label">Scenarios</span>

      <div className="scenario-chips" role="tablist" aria-label="Scenarios">
        {scenarios.map((s) => {
          const n = overrideCount(s);
          const isActive = s.id === activeId;
          return editingId === s.id ? (
            <input
              key={s.id}
              ref={inputRef}
              className="scenario-rename"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setEditingId(null);
              }}
            />
          ) : (
            <button
              key={s.id}
              role="tab"
              aria-selected={isActive}
              className={`scenario-chip ${isActive ? 'active' : ''}`}
              onClick={() => onSwitch(s.id)}
              onDoubleClick={() => startRename(s)}
              title={`${s.name}${n ? ` — ${n} override${n === 1 ? '' : 's'} vs base` : ' — no overrides'} (double-click to rename)`}
            >
              <span className="scenario-chip-name">{s.name}</span>
              {n > 0 && <span className="scenario-badge">{n}</span>}
            </button>
          );
        })}

        <button className="btn scenario-new" onClick={onNew} title="Duplicate the active scenario into a new one">
          + New
        </button>
      </div>

      <div className="scenario-actions">
        <button
          className="scenario-link"
          onClick={() => setShowDiff((v) => !v)}
          aria-expanded={showDiff}
        >
          {activeOverrides.length} override{activeOverrides.length === 1 ? '' : 's'} {showDiff ? '▲' : '▼'}
        </button>
        <button
          className="scenario-link"
          onClick={() => startRename(active)}
          title="Rename the active scenario"
        >
          Rename
        </button>
        <button
          className="scenario-link"
          onClick={onResetActive}
          disabled={activeOverrides.length === 0}
          title="Clear this scenario's overrides (revert to base assumptions)"
        >
          Reset
        </button>
        <button
          className="scenario-link danger"
          onClick={() => onDelete(active.id)}
          disabled={scenarios.length <= 1}
          title="Delete the active scenario"
        >
          Delete
        </button>
      </div>

      {showDiff && (
        <div className="scenario-diff">
          {activeOverrides.length === 0 ? (
            <span className="scenario-diff-empty">
              No overrides — “{active.name}” matches the base assumptions. Edit any assumption to start diverging.
            </span>
          ) : (
            <>
              <span className="scenario-diff-title">“{active.name}” changes vs base:</span>
              <ul className="scenario-diff-list">
                {activeOverrides.map((o) => (
                  <li key={o.key}>{o.label}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
