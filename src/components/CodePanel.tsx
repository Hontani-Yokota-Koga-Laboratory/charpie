import { useEffect, useRef, useState } from 'react';
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StreamLanguage, HighlightStyle, syntaxHighlighting, bracketMatching, indentOnInput } from '@codemirror/language';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { setDiagnostics, lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { autocompletion, closeBrackets, completionKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { Check, Copy, FileCode } from 'lucide-react';
import { useStore } from '../store';
import { SHAPE_KINDS } from '../dsl/types';
import { EDGE_ATTRS, NODE_ATTRS } from '../dsl/parse';
import type { Doc } from '../dsl/types';
import type { Issue } from '../check/check';

const External = Annotation.define<boolean>();

// ───────────── language ─────────────
const KINDS = new Set<string>([...SHAPE_KINDS, 'rectangle', 'box', 'rounded', 'circle', 'oval', 'trapezoid', 'parallelogram', 'hexagon', 'otimes', 'oplus', 'label']);
const KEYWORDS = new Set(['style', 'set', 'at', 'size']);

interface LexState {
  pos: number; // token index within statement
  inStyle: boolean;
}

const charpieLang = StreamLanguage.define<LexState>({
  name: 'charpie',
  startState: () => ({ pos: 0, inStyle: false }),
  token(stream, state) {
    if (stream.sol() && !state.inStyle) state.pos = 0;
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/.*/) || stream.match(/^#(?=\s|$|[#!]).*/)) return 'comment';
    if (stream.match(/^#[0-9a-fA-F]{3,8}(?![\w])/)) {
      state.pos++;
      return 'atom';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.pos++;
      return 'string';
    }
    if (stream.match(/^(<->|->|<-|--)/)) {
      state.pos++;
      return 'operator';
    }
    if (stream.match(/^\d+(?:\.\d+)?x\d+(?:\.\d+)?/) || stream.match(/^-?\d*\.?\d+/)) {
      state.pos++;
      return 'number';
    }
    if (stream.match(/^[{}]/)) {
      state.inStyle = stream.current() === '{';
      return 'brace';
    }
    if (stream.match(/^[(),:;=.]/)) return 'punctuation';
    const m = stream.match(/^[\p{L}_][\p{L}\p{N}_]*(?:-(?![->])[\p{L}\p{N}_]+)*/u) as RegExpMatchArray | null;
    if (m) {
      const w = m[0];
      const first = state.pos === 0;
      state.pos++;
      if (stream.peek() === '=' || (state.inStyle && /^\s*:/.test(stream.string.slice(stream.pos)))) return 'propertyName';
      if (first && KINDS.has(w)) return 'typeName';
      if (KEYWORDS.has(w)) return 'keyword';
      if (stream.string[stream.start - 1] === '.') return 'className';
      return 'variableName';
    }
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '#' } },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: t.string, color: 'var(--tok-str)' },
  { tag: t.number, color: 'var(--tok-num)' },
  { tag: t.keyword, color: 'var(--tok-kw)', fontWeight: '600' },
  { tag: t.typeName, color: 'var(--tok-kind)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--tok-attr)' },
  { tag: t.operator, color: 'var(--tok-op)', fontWeight: '700' },
  { tag: t.atom, color: 'var(--tok-color)' },
  { tag: t.variableName, color: 'var(--tok-id)' },
  { tag: t.className, color: 'var(--tok-kw)' },
  { tag: [t.punctuation, t.brace], color: 'var(--tok-punct)' },
]);

// ───────────── color swatches ─────────────
class SwatchWidget extends WidgetType {
  constructor(readonly color: string) {
    super();
  }
  eq(o: SwatchWidget) {
    return o.color === this.color;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-swatch';
    s.style.background = this.color;
    return s;
  }
}
function swatches(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    const re = /#[0-9a-fA-F]{3,8}(?![\w])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (![4, 5, 7, 9].includes(m[0].length)) continue;
      const pos = from + m.index;
      b.add(pos, pos, Decoration.widget({ widget: new SwatchWidget(m[0]), side: -1 }));
    }
  }
  return b.finish();
}
const swatchPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) {
      this.decorations = swatches(v);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = swatches(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// ───────────── selected-line highlight ─────────────
const setSelLines = StateEffect.define<{ from: number; to: number }[]>();
const selLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setSelLines)) {
        const b = new RangeSetBuilder<Decoration>();
        const seen = new Set<number>();
        const ranges = [...e.value].sort((a, c) => a.from - c.from);
        for (const r of ranges) {
          if (r.to > tr.state.doc.length) continue;
          const l1 = tr.state.doc.lineAt(r.from).number,
            l2 = tr.state.doc.lineAt(r.to).number;
          for (let l = l1; l <= l2; l++) {
            if (seen.has(l)) continue;
            seen.add(l);
            b.add(tr.state.doc.line(l).from, tr.state.doc.line(l).from, Decoration.line({ class: 'cm-sel-line' }));
          }
        }
        deco = b.finish();
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ───────────── completion ─────────────
function complete(ctx: CompletionContext): CompletionResult | null {
  const doc = useStore.getState().doc;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const word = ctx.matchBefore(/[\p{L}\p{N}_#.-]*/u);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const trimmed = before.trimStart();
  // first word: shape kinds / keywords / node ids (for edges)
  if (!/\s/.test(trimmed)) {
    return {
      from: word.from,
      options: [
        ...SHAPE_KINDS.map((k) => ({ label: k, type: 'type', detail: '図形' })),
        { label: 'style', type: 'keyword' },
        { label: 'set', type: 'keyword' },
        ...doc.nodes.map((n) => ({ label: n.id, type: 'variable', detail: n.label.split('\n')[0] })),
      ],
    };
  }
  if (/(->|<-|<->|--)\s*[\p{L}\p{N}_]*$/u.test(before)) {
    return { from: word.from, options: doc.nodes.map((n) => ({ label: n.id, type: 'variable', detail: n.label.split('\n')[0] })) };
  }
  if (word.text.startsWith('.')) {
    return { from: word.from + 1, options: [...doc.styles.keys()].map((s) => ({ label: s, type: 'class' })) };
  }
  const isEdge = /(->|<-|<->|--)/.test(before);
  const m = /(\w+)=([\w#]*)$/.exec(before);
  if (m) {
    const vals: Record<string, string[]> = {
      dash: ['solid', 'dashed', 'dotted'],
      route: ['straight', 'curve', 'ortho'],
      weight: ['bold', 'light'],
      overlap: ['allow'],
      valign: ['top', 'middle', 'bottom'],
      halign: ['left', 'center', 'right'],
      rotate: ['90', '-90', '180'],
      ignore: ['all', 'overlap', 'gap', 'text', 'contain', 'covered', 'through', 'label', 'loop'],
      font: ['auto', '12', '14', '16'],
      in: doc.nodes.map((n) => n.id),
    };
    const opts = vals[m[1]];
    if (opts) return { from: ctx.pos - m[2].length, options: opts.map((v) => ({ label: v, type: 'constant' })) };
    return null;
  }
  const keys = [...(isEdge ? EDGE_ATTRS : NODE_ATTRS)];
  return {
    from: word.from,
    options: [...keys.map((k) => ({ label: k + '=', type: 'property' })), ...(isEdge ? [] : [{ label: 'at', type: 'keyword', apply: 'at (0, 0)' }, { label: 'size', type: 'keyword', apply: 'size 140x60' }])],
  };
}

// ───────────── theme ─────────────
const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--code-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.7' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--code-gutter)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-sel-line': { backgroundColor: 'var(--accent-soft)', boxShadow: 'inset 2px 0 0 var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-ring) !important' },
  '.cm-swatch': { display: 'inline-block', width: '10px', height: '10px', borderRadius: '3px', marginRight: '4px', verticalAlign: '-1px', boxShadow: '0 0 0 1px var(--border-strong)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  '.cm-tooltip': { border: '1px solid var(--border-strong)', backgroundColor: 'var(--panel-solid)', borderRadius: '10px', boxShadow: 'var(--shadow)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'white' },
  '.cm-diagnostic': { fontFamily: 'var(--font)', fontSize: '12px', padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
});

// ───────────── helpers ─────────────
function stmtSpanFor(doc: Doc, kind: 'node' | 'edge', id: string) {
  if (kind === 'node') return doc.nodeMap.get(id)?.spans.stmt;
  return doc.edges.find((e) => e.key === id)?.spans.stmt;
}

export function buildDiagnostics(doc: Doc, issues: Issue[], len: number): CmDiagnostic[] {
  const out: CmDiagnostic[] = doc.diagnostics.map((d) => ({ from: Math.min(d.from, len), to: Math.min(Math.max(d.to, d.from), len), severity: d.severity, message: d.message, source: 'syntax' }));
  for (const i of issues) {
    const spans = [...i.nodes.slice(0, 1).map((id) => stmtSpanFor(doc, 'node', id)), ...i.edges.slice(0, 1).map((k) => stmtSpanFor(doc, 'edge', k))].filter(Boolean);
    // highlight the *id* token of the first node when available
    const span = i.edges.length && (i.code === 'edge-through' || i.code === 'label-overlap' || i.code === 'self-loop') ? stmtSpanFor(doc, 'edge', i.edges[0]) : spans[0];
    if (!span) continue;
    out.push({ from: Math.min(span.from, len), to: Math.min(span.to, len), severity: i.severity, message: i.message, source: '制約' });
    // also mark the other node in pairwise issues
    if (i.nodes.length > 1 && (i.code === 'overlap' || i.code === 'too-close')) {
      const s2 = stmtSpanFor(doc, 'node', i.nodes[1]);
      if (s2) out.push({ from: Math.min(s2.from, len), to: Math.min(s2.to, len), severity: i.severity, message: i.message, source: '制約' });
    }
  }
  return out;
}

function minimalChange(a: string, b: string) {
  let s = 0;
  const max = Math.min(a.length, b.length);
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { from: s, to: a.length - e, insert: b.slice(s, b.length - e) };
}

function selectionRanges(doc: Doc, sel: { nodes: string[]; edges: string[] }) {
  const out: { from: number; to: number }[] = [];
  for (const id of sel.nodes) {
    const s = doc.nodeMap.get(id)?.spans.stmt;
    if (s) out.push(s);
  }
  for (const k of sel.edges) {
    const s = doc.edges.find((e) => e.key === k)?.spans.stmt;
    if (s) out.push(s);
  }
  return out;
}

// ───────────── component ─────────────
export function CodePanel() {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fileName = useStore((s) => s.fileName);
  const nodeCount = useStore((s) => s.doc.nodes.length);
  const edgeCount = useStore((s) => s.doc.edges.length);
  const lineCount = useStore((s) => s.src.split('\n').length);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const st = useStore.getState();
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: st.src,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ override: [complete], icons: false }),
          charpieLang,
          syntaxHighlighting(highlight),
          swatchPlugin,
          selLineField,
          lintGutter(),
          theme,
          keymap.of([
            { key: 'Mod-z', run: () => (useStore.getState().undo(), true), preventDefault: true },
            { key: 'Mod-Shift-z', run: () => (useStore.getState().redo(), true), preventDefault: true },
            { key: 'Mod-y', run: () => (useStore.getState().redo(), true), preventDefault: true },
            ...completionKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            const s = useStore.getState();
            const external = u.transactions.some((tr) => tr.annotation(External));
            if (u.docChanged && !external) {
              s.setSource(u.state.doc.toString(), { origin: 'editor', history: 'coalesce' });
            }
            // caret → select the statement under it
            if (u.selectionSet && !u.docChanged && u.view.hasFocus) {
              const pos = u.state.selection.main.head;
              const d = s.doc;
              const n = d.nodes.find((x) => pos >= x.spans.lines.from && pos <= x.spans.stmt.to);
              const e = n ? undefined : d.edges.find((x) => pos >= x.spans.lines.from && pos <= x.spans.stmt.to);
              if (n) s.select({ nodes: [n.id] });
              else if (e) s.select({ edges: [e.key] });
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    const syncDiag = () => {
      const s = useStore.getState();
      view.dispatch(setDiagnostics(view.state, buildDiagnostics(s.doc, s.issues, view.state.doc.length)));
    };
    syncDiag();
    view.dispatch({ effects: setSelLines.of(selectionRanges(st.doc, st.selection)) });

    const unsub = useStore.subscribe((s, prev) => {
      if (s.src !== prev.src && s.origin !== 'editor') {
        const cur = view.state.doc.toString();
        if (cur !== s.src) {
          view.dispatch({ changes: minimalChange(cur, s.src), annotations: [External.of(true)] });
        }
      }
      if (s.issues !== prev.issues || s.doc !== prev.doc) syncDiag();
      if (s.selection !== prev.selection || s.doc !== prev.doc) {
        const ranges = selectionRanges(s.doc, s.selection);
        const effects: StateEffect<unknown>[] = [setSelLines.of(ranges)];
        if (s.selection !== prev.selection && !view.hasFocus && ranges[0] && ranges[0].from <= view.state.doc.length) {
          effects.push(EditorView.scrollIntoView(ranges[0].from, { y: 'nearest', yMargin: 48 }));
        }
        view.dispatch({ effects });
      }
    });
    return () => {
      unsub();
      view.destroy();
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(useStore.getState().src);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      useStore.getState().notify('クリップボードにアクセスできませんでした', 'warn');
    }
  };

  return (
    <div className="code-panel" style={{ width: '100%', height: '100%' }}>
      <div className="code-head">
        <span className="code-tab">
          <FileCode size={13} />
          {fileName}
        </span>
        <span className="code-meta">
          {nodeCount} shapes · {edgeCount} arrows · {lineCount} lines
        </span>
        <span className="spacer" />
        <button className="icon-btn tip tip-left" data-tip="テキストをコピー" onClick={copy}>
          {copied ? <Check size={15} color="var(--ok)" /> : <Copy size={15} />}
        </button>
      </div>
      <div className="code-body" ref={host} />
      <div className="code-foot">
        <span>
          <kbd>Ctrl</kbd>+<kbd>Space</kbd> 補完
        </span>
        <span>カーソル行の図形がキャンバスで選択されます</span>
      </div>
    </div>
  );
}
