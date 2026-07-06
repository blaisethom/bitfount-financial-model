import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

// ─── Raw YAML types ───────────────────────────────────────────────────────────

type RawBlock = Record<string, unknown>;

type RawSection = {
  id?: string;
  label?: string;
  hint?: string;
  engine_ref?: string;
  blocks?: RawBlock[];
};

type RawItem = {
  type: string;
  ref: string;
  title?: string;
  description?: string;
};

type RawTab = {
  id: string;
  label: string;
  subtitle?: string;
  content: { type: string; items?: RawItem[] };
};

type RawReport = {
  tabs?: RawTab[];
  sections?: RawSection[];
  [key: string]: unknown;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTabId() {
  return `tab-${Date.now().toString(36)}`;
}

const INPUT_CLS =
  'text-xs px-1.5 py-1 border border-gray-200 rounded-[3px] bg-white font-mono w-full focus:outline-none focus:border-blue-500';

const SELECT_CLS =
  'text-xs px-1.5 py-1 border border-gray-200 rounded-[3px] bg-white font-mono w-full focus:outline-none focus:border-blue-500 cursor-pointer';

// ─── Field helper ─────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-[11px] text-gray-500 shrink-0 w-[90px]">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// ─── Accordion ────────────────────────────────────────────────────────────────

interface AccordionProps {
  title: string;
  badge?: string;
  onRemove?: () => void;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function Accordion({ title, badge, onRemove, defaultOpen = false, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-md overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-50 cursor-pointer select-none hover:bg-gray-100"
        onClick={() => setOpen(v => !v)}
      >
        <span className="text-[11px] text-gray-500 shrink-0">{open ? '▾' : '▸'}</span>
        <span className="flex-1 text-[12px] font-semibold text-gray-700">{title}</span>
        {badge && (
          <span className="text-[10px] bg-gray-200 text-gray-600 rounded-full px-1.5 py-0 leading-5">
            {badge}
          </span>
        )}
        {onRemove && (
          <button
            className="text-[11px] text-gray-400 hover:text-red-500 ml-1 px-1"
            onClick={e => { e.stopPropagation(); onRemove(); }}
            title="Remove"
          >
            ×
          </button>
        )}
      </div>
      {open && <div className="px-3 py-2 flex flex-col gap-2 bg-white">{children}</div>}
    </div>
  );
}

// ─── Block forms ──────────────────────────────────────────────────────────────

function TitleBlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  return (
    <>
      <Field label="text">
        <input
          className={INPUT_CLS}
          value={String(block.text ?? '')}
          onChange={e => onChange({ ...block, text: e.target.value })}
        />
      </Field>
      <Field label="level">
        <select
          className={SELECT_CLS}
          value={String(block.level ?? '1')}
          onChange={e => onChange({ ...block, level: Number(e.target.value) })}
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </Field>
    </>
  );
}

function ParagraphBlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  return (
    <Field label="text">
      <textarea
        className={INPUT_CLS + ' resize-y min-h-[60px]'}
        value={String(block.text ?? '')}
        onChange={e => onChange({ ...block, text: e.target.value })}
      />
    </Field>
  );
}

function SpacerBlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  return (
    <Field label="rows">
      <input
        type="number"
        min={1}
        max={10}
        className={INPUT_CLS}
        value={String(block.rows ?? 1)}
        onChange={e => onChange({ ...block, rows: Number(e.target.value) })}
      />
    </Field>
  );
}

function TableBlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  const rows = (block.rows as Record<string, unknown> | undefined) ?? { kind: 'table-rows' };
  const rowsKind = String(rows.kind ?? 'table-rows');
  const axis = block.axis as Record<string, unknown> | undefined;
  const axisCol = axis ? String(axis.col ?? '') : '';
  const rollup = block.rollup as Record<string, unknown> | undefined;
  const totalsRow = block.totals_row as Record<string, unknown> | undefined;
  const canonicalRaw = block.canonical;
  const canonicalEnabled = canonicalRaw != null && canonicalRaw !== false;

  const setRows = (patch: Record<string, unknown>) => {
    onChange({ ...block, rows: { ...rows, ...patch } });
  };
  const setAxis = (patch: Record<string, unknown> | null) => {
    if (patch === null) {
      const next = { ...block };
      delete next.axis;
      onChange(next);
    } else {
      onChange({ ...block, axis: { ...(axis ?? {}), ...patch } });
    }
  };
  const setRollup = (patch: Record<string, unknown>) => {
    onChange({ ...block, rollup: { ...(rollup ?? {}), ...patch } });
  };

  return (
    <>
      <Field label="source">
        <input
          className={INPUT_CLS}
          value={String(block.source ?? '')}
          onChange={e => onChange({ ...block, source: e.target.value })}
        />
      </Field>
      <Field label="defaultFormat">
        <select
          className={SELECT_CLS}
          value={String(block.default_format ?? block.defaultFormat ?? '')}
          onChange={e => {
            const next = { ...block };
            delete next.defaultFormat;
            onChange({ ...next, default_format: e.target.value || undefined });
          }}
        >
          <option value="">(none)</option>
          <option value="money">money</option>
          <option value="count">count</option>
          <option value="integer">integer</option>
          <option value="percent">percent</option>
          <option value="text">text</option>
        </select>
      </Field>
      <Field label="rows.kind">
        <select
          className={SELECT_CLS}
          value={rowsKind}
          onChange={e => setRows({ kind: e.target.value })}
        >
          <option value="table-rows">table-rows</option>
          <option value="value-columns">value-columns</option>
          <option value="pivot-rows">pivot-rows</option>
          <option value="explicit">explicit</option>
        </select>
      </Field>
      {(rowsKind === 'table-rows' || rowsKind === 'pivot-rows') && (
        <Field label="rows.labelCol">
          <input
            className={INPUT_CLS}
            value={String(rows.label_col ?? rows.labelCol ?? '')}
            onChange={e => setRows({ label_col: e.target.value })}
            placeholder="e.g. type"
          />
        </Field>
      )}
      {rowsKind === 'pivot-rows' && (
        <Field label="rows.valueCol">
          <input
            className={INPUT_CLS}
            value={String(rows.value_col ?? rows.valueCol ?? '')}
            onChange={e => setRows({ value_col: e.target.value })}
            placeholder="e.g. value"
          />
        </Field>
      )}
      <Field label="axis.col">
        <input
          className={INPUT_CLS}
          value={axisCol}
          placeholder="blank = no axis"
          onChange={e => {
            const val = e.target.value.trim();
            if (!val) {
              setAxis(null);
            } else {
              setAxis({ col: val });
            }
          }}
        />
      </Field>
      {axisCol && (
        <Field label="axis.labels">
          <select
            className={SELECT_CLS}
            value={String(axis?.labels ?? 'dates')}
            onChange={e => setAxis({ labels: e.target.value })}
          >
            <option value="dates">dates</option>
            <option value="years">years</option>
            <option value="raw">raw</option>
          </select>
        </Field>
      )}
      <Field label="totalsRow">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={totalsRow != null}
            onChange={e => {
              if (e.target.checked) {
                onChange({ ...block, totals_row: { label: 'Total' } });
              } else {
                const next = { ...block };
                delete next.totals_row;
                onChange(next);
              }
            }}
          />
          <span className="text-xs text-gray-500">enable</span>
        </label>
      </Field>
      {totalsRow != null && (
        <Field label="totalsRow.label">
          <input
            className={INPUT_CLS}
            value={String(totalsRow.label ?? '')}
            onChange={e => onChange({ ...block, totals_row: { ...totalsRow, label: e.target.value } })}
          />
        </Field>
      )}
      <Field label="rollup.yearTotals">
        <input
          type="checkbox"
          checked={!!(rollup?.year_totals ?? rollup?.yearTotals)}
          onChange={e => setRollup({ year_totals: e.target.checked })}
        />
      </Field>
      <Field label="rollup.grandTotal">
        <input
          type="checkbox"
          checked={!!(rollup?.grand_total ?? rollup?.grandTotal)}
          onChange={e => setRollup({ grand_total: e.target.checked })}
        />
      </Field>
      <Field label="canonical">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={canonicalEnabled}
            onChange={e => {
              if (e.target.checked) {
                onChange({ ...block, canonical: [String(block.source ?? '')] });
              } else {
                const next = { ...block };
                delete next.canonical;
                onChange(next);
              }
            }}
          />
          <span className="text-xs text-gray-500">[{String(block.source ?? '')}]</span>
        </label>
      </Field>
      <Field label="id (anchor)">
        <input
          className={INPUT_CLS}
          value={String(block.id ?? '')}
          placeholder="optional"
          onChange={e => {
            const val = e.target.value.trim();
            const next = { ...block };
            if (val) next.id = val; else delete next.id;
            onChange(next);
          }}
        />
      </Field>
    </>
  );
}

function ChartBlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  return (
    <>
      <Field label="ref">
        <input
          className={INPUT_CLS}
          value={String(block.ref ?? '')}
          onChange={e => onChange({ ...block, ref: e.target.value })}
        />
      </Field>
      <Field label="title">
        <input
          className={INPUT_CLS}
          value={String(block.title ?? '')}
          placeholder="optional"
          onChange={e => {
            const val = e.target.value;
            const next = { ...block };
            if (val) next.title = val; else delete next.title;
            onChange(next);
          }}
        />
      </Field>
    </>
  );
}

function BlockForm({ block, onChange }: { block: RawBlock; onChange: (b: RawBlock) => void }) {
  const kind = String(block.kind ?? '');
  if (kind === 'title') return <TitleBlockForm block={block} onChange={onChange} />;
  if (kind === 'paragraph') return <ParagraphBlockForm block={block} onChange={onChange} />;
  if (kind === 'spacer') return <SpacerBlockForm block={block} onChange={onChange} />;
  if (kind === 'table') return <TableBlockForm block={block} onChange={onChange} />;
  if (kind === 'chart') return <ChartBlockForm block={block} onChange={onChange} />;
  return <div className="text-[11px] text-gray-400 italic py-1">No editor for this block type</div>;
}

// ─── Block kind icons & label ─────────────────────────────────────────────────

function blockIcon(kind: string): string {
  if (kind === 'table') return '⊞';
  if (kind === 'chart') return '⌇';
  if (kind === 'title') return 'T';
  if (kind === 'paragraph') return '¶';
  if (kind === 'spacer') return '—';
  if (kind === 'repeat') return '⟳';
  return '?';
}

function blockLabel(block: RawBlock): string {
  const kind = String(block.kind ?? '');
  if (kind === 'table') return String(block.source ?? '(no source)');
  if (kind === 'chart') return String(block.ref ?? '(no ref)');
  if (kind === 'title') return String(block.text ?? '').slice(0, 30) || '(title)';
  if (kind === 'paragraph') return '¶ ' + (String(block.text ?? '').slice(0, 25) || '(paragraph)');
  if (kind === 'spacer') return `spacer ×${String(block.rows ?? 1)}`;
  if (kind === 'repeat') return `repeat ${String(block.template ?? '')}`;
  return kind || '(unknown)';
}

function blockIconColor(kind: string): { bg: string; text: string } {
  if (kind === 'table') return { bg: 'bg-cyan-50', text: 'text-cyan-700' };
  if (kind === 'chart') return { bg: 'bg-purple-50', text: 'text-purple-700' };
  if (kind === 'title') return { bg: 'bg-blue-50', text: 'text-blue-700' };
  if (kind === 'paragraph') return { bg: 'bg-gray-100', text: 'text-gray-600' };
  if (kind === 'spacer') return { bg: 'bg-gray-100', text: 'text-gray-400' };
  return { bg: 'bg-gray-100', text: 'text-gray-600' };
}

function blockAccordionTitle(block: RawBlock): string {
  const kind = String(block.kind ?? '');
  const label = blockLabel(block);
  return `${kind.charAt(0).toUpperCase() + kind.slice(1)} · ${label}`;
}

// ─── Add Block Modal ──────────────────────────────────────────────────────────

type NewBlockKind = 'title' | 'paragraph' | 'spacer' | 'table' | 'chart';

interface AddBlockModalProps {
  open: boolean;
  hasLinkedSection: boolean;
  onClose: () => void;
  onAdd: (block: RawBlock) => void;
}

function AddBlockModal({ open, hasLinkedSection, onClose, onAdd }: AddBlockModalProps) {
  const [kind, setKind] = useState<NewBlockKind>('table');
  const [sourceOrRef, setSourceOrRef] = useState('');
  const [text, setText] = useState('');

  const handleAdd = () => {
    let block: RawBlock = { kind };
    if (kind === 'table') {
      block = { kind: 'table', source: sourceOrRef, rows: { kind: 'table-rows' } };
    } else if (kind === 'chart') {
      block = { kind: 'chart', ref: sourceOrRef };
    } else if (kind === 'title') {
      block = { kind: 'title', text, level: 1 };
    } else if (kind === 'paragraph') {
      block = { kind: 'paragraph', text };
    } else if (kind === 'spacer') {
      block = { kind: 'spacer', rows: 1 };
    }
    onAdd(block);
    setSourceOrRef('');
    setText('');
    setKind('table');
    onClose();
  };

  const showSourceRef = kind === 'table' || kind === 'chart';
  const showText = kind === 'title' || kind === 'paragraph';
  const sourceLabel = kind === 'table' ? 'source' : 'ref';

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Block</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 mt-2">
          <Field label="type">
            <select
              className={SELECT_CLS}
              value={kind}
              onChange={e => setKind(e.target.value as NewBlockKind)}
            >
              <option value="title">title</option>
              <option value="paragraph">paragraph</option>
              <option value="spacer">spacer</option>
              <option value="table">table</option>
              <option value="chart">chart</option>
            </select>
          </Field>
          {showSourceRef && (
            <Field label={sourceLabel}>
              <input
                className={INPUT_CLS}
                value={sourceOrRef}
                placeholder={kind === 'table' ? 'table_name_t' : 'chart-ref-id'}
                onChange={e => setSourceOrRef(e.target.value)}
              />
            </Field>
          )}
          {showText && (
            <Field label="text">
              <input
                className={INPUT_CLS}
                value={text}
                onChange={e => setText(e.target.value)}
              />
            </Field>
          )}
          <div className="flex gap-2 justify-end mt-1">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={!hasLinkedSection}
              title={!hasLinkedSection ? 'No linked section' : undefined}
            >
              Add
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Editable tab bar ─────────────────────────────────────────────────────────

function TabBar({ tabs, activeIdx, onSelect, onUpdate, onAdd }: {
  tabs: RawTab[]; activeIdx: number;
  onSelect: (i: number) => void;
  onUpdate: (i: number, t: RawTab) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex gap-1 px-1 border-b border-gray-200 items-end flex-nowrap overflow-x-auto">
      {tabs.map((tab, i) => (
        <div
          key={tab.id + String(i)}
          className={[
            'px-3 py-2 pb-1.5 bg-transparent border border-gray-200 border-b-0 rounded-t-lg cursor-pointer text-sm font-semibold text-gray-500 flex flex-col items-start gap-0.5 relative select-none min-w-[110px] max-w-[180px]',
            i === activeIdx ? 'bg-white text-blue-600 z-[1]' : 'hover:text-gray-800',
          ].join(' ')}
          onClick={() => onSelect(i)}
        >
          <div className="flex items-center gap-1 w-full">
            <input
              className="bg-transparent border-none outline-none font-[inherit] text-[13px] font-semibold text-inherit w-full min-w-0 cursor-pointer p-0 focus:cursor-text"
              value={tab.label}
              onChange={e => onUpdate(i, { ...tab, label: e.target.value })}
              onClick={e => { e.stopPropagation(); onSelect(i); }}
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 text-gray-400 hover:text-red-500"
              onClick={e => { e.stopPropagation(); onUpdate(i, { ...tab, id: '\x00DELETE' }); }}
              title="Remove tab"
            >×</Button>
          </div>
          <input
            className="bg-transparent border-none outline-none font-mono text-[10px] text-gray-400 w-full min-w-0 p-0 cursor-pointer focus:cursor-text focus:text-gray-700"
            value={tab.id}
            title="Tab ID"
            onChange={e => onUpdate(i, { ...tab, id: e.target.value })}
            onClick={e => e.stopPropagation()}
          />
        </div>
      ))}
      <div
        className="px-3 py-2 pb-1.5 bg-transparent border border-dashed border-gray-200 border-b-0 rounded-t-lg cursor-pointer text-gray-400 flex items-center justify-center hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50 select-none min-w-12"
        onClick={onAdd}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && onAdd()}
      >
        <span className="text-base font-normal">+</span>
      </div>
    </div>
  );
}

// ─── Main editor ──────────────────────────────────────────────────────────────

export interface ReportDefinitionEditorProps {
  rawReport: unknown;
  /** The id prefix applied by resolveReport (e.g. 'yaml-'). Used to link tab refs back to raw section ids. */
  idPrefix?: string;
  onSave: (data: unknown) => Promise<void>;
  /** Called when the user clicks the YAML link on a section. Receives the raw (unprefixed) section id. */
  onViewInYaml?: (sectionId: string) => void;
  onNavigateEngineRef?: (ref: string) => void;
  resolveEngineRef?: (ref: string) => string | undefined;
}

export default function ReportDefinitionEditor({
  rawReport,
  idPrefix = 'yaml-',
  onSave,
  onViewInYaml,
}: ReportDefinitionEditorProps) {
  const [report, setReport] = useState<RawReport>(() => rawReport as RawReport);
  const savedSnapshot = useRef(JSON.stringify(rawReport));
  const isDirty = JSON.stringify(report) !== savedSnapshot.current;
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const [selectedBlockKey, setSelectedBlockKey] = useState<string | null>(null);
  const [addBlockOpen, setAddBlockOpen] = useState(false);

  const tabs = report.tabs ?? [];
  const sections = report.sections ?? [];
  const safeIdx = Math.min(activeTabIdx, Math.max(0, tabs.length - 1));
  const tab = tabs[safeIdx] as RawTab | undefined;

  const setTabs = (next: RawTab[]) => setReport(r => ({ ...r, tabs: next }));
  const setSections = (next: RawSection[]) => setReport(r => ({ ...r, sections: next }));

  // Resolve item ref → raw section (strip idPrefix from the ref).
  const findSection = (ref: string): { section: RawSection; idx: number } | undefined => {
    const rawId = ref.startsWith(idPrefix) ? ref.slice(idPrefix.length) : ref;
    const idx = sections.findIndex(s => s.id === rawId);
    if (idx < 0) return undefined;
    return { section: sections[idx], idx };
  };

  const updateTab = (i: number, next: RawTab) => {
    if (next.id === '\x00DELETE') {
      const nextTabs = tabs.filter((_, j) => j !== i);
      setTabs(nextTabs);
      if (safeIdx >= nextTabs.length && safeIdx > 0) setActiveTabIdx(nextTabs.length - 1);
    } else {
      const next2 = tabs.slice(); next2[i] = next; setTabs(next2);
    }
  };

  const addTab = () => {
    const next = [...tabs, { id: makeTabId(), label: 'New Tab', content: { type: 'list', items: [] } }];
    setTabs(next); setActiveTabIdx(next.length - 1);
  };

  const updateTabItems = (items: RawItem[]) => {
    if (!tab) return;
    updateTab(safeIdx, { ...tab, content: { ...tab.content, items } });
  };

  const handleSave = async () => {
    setSaving(true); setSaveMsg(null);
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

  const items: RawItem[] = (tab?.content as { items?: RawItem[] } | undefined)?.items ?? [];
  const isSpecialTab = tab && tab.content.type !== 'list';

  // Gather linked sections for current tab (in order).
  // Each item that has a yaml- prefix ref links to a section.
  type LinkedGroup = { section: RawSection; sectionIdx: number; itemRef: string };
  const linkedGroups: LinkedGroup[] = [];
  const seenSectionIds = new Set<string>();
  for (const item of items) {
    const found = findSection(item.ref);
    if (found && !seenSectionIds.has(found.section.id ?? '')) {
      seenSectionIds.add(found.section.id ?? '');
      linkedGroups.push({ section: found.section, sectionIdx: found.idx, itemRef: item.ref });
    }
  }

  // primarySection = first linked section (for "Add Block")
  const primaryGroup = linkedGroups[0];
  const hasPrimarySection = primaryGroup != null;

  // Parse selectedBlockKey = "sectionId/blockIndex"
  const parseBlockKey = (key: string): { sectionId: string; blockIndex: number } | null => {
    const slash = key.lastIndexOf('/');
    if (slash < 0) return null;
    return { sectionId: key.slice(0, slash), blockIndex: Number(key.slice(slash + 1)) };
  };

  // Get the selected block
  const getSelectedBlock = (): { block: RawBlock; section: RawSection; sectionIdx: number; blockIndex: number } | null => {
    if (!selectedBlockKey) return null;
    const parsed = parseBlockKey(selectedBlockKey);
    if (!parsed) return null;
    const secIdx = sections.findIndex(s => s.id === parsed.sectionId);
    if (secIdx < 0) return null;
    const sec = sections[secIdx];
    const block = sec.blocks?.[parsed.blockIndex];
    if (!block) return null;
    return { block, section: sec, sectionIdx: secIdx, blockIndex: parsed.blockIndex };
  };

  const selectedInfo = getSelectedBlock();

  const updateBlock = (sectionIdx: number, blockIndex: number, updated: RawBlock) => {
    const newSecs = sections.slice();
    const sec = { ...newSecs[sectionIdx] };
    const blocks = (sec.blocks ?? []).slice();
    blocks[blockIndex] = updated;
    sec.blocks = blocks;
    newSecs[sectionIdx] = sec;
    setSections(newSecs);
  };

  const removeBlock = (sectionIdx: number, blockIndex: number) => {
    const newSecs = sections.slice();
    const sec = { ...newSecs[sectionIdx] };
    const blocks = (sec.blocks ?? []).slice();
    blocks.splice(blockIndex, 1);
    sec.blocks = blocks;
    newSecs[sectionIdx] = sec;
    setSections(newSecs);
    setSelectedBlockKey(null);
  };

  const addBlockToPrimary = (block: RawBlock) => {
    if (!primaryGroup) return;
    const newSecs = sections.slice();
    const sec = { ...newSecs[primaryGroup.sectionIdx] };
    sec.blocks = [...(sec.blocks ?? []), block];
    newSecs[primaryGroup.sectionIdx] = sec;
    setSections(newSecs);
    // Auto-select the new block
    const newIdx = sec.blocks.length - 1;
    setSelectedBlockKey(`${sec.id ?? ''}/${newIdx}`);
  };

  return (
    <section className="flex flex-col h-full py-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 mb-1 shrink-0">
        <div className="text-[13px] font-medium text-gray-700">▤ Report Definition</div>
        <div className="flex items-center gap-2.5 shrink-0">
          {saveMsg && (
            <span className={`text-xs ${saveMsg.startsWith('Error') ? 'text-red-600' : 'text-gray-500'}`}>{saveMsg}</span>
          )}
          <Button
            variant={isDirty ? 'default' : 'outline'}
            size="sm"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : isDirty ? 'Save changes' : 'Save'}
          </Button>
        </div>
      </div>
      <div className="text-xs text-gray-400 mb-3 shrink-0">
        Editing <code>src/report/report.yaml</code>
      </div>

      {/* Tab bar */}
      <div className="shrink-0">
        <TabBar
          tabs={tabs}
          activeIdx={safeIdx}
          onSelect={i => { setActiveTabIdx(i); setSelectedBlockKey(null); }}
          onUpdate={updateTab}
          onAdd={addTab}
        />
      </div>

      {/* Tab content area */}
      {!tab ? (
        <div className="p-6 text-center text-[13px] text-gray-400 italic border border-t-0 border-gray-200 rounded-b-lg">
          No tabs — click + to add one.
        </div>
      ) : isSpecialTab ? (
        <div className="border border-t-0 border-gray-200 rounded-b-lg p-8 text-center text-[12px] text-gray-400 italic">
          Special tab type: <code>{tab.content.type}</code>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 border border-t-0 border-gray-200 rounded-b-lg overflow-hidden">
          {/* Tab Definition accordion */}
          <div className="shrink-0 p-3 border-b border-gray-100">
            <Accordion title="Tab Definition" badge={`${items.length} items`}>
              <Field label="subtitle">
                <input
                  className={INPUT_CLS}
                  value={tab.subtitle ?? ''}
                  placeholder="shown under tab label"
                  onChange={e => updateTab(safeIdx, { ...tab, subtitle: e.target.value || undefined })}
                />
              </Field>
              <div className="mt-1">
                <div className="text-[11px] text-gray-500 mb-1">Content items:</div>
                {items.length === 0 && (
                  <div className="text-[11px] text-gray-400 italic mb-1">No items yet.</div>
                )}
                {items.map((item, i) => (
                  <div key={i} className="flex items-center gap-1.5 mb-1">
                    <span className="text-[10px] text-gray-400 w-4 shrink-0 text-right">{i + 1}.</span>
                    <input
                      className={INPUT_CLS + ' flex-1'}
                      value={item.ref}
                      placeholder="ref"
                      onChange={e => {
                        const next = items.slice(); next[i] = { ...item, ref: e.target.value };
                        updateTabItems(next);
                      }}
                    />
                    <select
                      className="text-[11px] px-1 py-1 border border-gray-200 rounded-[3px] bg-white focus:outline-none cursor-pointer font-mono"
                      value={item.type}
                      onChange={e => {
                        const next = items.slice(); next[i] = { ...item, type: e.target.value };
                        updateTabItems(next);
                      }}
                    >
                      <option value="table">table</option>
                      <option value="chart">chart</option>
                    </select>
                    <Button size="icon" variant="outline" className="h-6 w-6 shrink-0" disabled={i === 0}
                      onClick={() => {
                        const next = items.slice(); [next[i - 1], next[i]] = [next[i], next[i - 1]];
                        updateTabItems(next);
                      }}>↑</Button>
                    <Button size="icon" variant="outline" className="h-6 w-6 shrink-0" disabled={i === items.length - 1}
                      onClick={() => {
                        const next = items.slice(); [next[i], next[i + 1]] = [next[i + 1], next[i]];
                        updateTabItems(next);
                      }}>↓</Button>
                    <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0 text-red-400 hover:text-red-600"
                      onClick={() => updateTabItems(items.filter((_, j) => j !== i))}>✕</Button>
                  </div>
                ))}
                <div className="flex gap-2 mt-2">
                  <Button variant="outline" size="sm" className="border-dashed text-xs h-7"
                    onClick={() => updateTabItems([...items, { type: 'table', ref: '' }])}>
                    + Table
                  </Button>
                  <Button variant="outline" size="sm" className="border-dashed text-xs h-7"
                    onClick={() => updateTabItems([...items, { type: 'chart', ref: '' }])}>
                    + Chart
                  </Button>
                </div>
              </div>
            </Accordion>
          </div>

          {/* Two-column layout */}
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/* Left sidebar */}
            <div className="w-[220px] shrink-0 border-r border-gray-100 flex flex-col overflow-hidden">
              <div className="p-2 shrink-0 border-b border-gray-100">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs h-7 border-dashed"
                  disabled={!hasPrimarySection}
                  title={!hasPrimarySection ? 'No linked section' : undefined}
                  onClick={() => setAddBlockOpen(true)}
                >
                  + Add Block
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {linkedGroups.length === 0 ? (
                  <div className="text-[11px] text-gray-400 italic text-center mt-4">
                    No linked sections.<br />Add a yaml- ref to a tab item.
                  </div>
                ) : (
                  linkedGroups.map(({ section }) => {
                    const sectionId = section.id ?? '';
                    const rawSectionId = sectionId.startsWith(idPrefix) ? sectionId.slice(idPrefix.length) : sectionId;
                    const blocks = section.blocks ?? [];
                    return (
                      <div key={sectionId} className="mb-3">
                        <div className="flex items-center gap-1 px-1 mb-1">
                          <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide flex-1 truncate">
                            {section.label ?? sectionId}
                          </span>
                          {onViewInYaml && rawSectionId && (
                            <button
                              className="text-[10px] text-blue-400 hover:text-blue-600 font-mono shrink-0 px-0.5"
                              title={`View §${rawSectionId} in YAML`}
                              onClick={() => onViewInYaml(rawSectionId)}
                            >
                              yaml↗
                            </button>
                          )}
                        </div>
                        {blocks.length === 0 && (
                          <div className="text-[11px] text-gray-400 italic px-1">No blocks.</div>
                        )}
                        {blocks.map((block, bi) => {
                          const key = `${sectionId}/${bi}`;
                          const kind = String(block.kind ?? '');
                          const { bg, text } = blockIconColor(kind);
                          const isSelected = selectedBlockKey === key;
                          return (
                            <div
                              key={bi}
                              className={[
                                'flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer mb-0.5 text-[11px]',
                                isSelected
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'hover:bg-gray-100 text-gray-700',
                              ].join(' ')}
                              onClick={() => setSelectedBlockKey(isSelected ? null : key)}
                            >
                              <span className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded text-[10px] shrink-0 ${bg} ${text}`}>
                                {blockIcon(kind)}
                              </span>
                              <span className="truncate font-mono">{blockLabel(block)}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right panel */}
            <div className="flex-1 overflow-y-auto p-3">
              {!selectedInfo ? (
                <div className="flex items-center justify-center h-full text-[12px] text-gray-400 italic">
                  Select a block from the sidebar
                </div>
              ) : (
                <Accordion
                  title={blockAccordionTitle(selectedInfo.block)}
                  defaultOpen={true}
                  onRemove={() => removeBlock(selectedInfo.sectionIdx, selectedInfo.blockIndex)}
                >
                  <BlockForm
                    block={selectedInfo.block}
                    onChange={updated => updateBlock(selectedInfo.sectionIdx, selectedInfo.blockIndex, updated)}
                  />
                </Accordion>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Block modal */}
      <AddBlockModal
        open={addBlockOpen}
        hasLinkedSection={hasPrimarySection}
        onClose={() => setAddBlockOpen(false)}
        onAdd={addBlockToPrimary}
      />
    </section>
  );
}
