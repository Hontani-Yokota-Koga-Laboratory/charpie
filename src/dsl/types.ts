export const SHAPE_KINDS = ['rect', 'round', 'ellipse', 'diamond', 'trap', 'para', 'hex', 'cross', 'plus', 'text', 'image', 'table', 'list'] as const;
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
  /** end of the statement head when it is not the id (`slot title text` → after `text`) */
  head?: Span;
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
  /** comes from the page's layout: shown but not editable in this view */
  locked?: boolean;
  /** the label as written when `label` shows `{page}` / `{pages}` / `{title}` filled in */
  labelSource?: string;
  /** slot name: a layout's `slot` (layout view) or the page content filling it (page view) */
  slot?: string;
  /** `table` / `list`: the raw lines between `{` and `}` (`braces` false: none written yet, span is where they go) */
  body?: { text: string; span: Span; braces: boolean };
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
  /** comes from the page's layout (read-only in a page view) */
  locked?: boolean;
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
  /** `set family="..."`: font family of the whole file */
  family?: string;
  /** `set compat=pptx`: keep to what a PowerPoint export reproduces (fonts Office has) */
  compat?: 'pptx';
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
  /** `set canvas=1280x720`: the page frame (always present in a deck) */
  canvas?: { w: number; h: number };
  /** present when the file has `page` / `layout` blocks; the doc is then one page (or layout) of it */
  deck?: DeckInfo;
}

/** Which part of a deck a Doc shows. */
export type View = { page: string } | { layout: string };

interface BlockInfo {
  line: number;
  /** the header statement (`page intro "背景" layout=base`) */
  header: Span;
  /** header line through the closing `}` line */
  lines: Span;
  /** where a new statement for this block goes (start of the closing `}` line) */
  insertAt: number;
  /** indentation of the block's statements */
  indent: string;
}

export interface PageInfo extends BlockInfo {
  id: string;
  label: string;
  /** resolved layout name (explicit `layout=`, else `default` when it exists) */
  layout?: string;
  /** `number=skip`: not counted in `{page}` / `{pages}` */
  skip?: boolean;
  /** `hide ID ...` in this page: each id, and the line of its statement */
  hides: { id: string; span: Span; lines: Span }[];
}

export interface LayoutInfo extends BlockInfo {
  name: string;
  extends?: string;
  slots: string[];
}

export interface DeckInfo {
  pages: PageInfo[];
  layouts: LayoutInfo[];
  /** the view this Doc was built for (after falling back to an existing one) */
  view: View;
  /** block of this view: where new statements are inserted */
  block?: PageInfo | LayoutInfo;
  /** page view: slots of the layout the page doesn't fill yet (editor-only hints) */
  placeholders: NodeDef[];
  /** page view: the layout's shapes and slots, and whether this page hides them */
  layoutShapes?: { id: string; kind: string; label: string; slot?: boolean; hidden: boolean }[];
}

export const DEFAULT_CANVAS = { w: 1280, h: 720 };

export function sameView(a: View | undefined, b: View | undefined): boolean {
  if (!a || !b) return a === b;
  return 'page' in a ? 'page' in b && a.page === b.page : 'layout' in b && a.layout === b.layout;
}

export const DEFAULT_SETTINGS: Settings = {
  gap: 0,
  grid: 10,
  padding: 8,
  fontmin: 9,
  fontmax: 18,
};
