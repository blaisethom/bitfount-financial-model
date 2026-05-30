// Declarative model engine — types.
//
// A model is a DAG of named tables. Tables come from `sources` (literal data,
// JSON files, APIs, user-editable cells) or are produced by `steps` that apply
// a `TableOp` to one or more inputs. Each step has a human-readable name and
// description so it can be stepped through forward/back with explanations.
//
// Renderers (web UI, Excel exporter) consume the materialized tables plus the
// step DAG. The Excel renderer additionally translates `Expr` and `TableOp`
// nodes into Excel formulas where possible — kept as a separate concern so the
// model definition stays declarative.

export type ColumnType = 'number' | 'string' | 'date' | 'boolean';

export interface Column {
  name: string;
  type: ColumnType;
  description?: string;
}

export interface TableSchema {
  columns: Column[];
}

export type CellValue = number | string | boolean | null;

export type Row = Record<string, CellValue>;

export interface Table {
  schema: TableSchema;
  rows: Row[];
}

/** Reference to a named table within a model. */
export type TableRef = string;

// ─── Sources ─────────────────────────────────────────────────────────────

export type SourceDef =
  | {
      kind: 'literal';
      description?: string;
      schema: TableSchema;
      rows: Row[];
    }
  | {
      /** API-backed source. Adapters are registered with the sources registry. */
      kind: 'api';
      description?: string;
      adapter: string;
      config: unknown;
      schema: TableSchema;
    }
  | {
      /** User-editable cells. The engine treats these like a literal table at
       *  evaluation time; overrides are layered on top by the host application. */
      kind: 'manual';
      description?: string;
      schema: TableSchema;
      defaults: Row[];
    };

// ─── Expressions (per-row, cell-level) ───────────────────────────────────

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'and' | 'or';

export type FunctionName = 'min' | 'max' | 'if' | 'abs' | 'round' | 'concat' | 'coalesce';

export type Expr =
  | { node: 'col'; name: string }
  | { node: 'lit'; value: CellValue }
  | { node: 'unary'; op: '-' | 'not'; operand: Expr }
  | { node: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { node: 'fn'; name: FunctionName; args: Expr[] };

// ─── Aggregations ────────────────────────────────────────────────────────

export type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'first' | 'last';

export interface AggExpr {
  fn: AggFn;
  /** Column to aggregate. For `count`, `null` means COUNT(*). */
  column: string | null;
}

// ─── Table operations ────────────────────────────────────────────────────

export type TableOp =
  | { op: 'select'; columns: string[] }
  | { op: 'rename'; renames: Record<string, string> }
  | { op: 'filter'; predicate: Expr }
  /** Add or replace columns using per-row expressions. */
  | { op: 'map'; columns: Record<string, Expr> }
  | { op: 'groupBy'; keys: string[]; aggs: Record<string, AggExpr> }
  | { op: 'join'; right: TableRef; on: Array<{ left: string; right: string }>; type: 'inner' | 'left' }
  | { op: 'union'; tables: TableRef[] }
  | { op: 'sort'; by: Array<{ column: string; desc?: boolean }> }
  | { op: 'limit'; n: number };

// ─── Steps ───────────────────────────────────────────────────────────────

export interface Step {
  id: string;
  name: string;
  description: string;
  input: TableRef;
  op: TableOp;
  output: TableRef;
}

// ─── Outputs ─────────────────────────────────────────────────────────────

export interface ModelOutputDef {
  ref: TableRef;
  label: string;
  description?: string;
  render?: 'table' | 'chart';
}

// ─── Model ───────────────────────────────────────────────────────────────

export interface ModelDef {
  sources: Record<string, SourceDef>;
  steps: Step[];
  outputs: ModelOutputDef[];
}

/** Result of evaluating a model. */
export interface EvalResult {
  /** All materialized tables, keyed by ref. */
  tables: Record<string, Table>;
  /** Step outputs in evaluation order — useful for the step-explorer UI. */
  trace: Array<{ step: Step; output: Table }>;
}
