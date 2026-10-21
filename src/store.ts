import { create } from 'zustand';
import { parse } from './dsl/parse';
import { sameView, type Doc, type ShapeKind, type View } from './dsl/types';
import { computeLayout, type Layout } from './layout';
import { checkAll, type Issue } from './check/check';
import { canvasMeasure } from './text/fit';
import { SAMPLE } from './sample';

export type Tool = 'select' | 'edge' | 'pan' | ShapeKind;
export type ViewMode = 'split' | 'canvas' | 'code';

export interface Selection {
  nodes: string[];
  edges: string[];
}

export interface Derived {
  doc: Doc;
  layout: Layout;
  issues: Issue[];
  /** issues silenced with `ignore=` */
  ignored: Issue[];
}

function derive(src: string, page?: View): Derived {
  const doc = parse(src, page);
  const layout = computeLayout(doc, canvasMeasure);
  const all = checkAll(doc, layout);
  return { doc, layout, issues: all.filter((i) => !i.ignored), ignored: all.filter((i) => i.ignored) };
}

const LS_SRC = 'charpie:src';
const LS_UI = 'charpie:ui';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

interface UiPrefs {
  theme: 'light' | 'dark';
  viewMode: ViewMode;
  codeWidth: number;
  fileName: string;
  geomAnchor: GeomAnchor;
  autoSave: boolean;
}

/** What the inspector's X/Y mean, and what stays fixed when W/H change. */
export type GeomAnchor = 'corner' | 'center';
export interface ToastAction {
  label: string;
  run(): void;
}

const prefs = load<Partial<UiPrefs>>(LS_UI, {});
const initialSrc = load<string>(LS_SRC, SAMPLE);
const systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;

export interface Workspace {
  on: boolean;
  root: string;
  file: string | null;
  files: string[];
  status: 'live' | 'offline' | 'saving';
  /** the text differs from what is on disk (manual-save mode) */
  dirty: boolean;
  /** the file changed on disk while there were unsaved edits */
  conflict: boolean;
}

export interface State extends Derived {
  src: string;
  /** deck: the page / layout on the canvas (undefined: the first page, or a plain diagram) */
  page: View | undefined;
  /** full-screen slide show */
  presenting: boolean;
  /** bumped by remeasure() (fonts loaded, embedded diagrams arrived) */
  measured: number;
  /** who produced the latest change (editor changes must not be echoed back) */
  origin: 'editor' | 'ui' | 'init' | 'remote';
  /** bumped when the text is replaced from outside, so in-flight canvas gestures abort */
  epoch: number;
  workspace: Workspace;
  past: string[];
  future: string[];
  lastPush: number;
  gestureBase: string | null;

  selection: Selection;
  tool: Tool;
  view: { x: number; y: number; zoom: number };
  theme: 'light' | 'dark';
  viewMode: ViewMode;
  codeWidth: number;
  fileName: string;
  geomAnchor: GeomAnchor;
  /** workspace: write every change to disk, or only on save */
  autoSave: boolean;
  /** `at`: where the user double-clicked (world coordinates), to put the caret there */
  editing: { type: 'node' | 'edge'; id: string; at?: { x: number; y: number } } | null;
  hoverIssue: string | null;
  focusIssue: string | null;
  /** touch: taps add to / toggle the selection */
  multiSelect: boolean;
  /** mobile: inspector sheet shown without a selection (document settings) */
  docSheet: boolean;
  toast: { id: number; text: string; tone?: 'ok' | 'warn'; action?: ToastAction } | null;

  setSource(src: string, opts?: { origin?: State['origin']; history?: 'push' | 'coalesce' | 'none' }): void;
  /** Show another page / layout of a deck (clears the selection and fits the view). */
  setPage(page: View | undefined, opts?: { fit?: boolean }): void;
  setPresenting(v: boolean): void;
  /** Apply a source transform as one undoable step. */
  apply(fn: (src: string, doc: Doc) => string, origin?: State['origin']): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  remeasure(): void;

  select(sel: Partial<Selection>, mode?: 'replace' | 'toggle' | 'add'): void;
  clearSelection(): void;
  setTool(t: Tool): void;
  setView(v: Partial<State['view']>): void;
  setTheme(t: State['theme']): void;
  setViewMode(m: ViewMode): void;
  setCodeWidth(w: number): void;
  setFileName(n: string): void;
  setGeomAnchor(a: GeomAnchor): void;
  setAutoSave(v: boolean): void;
  setEditing(e: State['editing']): void;
  setHoverIssue(id: string | null): void;
  setFocusIssue(id: string | null): void;
  notify(text: string, tone?: 'ok' | 'warn', action?: ToastAction): void;
  setWorkspace(w: Partial<Workspace>): void;
  setMultiSelect(v: boolean): void;
  setDocSheet(v: boolean): void;
  /** Replace the text from outside (server / Claude Code). */
  loadExternal(src: string, opts?: { resetHistory?: boolean }): void;
}

const HISTORY_LIMIT = 300;

export const useStore = create<State>((set, get) => ({
  src: initialSrc,
  page: undefined,
  presenting: false,
  measured: 0,
  ...derive(initialSrc),
  origin: 'init',
  epoch: 0,
  workspace: { on: false, root: '', file: null, files: [], status: 'offline', dirty: false, conflict: false },
  past: [],
  future: [],
  lastPush: 0,
  gestureBase: null,

  selection: { nodes: [], edges: [] },
  tool: 'select',
  view: { x: 0, y: 0, zoom: 1 },
  theme: prefs.theme ?? (systemDark ? 'dark' : 'light'),
  viewMode: prefs.viewMode ?? 'split',
  codeWidth: prefs.codeWidth ?? 440,
  fileName: prefs.fileName ?? 'diagram.charpie',
  geomAnchor: prefs.geomAnchor ?? 'corner',
  autoSave: prefs.autoSave ?? false,
  editing: null,
  hoverIssue: null,
  focusIssue: null,
  multiSelect: false,
  docSheet: false,
  toast: null,

  setSource(src, opts = {}) {
    const s = get();
    if (src === s.src) return;
    const history = opts.history ?? 'push';
    let past = s.past;
    let lastPush = s.lastPush;
    if (s.gestureBase === null && history !== 'none') {
      const now = Date.now();
      if (history === 'push' || now - s.lastPush > 800) {
        past = [...past, s.src].slice(-HISTORY_LIMIT);
      }
      lastPush = now;
    }
    let page = s.page;
    let d = derive(src, page);
    // the shown page was renamed / removed: stay at the same position in the deck
    if (page && d.doc.deck && !sameView(page, d.doc.deck.view)) {
      const old = s.doc.deck;
      const i = 'page' in page && old ? old.pages.findIndex((p) => p.id === (page as { page: string }).page) : -1;
      const pages = d.doc.deck.pages;
      page = i >= 0 && pages.length ? { page: pages[Math.min(i, pages.length - 1)].id } : d.doc.deck.view;
      d = derive(src, page);
    }
    if (!d.doc.deck) page = undefined;
    // prune selection of removed items
    const sel = s.selection;
    const nodes = sel.nodes.filter((id) => d.doc.nodeMap.has(id));
    const edges = sel.edges.filter((k) => d.layout.edgeMap.has(k));
    set({
      src,
      ...d,
      origin: opts.origin ?? 'ui',
      past,
      future: history === 'none' ? s.future : [],
      lastPush,
      selection: nodes.length !== sel.nodes.length || edges.length !== sel.edges.length ? { nodes, edges } : sel,
      page,
    });
  },

  setPage(page, opts = {}) {
    const s = get();
    const d = derive(s.src, page);
    if (sameView(d.doc.deck?.view, s.doc.deck?.view) && sameView(page, s.page)) return;
    set({ ...d, page: d.doc.deck?.view, selection: { nodes: [], edges: [] }, editing: null, hoverIssue: null, focusIssue: null });
    if (opts.fit !== false) queueMicrotask(() => window.dispatchEvent(new Event('charpie:fit')));
  },
  setPresenting(presenting) {
    set({ presenting });
  },

  apply(fn, origin = 'ui') {
    const s = get();
    const next = fn(s.src, s.doc);
    if (next !== s.src) s.setSource(next, { origin, history: 'push' });
  },

  beginGesture() {
    set({ gestureBase: get().src });
  },
  endGesture() {
    const s = get();
    if (s.gestureBase !== null && s.gestureBase !== s.src) {
      set({ past: [...s.past, s.gestureBase].slice(-HISTORY_LIMIT), future: [], gestureBase: null });
    } else set({ gestureBase: null });
  },

  undo() {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (prev === undefined) return;
    set({ past: s.past.slice(0, -1), future: [s.src, ...s.future] });
    get().setSource(prev, { history: 'none' });
    set({ future: [s.src, ...s.future] });
  },
  redo() {
    const s = get();
    const next = s.future[0];
    if (next === undefined) return;
    set({ past: [...s.past, s.src], future: s.future.slice(1) });
    get().setSource(next, { history: 'none' });
    set({ future: s.future.slice(1) });
  },

  remeasure() {
    set({ ...derive(get().src, get().page), measured: get().measured + 1 });
  },

  select(sel, mode = 'replace') {
    const cur = get().selection;
    if (mode === 'replace') {
      set({ selection: { nodes: sel.nodes ?? [], edges: sel.edges ?? [] } });
      return;
    }
    const merge = (a: string[], b: string[] = []) => {
      const out = new Set(a);
      for (const x of b) {
        if (mode === 'toggle' && out.has(x)) out.delete(x);
        else out.add(x);
      }
      return [...out];
    };
    set({ selection: { nodes: merge(cur.nodes, sel.nodes), edges: merge(cur.edges, sel.edges) } });
  },
  clearSelection() {
    if (get().selection.nodes.length || get().selection.edges.length) set({ selection: { nodes: [], edges: [] } });
  },
  setTool(tool) {
    set({ tool });
  },
  setView(v) {
    set({ view: { ...get().view, ...v } });
  },
  setTheme(theme) {
    set({ theme });
  },
  setViewMode(viewMode) {
    set({ viewMode });
  },
  setCodeWidth(codeWidth) {
    set({ codeWidth: Math.max(280, Math.min(900, codeWidth)) });
  },
  setFileName(fileName) {
    set({ fileName });
  },
  setGeomAnchor(geomAnchor) {
    set({ geomAnchor });
  },
  setAutoSave(autoSave) {
    set({ autoSave });
  },
  setEditing(editing) {
    set({ editing });
  },
  setHoverIssue(hoverIssue) {
    set({ hoverIssue });
  },
  setFocusIssue(focusIssue) {
    set({ focusIssue });
  },
  notify(text, tone, action) {
    set({ toast: { id: Date.now(), text, tone, action } });
  },
  setMultiSelect(multiSelect) {
    set({ multiSelect });
  },
  setDocSheet(docSheet) {
    set({ docSheet });
  },
  setWorkspace(w) {
    set({ workspace: { ...get().workspace, ...w } });
  },
  loadExternal(src, opts = {}) {
    const s = get();
    if (src === s.src) return;
    set({ gestureBase: null, epoch: s.epoch + 1, editing: null });
    get().setSource(src, { origin: 'remote', history: opts.resetHistory ? 'none' : 'push' });
    if (opts.resetHistory) set({ past: [], future: [] });
  },
}));

// persistence (debounced)
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.src === prev.src && s.theme === prev.theme && s.viewMode === prev.viewMode && s.codeWidth === prev.codeWidth && s.fileName === prev.fileName && s.geomAnchor === prev.geomAnchor && s.autoSave === prev.autoSave) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_SRC, JSON.stringify(s.src));
      localStorage.setItem(LS_UI, JSON.stringify({ theme: s.theme, viewMode: s.viewMode, codeWidth: s.codeWidth, fileName: s.fileName, geomAnchor: s.geomAnchor, autoSave: s.autoSave }));
    } catch {
      /* storage unavailable */
    }
  }, 250);
});

/** Parse edited text for the page / layout on the canvas (use after patching `src`). */
export const reparse = (src: string): Doc => parse(src, useStore.getState().page);

/** Convenience: the full set of issue ids touching a node / edge. */
export function issuesFor(issues: Issue[], kind: 'node' | 'edge', id: string): Issue[] {
  return issues.filter((i) => (kind === 'node' ? i.nodes.includes(id) : i.edges.includes(id)));
}

if (import.meta.env.DEV) (window as unknown as { __charpie: typeof useStore }).__charpie = useStore;
