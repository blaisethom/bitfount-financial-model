import { useState, useRef } from 'react';
import type {
  SectionLayoutConfig, TabConfig, ContentConfig, ContentItem,
} from '../view-layout/types';

// ─── constants ───────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<string, string> = {
  'table': '#0891b2',
  'chart': '#7c3aed',
  'rendering-definition': '#64748b',
  'excel-export': '#16a34a',
};

const TYPE_ICON: Record<string, string> = {
  'table': '⊞',
  'chart': '⌇',
  'rendering-definition': '▤',
  'excel-export': '↓',
};

const TYPE_DESC: Record<string, string> = {
  'table': 'pivot table from engine ref',
  'chart': 'line chart from engine ref',
  'rendering-definition': 'layout editor',
  'excel-export': 'Excel download',
};

function defaultItem(type: 'table' | 'chart'): ContentItem {
  return { type, ref: '' };
}

function makeTabId() {
  return `tab-${Date.now().toString(36)}`;
}

// ─── skeleton components ─────────────────────────────────────────────────────

function SkeletonTable({ cols = 7, rows = 3 }: { cols?: number; rows?: number }) {
  return (
    <div className="flex flex-col gap-px p-2">
      <div className="flex items-stretch gap-1 bg-gray-100 rounded-sm px-1 py-1">
        <div className="w-20 h-3 bg-gray-300 rounded-sm shrink-0" />
        {Array.from({ length: cols }, (_, i) => <div key={i} className="flex-1 h-3 bg-gray-300 rounded-sm" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={`flex items-stretch gap-1 px-1 py-0.5 rounded-sm ${r % 2 === 1 ? 'bg-gray-50' : ''}`}>
          <div className="w-20 h-2.5 bg-gray-200 rounded-sm shrink-0 self-center" />
          {Array.from({ length: cols }, (_, i) => <div key={i} className="flex-1 h-2.5 bg-gray-200 rounded-sm self-center" />)}
        </div>
      ))}
    </div>
  );
}

function SkeletonChart() {
  const HEIGHTS = [35, 55, 48, 72, 61, 43, 80, 54, 47, 68, 85, 52];
  return (
    <div className="flex items-end gap-1 px-3 pt-2 pb-1 h-24">
      {HEIGHTS.map((h, i) => (
        <div key={i} className="flex-1 rounded-t-sm opacity-40" style={{ height: h, background: 'var(--lec, #2563eb)' }} />
      ))}
    </div>
  );
}

function SkeletonForItem({ item }: { item: ContentItem }) {
  if (item.type === 'chart') return <SkeletonChart />;
  return <SkeletonTable cols={12} rows={2} />;
}

// ─── component card ───────────────────────────────────────────────────────────

interface CardProps {
  type: string;
  label: string;
  detail?: string;
  index?: number;
  total?: number;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  children?: React.ReactNode;
  skeleton: React.ReactNode;
}

function ComponentCard({
  type, label, detail, index = 0, total = 1,
  onMoveUp, onMoveDown, onRemove, children, skeleton,
}: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLOR[type] ?? '#64748b';
  const icon = TYPE_ICON[type] ?? '·';

  return (
    <div
      className="border border-gray-200 rounded-md overflow-hidden bg-white mb-2 shadow-sm border-l-[3px]"
      style={{ '--lec': color, borderLeftColor: color } as React.CSSProperties}
    >
      <div
        className="flex items-center gap-2.5 p-2 px-2.5 cursor-pointer select-none hover:bg-gray-50"
        onClick={() => children && setExpanded(!expanded)}
      >
        <span
          className="inline-flex items-center justify-center w-[26px] h-[26px] rounded-md text-[13px] shrink-0"
          style={{ background: color + '1a', color }}
        >
          {icon}
        </span>
        <div className="flex flex-col gap-px flex-1 min-w-0">
          <span className="text-[13px] font-semibold text-gray-900 whitespace-nowrap overflow-hidden text-ellipsis">
            {label || <span className="hint">(untitled)</span>}
          </span>
          {detail && <span className="text-[11px] text-gray-500">{detail}</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {children && <span className="text-xs text-gray-500 mr-1">{expanded ? '▾' : '▸'}</span>}
          {onMoveUp && (
            <button
              className="bg-transparent border border-gray-200 rounded-[3px] cursor-pointer text-[10px] px-[5px] py-px leading-[1.2] text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-30 disabled:cursor-default"
              disabled={index === 0}
              onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            >↑</button>
          )}
          {onMoveDown && (
            <button
              className="bg-transparent border border-gray-200 rounded-[3px] cursor-pointer text-[10px] px-[5px] py-px leading-[1.2] text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-30 disabled:cursor-default"
              disabled={index === total - 1}
              onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            >↓</button>
          )}
          {onRemove && (
            <button
              className="bg-transparent border border-gray-200 rounded-[3px] cursor-pointer text-[10px] px-[5px] py-px leading-[1.2] text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-30 disabled:cursor-default text-red-600 border-transparent text-[11px] hover:bg-red-100 hover:border-red-300 hover:text-red-700"
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
            >✕</button>
          )}
        </div>
      </div>
      {expanded && children && (
        <div className="border-t border-gray-200 p-3 pb-3 pt-2.5 bg-gray-50">
          {children}
        </div>
      )}
      <div className="border-t border-dashed border-gray-200 bg-gray-50">
        {skeleton}
      </div>
    </div>
  );
}

// ─── config forms ─────────────────────────────────────────────────────────────

function EngineRefLink({ value, href, onNavigate }: { value?: string; href?: string; onNavigate?: (ref: string) => void }) {
  if (!value || (!href && !onNavigate)) return null;
  if (href) {
    return (
      <a
        href={href}
        className="shrink-0 text-[11px] text-blue-600 no-underline hover:underline"
        onClick={onNavigate ? (e) => { e.preventDefault(); onNavigate(value); } : undefined}
        title={`Open in Engine: ${value}`}
      >↗ engine</a>
    );
  }
  return (
    <button
      className="shrink-0 text-[11px] text-blue-600 bg-transparent border-none cursor-pointer hover:underline"
      onClick={() => onNavigate!(value)}
      title={`Open in Engine: ${value}`}
    >↗ engine</button>
  );
}

function ItemConfigForm({ item, onChange, onNavigateEngineRef, resolveEngineRef }: {
  item: ContentItem;
  onChange: (item: ContentItem) => void;
  onNavigateEngineRef?: (ref: string) => void;
  resolveEngineRef?: (ref: string) => string | undefined;
}) {
  // For section ids (e.g. 'budget'), resolve to the engine ref for the deep link.
  // For raw engine refs, use them directly.
  const engineRef = item.ref ? (resolveEngineRef?.(item.ref) ?? item.ref) : undefined;
  const href = engineRef ? `#engine/${encodeURIComponent(engineRef)}` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <span className="text-[11px] text-gray-500 min-w-16 shrink-0">type</span>
        <select
          className="text-xs px-1 py-0.5 border border-gray-200 rounded-[3px] bg-white text-inherit cursor-pointer font-[inherit] focus:outline-none focus:border-blue-600"
          value={item.type}
          onChange={(e) => onChange({ ...item, type: e.target.value as 'table' | 'chart' })}
        >
          <option value="table">table</option>
          <option value="chart">chart</option>
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-500 min-w-16 shrink-0">ref</span>
        <input
          className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white text-inherit font-[inherit] focus:outline-none focus:border-blue-600 flex-1 min-w-[120px]"
          value={item.ref ?? ''}
          placeholder="e.g. budget  or  revenue_monthly"
          onChange={(e) => onChange({ ...item, ref: e.target.value })}
        />
        <EngineRefLink value={item.ref} href={href} onNavigate={onNavigateEngineRef} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-500 min-w-16 shrink-0">title</span>
        <input
          className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white text-inherit font-[inherit] focus:outline-none focus:border-blue-600 flex-1 min-w-[120px]"
          value={item.title ?? ''}
          placeholder="optional heading override"
          onChange={(e) => onChange({ ...item, title: e.target.value || undefined })}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-500 min-w-16 shrink-0">description</span>
        <input
          className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white text-inherit font-[inherit] focus:outline-none focus:border-blue-600 flex-1 min-w-[120px]"
          value={item.description ?? ''}
          placeholder="optional description shown below heading"
          onChange={(e) => onChange({ ...item, description: e.target.value || undefined })}
        />
      </div>
    </div>
  );
}

// ─── tab canvas ───────────────────────────────────────────────────────────────

function TabCanvas({ tab, sectionName: _sectionName, onChange, onNavigateEngineRef, resolveEngineRef }: {
  tab: TabConfig;
  sectionName: string;
  onChange: (tab: TabConfig) => void;
  onNavigateEngineRef?: (ref: string) => void;
  resolveEngineRef?: (ref: string) => string | undefined;
}) {
  const content = tab.content as ContentConfig;

  // Non-list tabs (rendering-definition, excel-export, etc.) — just show a label
  if (content.type !== 'list') {
    return (
      <div className="p-3.5 bg-slate-50 min-h-[60px] flex items-center">
        <span className="text-[12px] text-gray-400 italic">{content.type}</span>
      </div>
    );
  }

  const items: ContentItem[] = content.items ?? [];
  const setItems = (next: ContentItem[]) =>
    onChange({ ...tab, content: { type: 'list', items: next } });

  const updItem = (i: number, it: ContentItem) => {
    const next = items.slice(); next[i] = it; setItems(next);
  };
  const delItem = (i: number) => setItems(items.filter((_, j) => j !== i));
  const movItem = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = items.slice(); [next[i], next[j]] = [next[j], next[i]]; setItems(next);
  };

  return (
    <div className="p-3.5 bg-slate-50 min-h-[100px] flex flex-col gap-0">
      {items.length === 0 && (
        <div className="text-[13px] text-gray-500 italic py-6 text-center">
          No components yet — add one below.
        </div>
      )}
      {items.map((item, i) => (
        <ComponentCard
          key={i}
          type={item.type}
          label={item.ref || '—'}
          detail={item.title ?? TYPE_DESC[item.type]}
          index={i}
          total={items.length}
          onMoveUp={() => movItem(i, -1)}
          onMoveDown={() => movItem(i, 1)}
          onRemove={() => delItem(i)}
          skeleton={<SkeletonForItem item={item} />}
        >
          <ItemConfigForm item={item} onChange={(it) => updItem(i, it)} onNavigateEngineRef={onNavigateEngineRef} resolveEngineRef={resolveEngineRef} />
        </ComponentCard>
      ))}
      <div className="flex gap-2 mt-1">
        <button
          className="text-xs bg-transparent border border-dashed border-gray-200 rounded p-[4px_10px] cursor-pointer text-gray-500 font-[inherit] hover:border-blue-400 hover:text-blue-600 hover:bg-blue-50"
          onClick={() => setItems([...items, defaultItem('table')])}
        >
          + Table
        </button>
        <button
          className="text-xs bg-transparent border border-dashed border-gray-200 rounded p-[4px_10px] cursor-pointer text-gray-500 font-[inherit] hover:border-purple-400 hover:text-purple-600 hover:bg-purple-50"
          onClick={() => setItems([...items, defaultItem('chart')])}
        >
          + Chart
        </button>
      </div>
    </div>
  );
}

// ─── editable tab bar ─────────────────────────────────────────────────────────

function EditableTabBar({ layout, selectedIdx, onSelect, onChange }: {
  layout: SectionLayoutConfig;
  selectedIdx: number;
  onSelect: (i: number) => void;
  onChange: (layout: SectionLayoutConfig) => void;
}) {
  const updTab = (i: number, tab: TabConfig) => {
    const tabs = layout.tabs.slice(); tabs[i] = tab; onChange({ ...layout, tabs });
  };
  const delTab = (i: number) => {
    onChange({ ...layout, tabs: layout.tabs.filter((_, j) => j !== i) });
    if (selectedIdx >= i && selectedIdx > 0) onSelect(selectedIdx - 1);
  };
  const movTab = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layout.tabs.length) return;
    const tabs = layout.tabs.slice(); [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
    onChange({ ...layout, tabs });
    if (selectedIdx === i) onSelect(j);
    else if (selectedIdx === j) onSelect(i);
  };
  const addTab = () => {
    const tabs = [
      ...layout.tabs,
      { id: makeTabId(), label: 'New Tab', content: { type: 'list', items: [] } } as TabConfig,
    ];
    onChange({ ...layout, tabs });
    onSelect(tabs.length - 1);
  };

  return (
    <div className="flex gap-1 mt-2 px-1 border-b border-gray-200 items-end flex-nowrap overflow-x-auto">
      {layout.tabs.map((tab, i) => (
        <div
          key={tab.id + String(i)}
          className={[
            'px-3 py-2 pb-1.5 bg-transparent border border-gray-200 border-b-0 rounded-t-lg cursor-pointer text-sm font-semibold text-gray-500 flex flex-col items-start gap-0.5 relative select-none min-w-[120px] max-w-[200px]',
            i === selectedIdx ? 'bg-white text-blue-600 z-[1]' : '',
          ].join(' ')}
          onClick={() => onSelect(i)}
        >
          <div className="flex items-center gap-1 w-full">
            <input
              className="bg-transparent border-none outline-none font-[inherit] text-[13px] font-semibold text-inherit w-full min-w-0 cursor-pointer p-0 focus:cursor-text"
              value={tab.label}
              title="Tab label"
              onChange={(e) => updTab(i, { ...tab, label: e.target.value })}
              onClick={(e) => { e.stopPropagation(); onSelect(i); }}
            />
            <button
              className="bg-transparent border-none cursor-pointer text-sm text-gray-500 px-0.5 leading-none shrink-0 hover:text-red-600"
              title="Remove tab"
              onClick={(e) => { e.stopPropagation(); delTab(i); }}
            >×</button>
          </div>
          <div className="flex items-center justify-between w-full gap-1">
            <input
              className="bg-transparent border-none outline-none font-mono text-[10px] text-gray-500 w-full min-w-0 p-0 cursor-pointer focus:cursor-text focus:text-gray-900"
              value={tab.id}
              title="Tab ID (used in URL routing)"
              onChange={(e) => updTab(i, { ...tab, id: e.target.value })}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="flex gap-px shrink-0">
              <button
                className="bg-transparent border border-gray-200 rounded-[2px] cursor-pointer text-[10px] px-0.5 leading-[1.4] text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-25 disabled:cursor-default"
                disabled={i === 0}
                title="Move left"
                onClick={(e) => { e.stopPropagation(); movTab(i, -1); }}
              >‹</button>
              <button
                className="bg-transparent border border-gray-200 rounded-[2px] cursor-pointer text-[10px] px-0.5 leading-[1.4] text-gray-500 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-25 disabled:cursor-default"
                disabled={i === layout.tabs.length - 1}
                title="Move right"
                onClick={(e) => { e.stopPropagation(); movTab(i, 1); }}
              >›</button>
            </div>
          </div>
        </div>
      ))}
      <div
        className="px-3 py-2 pb-1.5 bg-transparent border border-gray-200 border-b-0 rounded-t-lg text-sm font-semibold text-gray-500 flex flex-col items-start gap-0.5 relative select-none cursor-pointer min-w-16 items-center justify-center text-center border-dashed gap-0 hover:text-blue-600 hover:border-blue-600 hover:bg-blue-100"
        onClick={addTab}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && addTab()}
      >
        <span className="text-base font-normal leading-[1.2]">+</span>
        <span className="view-tab-sub">add tab</span>
      </div>
    </div>
  );
}

// ─── layout editor section ────────────────────────────────────────────────────

function LayoutEditorSection({ layout, onChange, onNavigateEngineRef, resolveEngineRef }: {
  layout: SectionLayoutConfig;
  onChange: (l: SectionLayoutConfig) => void;
  onNavigateEngineRef?: (ref: string) => void;
  resolveEngineRef?: (ref: string) => string | undefined;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, Math.max(0, layout.tabs.length - 1));
  const tab = layout.tabs[safeIdx] as TabConfig | undefined;

  const updTab = (i: number, t: TabConfig) => {
    const tabs = layout.tabs.slice(); tabs[i] = t; onChange({ ...layout, tabs });
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden mb-4 bg-white">
      <EditableTabBar
        layout={layout}
        selectedIdx={safeIdx}
        onSelect={setActiveIdx}
        onChange={onChange}
      />
      {tab ? (
        <>
          <div className="flex items-center gap-3 px-3.5 py-2 border-b border-gray-200 bg-gray-50">
            <label className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500 min-w-16 shrink-0">subtitle</span>
              <input
                className="text-xs px-1.5 py-0.5 border border-gray-200 rounded-[3px] bg-white text-inherit font-[inherit] focus:outline-none focus:border-blue-600"
                value={tab.subtitle ?? ''}
                placeholder="optional — shown below the tab label"
                onChange={(e) => updTab(safeIdx, { ...tab, subtitle: e.target.value || undefined })}
              />
            </label>
          </div>
          <TabCanvas tab={tab} sectionName={layout.section} onChange={(t) => updTab(safeIdx, t)} onNavigateEngineRef={onNavigateEngineRef} resolveEngineRef={resolveEngineRef} />
        </>
      ) : (
        <div className="p-3.5 bg-slate-50 min-h-[100px] flex flex-col gap-0 text-[13px] text-gray-500 italic py-6 text-center">
          No tabs yet — click + to add one.
        </div>
      )}
    </div>
  );
}

// ─── LayoutEditor (root export) ───────────────────────────────────────────────

export interface LayoutEditorProps {
  webLayout: SectionLayoutConfig;
  onChangeWeb: (l: SectionLayoutConfig) => void;
  onNavigateEngineRef?: (ref: string) => void;
  resolveEngineRef?: (ref: string) => string | undefined;
}

export function LayoutEditor({
  webLayout,
  onChangeWeb,
  onNavigateEngineRef,
  resolveEngineRef,
}: LayoutEditorProps) {
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const savedSnapshot = useRef(JSON.stringify(webLayout));
  const isDirty = JSON.stringify(webLayout) !== savedSnapshot.current;

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const result = await fetch('/api/layout/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'web', data: webLayout }),
      }).then((r) => r.json()) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error);
      savedSnapshot.current = JSON.stringify(webLayout);
      setSaveMsg('Saved.');
    } catch (e) {
      setSaveMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="max-w-[900px] py-2 pb-8">
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="text-[13px] font-medium text-gray-700">
          ⊞ Web layout
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

      <div className="text-xs text-gray-500 mb-1">
        Editing <code>src/view-layout/web.yaml</code>
      </div>

      <LayoutEditorSection layout={webLayout} onChange={onChangeWeb} onNavigateEngineRef={onNavigateEngineRef} resolveEngineRef={resolveEngineRef} />
    </section>
  );
}
