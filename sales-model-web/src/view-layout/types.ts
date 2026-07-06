// ─── Web / Rendering tab layout ──────────────────────────────────────────────

export interface ContentItem {
  type: 'table' | 'chart';
  /**
   * Engine step-output / source ref, OR a ReportSection id (e.g. 'budget',
   * 'total-revenue'). Section ids are rendered as a full EngineSection (AG-Grid,
   * editable); plain engine refs fall back to a lightweight pivot table.
   */
  ref: string;
  /** Optional heading override (defaults to the section label or ref name). */
  title?: string;
  /** Optional description shown below the heading. */
  description?: string;
}

export interface ContentConfig {
  type: 'list' | 'rendering-definition' | 'excel-export';
  items?: ContentItem[];
}

export interface TabConfig {
  id: string;
  label: string;
  subtitle?: string;
  content: ContentConfig;
}

export interface SectionLayoutConfig {
  section: string;
  tabs: TabConfig[];
}

// ─── Engine section layout ────────────────────────────────────────────────────

export interface EngineGroupDef {
  name: string;
  description?: string;
  refs: string[];
}

export interface EngineOutputDef {
  ref: string;
  label: string;
  description?: string;
  render?: 'table' | 'chart';
}

export interface EngineLayoutConfig {
  groups?: EngineGroupDef[];
  outputs?: EngineOutputDef[];
}
