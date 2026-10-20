export const SHAPE_KINDS = ['rect', 'round', 'ellipse', 'diamond', 'trap', 'para', 'hex', 'cross', 'plus', 'text'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export const ARROW_OPS = ['->', '<-', '<->', '--'] as const;
export type ArrowOp = (typeof ARROW_OPS)[number];

export type Port = 'n' | 'e' | 's' | 'w';

/** Half-open character range in the source text. */
export interface Span {
  from: number;
  to: number;
}

export interface AttrEntry {
  key: string;
  value: string;
  span: Span;
}

/** Positions inside a statement that the patcher can rewrite in place. */
export interface StmtSpans {
  /** Whole statement (without trailing newline / comment). */
  stmt: Span;
  /** Statement plus the line break that follows it (used for deletion). */
  lines: Span;
  label?: Span;
  at?: Span;
  size?: Span;
  kind?: Span;
  id?: Span;
  op?: Span;
  fromRef?: Span;
  toRef?: Span;
}

export interface NodeDef {
  id: string;
  kind: ShapeKind;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  attrs: Record<string, string>;
  attrList: AttrEntry[];
  classes: string[];
  line: number;
  spans: StmtSpans;
}

/** A free arrow end: absolute `(x, y)` or `+(dx, dy)` relative to the other end. */
export interface EndPoint {
  x: number;
  y: number;
  rel: boolean;
}

/** `from` / `to` value used for an end that is a point instead of a shape. */
export const POINT_END = '*';

export interface EdgeDef {
  /** Stable key: `${from}${op}${to}#${n}` where n counts duplicates (a point end counts as `*`). */
  key: string;
  /** node id, or POINT_END when fromPt is set */
  from: string;
  to: string;
  fromPt?: EndPoint;
  toPt?: EndPoint;
  fromPort?: Port;
  toPort?: Port;
  op: ArrowOp;
  label: string;
  attrs: Record<string, string>;
  attrList: AttrEntry[];
  classes: string[];
  line: number;
  spans: StmtSpans;
}

export interface StyleDef {
  name: string;
  props: Record<string, string>;
  line: number;
}

export interface Settings {
  gap: number;
  grid: number;
  padding: number;
  fontmin: number;
  fontmax: number;
}

export interface Diagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: string;
}

export interface Doc {
  nodes: NodeDef[];
  nodeMap: Map<string, NodeDef>;
  edges: EdgeDef[];
  styles: Map<string, StyleDef>;
  settings: Settings;
  settingsSpan?: Span;
  /** explicitly written settings, in source order */
  settingsAttrs: Record<string, string>;
  diagnostics: Diagnostic[];
}

export const DEFAULT_SETTINGS: Settings = {
  gap: 0,
  grid: 10,
  padding: 8,
  fontmin: 9,
  fontmax: 18,
};
