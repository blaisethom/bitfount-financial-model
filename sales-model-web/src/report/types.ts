// Report definition: a declarative description of how engine tables become a
// human-readable report (Excel sheets, web tabs). The same `ReportDef` is
// consumed by both the Excel renderer and the (forthcoming) React renderer so
// the two stay structurally aligned.
//
// Data comes from the engine — every `TableBlock` points at an engine table
// `source` (a source or step output ref). Renderers materialise those tables
// once (typically as hidden helper sheets in Excel) and emit cross-sheet
// formulas so edits to the engine inputs flow through to the report views.

export type CellFormat = 'money' | 'count' | 'integer' | 'decimal' | 'percent' | 'text';

export interface ColumnSpec {
  /** Column name in the engine table. */
  col: string;
  /** Display label. Defaults to `col`. */
  label?: string;
  format?: CellFormat;
  bold?: boolean;
}

/**
 * Axis pivot: distinct values of `col` become Excel columns. For the sales
 * model, this is typically `month_idx` (rendered as YYYY-MM dates).
 */
export interface AxisSpec {
  col: string;
  /**
   * How to label each axis column.
   *   - 'dates' : look up `month_idx` → YYYY-MM via the calendar table.
   *   - 'years' : show distinct years (used after a yearly groupBy).
   *   - 'raw'   : print the value as-is. Default.
   */
  labels?: 'dates' | 'years' | 'raw';
}

/**
 * Where do the row entries of a (possibly pivoted) table come from?
 *
 *   - `value-columns`: each `ColumnSpec` in `rows` becomes a row, labelled by
 *     the spec's label. Columns of the rendered table come from the axis (or
 *     are the value columns themselves if no axis). Used when one engine row
 *     has multiple metrics that should stack vertically (e.g. platform /
 *     project / pm components per (ta, month)).
 *
 *   - `table-rows`: each row in the source table becomes a row in the output.
 *     `labelCol` provides the row label. Used when each row already represents
 *     a distinct entity (e.g. the pricing table: type A / B / C).
 *
 *   - `pivot-rows`: distinct values of `labelCol` become rows; the axis col
 *     pivots across columns; each cell is the named `valueCol` looked up at
 *     (groupKeys + labelCol + axisValue). Used for the per-TA × per-type ×
 *     month grids (starts, active trials, modeller commission).
 */
export type RowsSpec =
  | { kind: 'value-columns'; rows: ColumnSpec[] }
  | { kind: 'table-rows'; labelCol: string; labelHeader?: string; columnFormats?: Record<string, CellFormat> }
  | {
      kind: 'pivot-rows';
      labelCol: string;
      labelHeader?: string;
      valueCol: string;
      labelMap?: Record<string, string>;
      format?: CellFormat;
      bold?: boolean;
    }
  /**
   * Explicit list of rows, each potentially from a different source. Useful
   * to mix data from multiple engine tables into one table — e.g. a HubSpot
   * pipeline row + per-TA modeled revenue rows + a grand-total row all in
   * the same monthly grid.
   */
  | {
      kind: 'explicit';
      labelHeader?: string;
      rows: Array<{
        /** Override the block's default source for this row. */
        source?: string;
        /** Pin to a specific row by identity columns (joined with axis at render time). */
        identity: Record<string, string | number>;
        valueCol: string;
        label: string;
        bold?: boolean;
        format?: CellFormat;
      }>;
    };

export interface YearRollup {
  /** Append one column per calendar year (sum over months in that year). */
  yearTotals?: boolean;
  /** Append a final total column (sum of every month / row). */
  grandTotal?: boolean;
  /** Label for the grand-total column. Defaults to 'Total'. */
  grandTotalLabel?: string;
}

export interface TotalsRow {
  label: string;
  bold?: boolean;
  /** How the totals are computed.
   *   - 'sum-rows' (default): sum the value-row cells above in each column.
   *   - 'sum-cols': sum across columns of each row (not yet used).
   */
  mode?: 'sum-rows' | 'sum-cols';
}

/**
 * Declares that this block holds the canonical (editable) cells for one or
 * more engine table refs. When set, the renderer writes the cells as raw
 * values + records their addresses, so downstream derived blocks emit
 * formulas pointing at these cells.
 *
 * In the salesReport, manual sources (pricing, schedule, commission,
 * employees, hubspot pipeline, cost line items, depreciation) appear as
 * canonical blocks. Some derived engine outputs (e.g. `active_by_ta_type_
 * month`) can also be marked canonical so other formulas can reference them
 * directly rather than re-deriving from scratch.
 */
export interface CanonicalDecl {
  refs: string[];
}

export interface TableBlock {
  kind: 'table';
  /** Engine table ref to read rows from. */
  source: string;
  /** Optional title rendered above the table. */
  title?: string;
  /**
   * Group rows by these columns; emit one sub-block per group, each with its
   * own header row built from the key values.
   */
  groupBy?: {
    keys: string[];
    /** Build the sub-block heading from the group's key values. */
    label: (key: Record<string, string | number>) => string;
  };
  /** Pivot this column across the X-axis. */
  axis?: AxisSpec;
  /** Where the table's rows come from (engine rows vs. value-column stack). */
  rows: RowsSpec;
  /** Optional totals row appended below the block. */
  totalsRow?: TotalsRow;
  /** Year / grand-total columns appended to the right. */
  rollup?: YearRollup;
  /** Default format for value cells; column specs can override. */
  defaultFormat?: CellFormat;
  /**
   * Mark this block as the canonical (editable) representation of the named
   * engine table refs. The renderer writes raw values into these cells and
   * records their addresses so derived formulas can reference them.
   *
   * Defaults to `[source]` when the block's source is a manual engine source.
   */
  canonical?: CanonicalDecl;
  /**
   * Static row filter: only consider source rows matching every key. A scalar
   * value matches by equality; an array value matches "in" (any one of). Used
   * to render per-TA / per-dept blocks or to restrict to a subset of groups
   * without programmatic groupBy iteration. Applied before grouping/axis.
   */
  filter?: Record<string, string | number | Array<string | number>>;
}

export interface TitleBlock {
  kind: 'title';
  text: string;
  /** 1 = section title, 2 = subtitle, 3 = sub-subtitle. Default 1. */
  level?: 1 | 2 | 3;
}

export interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
  italic?: boolean;
}

export interface SpacerBlock {
  kind: 'spacer';
  /** Number of blank rows. Default 1. */
  rows?: number;
}

export interface ChartBlock {
  kind: 'chart';
  /** Engine step-output ref — or the special value `staff-headcount` for the roster-derived headcount chart. */
  ref: string;
  title?: string;
}

export type ReportBlock = TableBlock | TitleBlock | ParagraphBlock | SpacerBlock | ChartBlock;

export interface ReportSection {
  /** Stable identifier; used for hash-route navigation in the web renderer. */
  id: string;
  /** Tab / sheet label. */
  label: string;
  /** Optional one-line description. */
  hint?: string;
  /**
   * Primary engine ref for this section — the step output or source that best
   * represents it. Used to build deeplinks from the layout editor back to the
   * Engine explorer.
   */
  engineRef?: string;
  blocks: ReportBlock[];
}

export interface ReportDef {
  sections: ReportSection[];
  /**
   * Engine table ref of the calendar (one row per month_idx with a `date`
   * column). Required when any axis uses `labels: 'dates'`.
   */
  calendarRef?: string;
  /**
   * Engine table refs to materialise as hidden helper sheets before the
   * report sections render. Each cell is recorded in the address book so
   * derived formulas can reference it instead of inlining the full chain.
   * Used to break otherwise enormous inline expansions (e.g. `dates_t`,
   * whose `date` cell would otherwise expand into a CONCATENATE formula
   * inlined into every employee × month cost).
   */
  hiddenSheets?: string[];
}
