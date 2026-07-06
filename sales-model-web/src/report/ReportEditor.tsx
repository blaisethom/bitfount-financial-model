import { useRef, useState } from 'react';
import type { ReportSection } from './types';

// ─── Types mirroring the raw YAML shape ──────────────────────────────────────

type RawBlock = Record<string, unknown>;
type RawSection = {
  id?: string;
  label?: string;
  hint?: string;
  engine_ref?: string;
  blocks?: RawBlock[];
};
type RawReport = {
  sections?: RawSection[];
  [key: string]: unknown;
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface ReportEditorProps {
  rawReport: unknown;
  resolvedSections: ReportSection[];
  onSave: (data: unknown) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rowsKind(block: RawBlock): string {
  const rows = block.rows as Record<string, unknown> | undefined;
  if (!rows) return '—';
  return String(rows.kind ?? '—');
}

function blockAxis(block: RawBlock): string | undefined {
  if (!block.axis) return undefined;
  const ax = block.axis as Record<string, unknown>;
  return String(ax.col ?? '');
}

// ─── Small display pieces ─────────────────────────────────────────────────────

function Pill({ text, color = 'blue' }: { text: string; color?: 'blue' | 'gray' | 'green' | 'amber' }) {
  const cls: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    gray: 'bg-gray-100 text-gray-600 border-gray-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0 rounded border text-[10px] font-mono leading-[1.6] ${cls[color]}`}>
      {text}
    </span>
  );
}

// ─── Block display ────────────────────────────────────────────────────────────

function TableBlockDisplay({
  block,
  onEdit,
}: {
  block: RawBlock;
  onEdit: (updated: RawBlock) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftSource, setDraftSource] = useState(String(block.source ?? ''));
  const [draftId, setDraftId] = useState(String(block.id ?? ''));

  const source = String(block.source ?? '');
  const blockId = block.id != null ? String(block.id) : undefined;
  const kind = rowsKind(block);
  const axis = blockAxis(block);
  const canonical = block.canonical != null;

  const commitEdit = () => {
    const updated: RawBlock = { ...block, source: draftSource };
    if (draftId.trim()) {
      updated.id = draftId.trim();
    } else {
      delete updated.id;
    }
    onEdit(updated);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraftSource(String(block.source ?? ''));
    setDraftId(String(block.id ?? ''));
    setEditing(false);
  };

  return (
    <div className="border border-gray-200 rounded-md bg-white mb-1.5 shadow-sm border-l-[3px] border-l-cyan-600">
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded text-[11px] shrink-0 mt-0.5 bg-cyan-50 text-cyan-700">
          ⊞
        </span>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[12px] font-mono font-semibold text-gray-900">{source}</span>
          <div className="flex flex-wrap gap-1 items-center">
            {blockId && <Pill text={`#${blockId}`} color="gray" />}
            <Pill text={kind} color="blue" />
            {axis && <Pill text={`⟺ ${axis}`} color="amber" />}
            {canonical && <Pill text="✎ canonical" color="green" />}
          </div>
        </div>
        <button
          className="shrink-0 text-[11px] text-gray-400 bg-transparent border border-gray-200 rounded-[3px] px-1.5 py-0.5 cursor-pointer hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 mt-0.5"
          onClick={() => setEditing((v) => !v)}
          title="Edit block"
        >
          ✎
        </button>
      </div>
      {editing && (
        <div className="border-t border-gray-200 bg-gray-50 px-3 py-2 flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 min-w-14 shrink-0">source</span>
            <input
              className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white font-mono flex-1 min-w-[160px] focus:outline-none focus:border-blue-600"
              value={draftSource}
              onChange={(e) => setDraftSource(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 min-w-14 shrink-0">id</span>
            <input
              className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white font-mono flex-1 min-w-[160px] focus:outline-none focus:border-blue-600"
              value={draftId}
              placeholder="optional block id"
              onChange={(e) => setDraftId(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              className="text-xs bg-blue-600 text-white border border-blue-600 rounded px-2 py-0.5 cursor-pointer hover:bg-blue-700"
              onClick={commitEdit}
            >
              Save
            </button>
            <button
              className="text-xs bg-transparent text-gray-500 border border-gray-200 rounded px-2 py-0.5 cursor-pointer hover:bg-gray-100"
              onClick={cancelEdit}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BlockRow({ block, onEdit }: { block: RawBlock; onEdit: (updated: RawBlock) => void }) {
  const kind = String(block.kind ?? '');

  if (kind === 'title') {
    return (
      <div className="text-[11px] italic text-gray-400 py-0.5 px-1">
        {String(block.text ?? '')}
      </div>
    );
  }
  if (kind === 'paragraph') {
    return (
      <div className="text-[11px] text-gray-400 py-0.5 px-1">
        ¶ description
      </div>
    );
  }
  if (kind === 'spacer') {
    return <div className="border-t border-dashed border-gray-200 my-1 mx-1" />;
  }
  if (kind === 'repeat') {
    const tmpl = String(block.template ?? '');
    const over = block.over;
    const count = Array.isArray(over) ? over.length : (typeof over === 'string' ? '?' : 0);
    return (
      <div className="text-[11px] text-gray-400 py-0.5 px-1">
        <span className="inline-flex items-center gap-1">
          <span className="font-mono bg-gray-100 px-1 rounded text-gray-600">⟳ {count}× {tmpl}</span>
        </span>
      </div>
    );
  }
  if (kind === 'table') {
    return <TableBlockDisplay block={block} onEdit={onEdit} />;
  }
  return null;
}

// ─── Section card ─────────────────────────────────────────────────────────────

function SectionCard({
  section,
  onChange,
}: {
  section: RawSection;
  onChange: (updated: RawSection) => void;
}) {
  const [editingHeader, setEditingHeader] = useState(false);
  const [draftLabel, setDraftLabel] = useState(section.label ?? '');
  const [draftHint, setDraftHint] = useState(section.hint ?? '');
  const [draftEngineRef, setDraftEngineRef] = useState(section.engine_ref ?? '');

  const commitHeader = () => {
    onChange({
      ...section,
      label: draftLabel || undefined,
      hint: draftHint || undefined,
      engine_ref: draftEngineRef || undefined,
    });
    setEditingHeader(false);
  };

  const cancelHeader = () => {
    setDraftLabel(section.label ?? '');
    setDraftHint(section.hint ?? '');
    setDraftEngineRef(section.engine_ref ?? '');
    setEditingHeader(false);
  };

  const updateBlock = (idx: number, updated: RawBlock) => {
    const blocks = (section.blocks ?? []).slice();
    blocks[idx] = updated;
    onChange({ ...section, blocks });
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white mb-4 shadow-sm">
      {/* Header */}
      <div className="flex items-start gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <span className="text-[13px] font-semibold text-gray-900">
            {section.label ?? section.id ?? '(untitled)'}
          </span>
          {section.hint && (
            <span className="text-[11px] text-gray-500 leading-snug">{section.hint}</span>
          )}
          {section.id && (
            <span className="text-[10px] font-mono text-gray-400">{section.id}</span>
          )}
        </div>
        <button
          className="shrink-0 text-[11px] text-gray-400 bg-transparent border border-gray-200 rounded-[3px] px-1.5 py-0.5 cursor-pointer hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 mt-0.5"
          onClick={() => setEditingHeader((v) => !v)}
          title="Edit section header"
        >
          ✎
        </button>
      </div>

      {/* Header edit form */}
      {editingHeader && (
        <div className="px-3 py-2 bg-blue-50 border-b border-blue-100 flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 min-w-20 shrink-0">label</span>
            <input
              className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white flex-1 focus:outline-none focus:border-blue-600"
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 min-w-20 shrink-0">hint</span>
            <input
              className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white flex-1 focus:outline-none focus:border-blue-600"
              value={draftHint}
              onChange={(e) => setDraftHint(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-[11px] text-gray-500 min-w-20 shrink-0">engine_ref</span>
            <input
              className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white font-mono flex-1 focus:outline-none focus:border-blue-600"
              value={draftEngineRef}
              onChange={(e) => setDraftEngineRef(e.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              className="text-xs bg-blue-600 text-white border border-blue-600 rounded px-2 py-0.5 cursor-pointer hover:bg-blue-700"
              onClick={commitHeader}
            >
              Save
            </button>
            <button
              className="text-xs bg-transparent text-gray-500 border border-gray-200 rounded px-2 py-0.5 cursor-pointer hover:bg-gray-100"
              onClick={cancelHeader}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Blocks */}
      <div className="px-3 py-2">
        {(section.blocks ?? []).length === 0 && (
          <span className="text-[12px] text-gray-400 italic">No blocks.</span>
        )}
        {(section.blocks ?? []).map((block, i) => (
          <BlockRow key={i} block={block} onEdit={(updated) => updateBlock(i, updated)} />
        ))}
      </div>
    </div>
  );
}

// ─── ReportEditor (root export) ───────────────────────────────────────────────

export default function ReportEditor({ rawReport, resolvedSections: _resolvedSections, onSave }: ReportEditorProps) {
  // Keep a mutable copy of the raw report in state so edits are reflected.
  const [report, setReport] = useState<RawReport>(() => rawReport as RawReport);
  const savedSnapshot = useRef(JSON.stringify(rawReport));
  const isDirty = JSON.stringify(report) !== savedSnapshot.current;

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await onSave(report);
      savedSnapshot.current = JSON.stringify(report);
      setSaveMsg('Saved.');
    } catch (e) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const updateSection = (idx: number, updated: RawSection) => {
    const sections = (report.sections ?? []).slice();
    sections[idx] = updated;
    setReport({ ...report, sections });
  };

  const sections = report.sections ?? [];

  return (
    <section className="max-w-[900px] py-2 pb-8 mt-6">
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="text-[13px] font-medium text-gray-700">
          ▤ Report Definition
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {saveMsg && (
            <span className={[
              'text-xs text-gray-500',
              saveMsg.startsWith('Error') ? 'text-red-600' : '',
            ].join(' ')}>
              {saveMsg}
            </span>
          )}
          <button
            className={[
              'btn whitespace-nowrap',
              isDirty ? '!bg-blue-600 !text-white !border-blue-600 hover:!bg-blue-700' : '',
            ].join(' ')}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Save'}
          </button>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-3">
        Editing <code>src/report/report.yaml</code> — {sections.length} section{sections.length !== 1 ? 's' : ''}
      </div>

      {sections.map((section, i) => (
        <SectionCard key={section.id ?? i} section={section} onChange={(updated) => updateSection(i, updated)} />
      ))}
    </section>
  );
}
