import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { setEdgeLabel, setNodeBody, setNodeLabel, setNodesKind } from '../dsl/patch';
import { reparse, useStore } from '../store';
import { LINE_HEIGHT, fontStack } from '../text/fit';
import { dropEmptySlot, ListEditor, TableEditor } from './BlockEditors';

/** In-place editing: a label, or a table / list (as it is drawn, or its `{ ... }` lines). */
export function InlineEditor() {
  const editing = useStore((s) => s.editing)!;
  const kind = useStore((s) => (editing.type === 'node' && s.layout.nodeMap.get(editing.id)?.blocks ? s.layout.nodeMap.get(editing.id)!.kind : undefined));
  if (kind) return <BlockEditing key={editing.id} id={editing.id} kind={kind} />;
  return <LabelEditor />;
}

function BlockEditing({ id, kind }: { id: string; kind: string }) {
  const [source, setSource] = useState(false);
  if (source) return <BlockEditor id={id} />;
  return kind === 'table' ? <TableEditor id={id} onSource={() => setSource(true)} /> : <ListEditor id={id} onSource={() => setSource(true)} />;
}

/** The body of a table / list as plain lines over the shape; typing updates the canvas live. */
function BlockEditor({ id }: { id: string }) {
  const view = useStore((s) => s.view);
  const node = useStore((s) => s.layout.nodeMap.get(id));
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.value = useStore.getState().doc.nodeMap.get(id)?.body?.text ?? '';
    el.focus();
    done.current = false;
    // coming from the editor drawn in place: the same gesture goes on
    if (useStore.getState().gestureBase === null) useStore.getState().beginGesture();
  }, [id]);
  useEffect(() => {
    if (!node) useStore.getState().setEditing(null);
  }, [node]);
  if (!node) return null;

  const live = () => {
    const s = useStore.getState();
    if (s.gestureBase === null) return;
    s.setSource(setNodeBody(s.src, s.doc, id, ref.current?.value ?? ''), { history: 'none' });
  };
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const s = useStore.getState();
    if (save) {
      live();
      dropEmptySlot(id);
    } else if (s.gestureBase !== null) s.setSource(s.gestureBase, { history: 'none' });
    s.endGesture();
    s.setEditing(null);
  };
  const z = view.zoom;
  const b = node.box;
  const fontSize = Math.max(12, Math.min(16, node.text.size * z * 0.8));
  return (
    <div className="inline-editor block-editor" style={{ left: view.x + b.x * z, top: view.y + b.y * z, width: Math.max(320, b.w * z), height: Math.max(160, b.h * z) }}>
      <textarea
        ref={ref}
        spellCheck={false}
        style={{ fontSize }}
        placeholder={node.kind === 'table' ? '| 見出し | 見出し |\n|---|---|\n| a | b |' : '- 項目\n  - 入れ子'}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            commit(false);
          } else if (e.key === 'Tab') {
            // indent / outdent the current line (lists nest by two spaces)
            e.preventDefault();
            const el = e.currentTarget;
            const start = el.value.lastIndexOf('\n', el.selectionStart - 1) + 1;
            if (e.shiftKey) {
              const cut = /^ {1,2}/.exec(el.value.slice(start))?.[0].length ?? 0;
              if (!cut) return;
              const pos = el.selectionStart;
              el.setRangeText('', start, start + cut, 'preserve');
              el.selectionStart = el.selectionEnd = Math.max(start, pos - cut);
            } else {
              const pos = el.selectionStart;
              el.setRangeText('  ', start, start, 'preserve');
              el.selectionStart = el.selectionEnd = pos + 2;
            }
            live();
          }
        }}
        onInput={live}
        onBlur={() => commit(true)}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <div className="block-editor-hint">Ctrl+Enter で確定 · Esc で取消 · Tab で字下げ</div>
    </div>
  );
}

/** contentEditable overlay used to edit node / edge labels in place. */
function LabelEditor() {
  const editing = useStore((s) => s.editing)!;
  const view = useStore((s) => s.view);
  const layout = useStore((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const composing = useRef(false);

  const node = editing.type === 'node' ? layout.nodeMap.get(editing.id) : undefined;
  const edge = editing.type === 'edge' ? layout.edgeMap.get(editing.id) : undefined;
  const initial = (node && (node.def.labelSource ?? node.def.label)) ?? edge?.def.label ?? '';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerText = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    done.current = false;
    // typing updates the diagram live; the whole edit is one undo step
    useStore.getState().beginGesture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing.id, editing.type]);

  useEffect(() => {
    if (!node && !edge) useStore.getState().setEditing(null);
  }, [node, edge]);

  if (!node && !edge) return null;

  const current = () => (ref.current?.innerText ?? '').replace(/\n$/, '');
  const live = () => {
    const s = useStore.getState();
    if (s.gestureBase === null) return; // replaced from outside meanwhile
    const text = current();
    // `- ` / `1. ` typed at the start of a text shape turns it into a list (edited as one from here on)
    const def = node && s.doc.nodeMap.get(node.id);
    if (def && def.kind === 'text' && !def.locked && def.spans.kind && /^([-*+]|\d+[.)]) /.test(text)) {
      done.current = true;
      let src = setNodesKind(s.src, s.doc, [def.id], 'list');
      src = setNodeLabel(src, reparse(src), def.id, '');
      src = setNodeBody(src, reparse(src), def.id, text);
      s.setSource(src, { history: 'none' });
      s.setEditing({ type: 'node', id: def.id });
      return;
    }
    const next = editing.type === 'node' ? setNodeLabel(s.src, s.doc, editing.id, text) : setEdgeLabel(s.src, s.doc, editing.id, text);
    s.setSource(next, { history: 'none' });
  };
  const commit = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const s = useStore.getState();
    if (save) live();
    else if (s.gestureBase !== null) s.setSource(s.gestureBase, { history: 'none' });
    // a slot left empty goes back to being a placeholder (drop the bare `slot ""` line)
    if (editing.type === 'node') dropEmptySlot(editing.id);
    s.endGesture();
    s.setEditing(null);
  };

  const z = view.zoom;
  let rect: { x: number; y: number; w: number; h: number };
  let fontSize: number;
  let color = '#0f172a';
  let weight = 500;
  let family: string | undefined;
  if (node) {
    const tb = node.textBox;
    // rotated labels are edited horizontally, centred on the text area
    const sideways = node.style.rotate === 90 || node.style.rotate === 270;
    const w = sideways ? tb.h : tb.w,
      h = sideways ? tb.w : tb.h;
    rect = { x: view.x + (tb.x + tb.w / 2 - w / 2) * z, y: view.y + (tb.y + tb.h / 2 - h / 2) * z, w: w * z, h: h * z };
    fontSize = node.text.size * z;
    color = node.style.text;
    weight = node.style.weight;
    family = node.style.family;
  } else {
    const c = edge!.label?.center ?? edge!.pts[Math.floor(edge!.pts.length / 2)];
    const w = 240 * z;
    rect = { x: view.x + c.x * z - w / 2, y: view.y + c.y * z - 30 * z, w, h: 60 * z };
    fontSize = edge!.style.font * z;
    family = edge!.style.family;
  }

  return (
    <div className="inline-editor" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={{ fontSize, fontFamily: fontStack(family), lineHeight: LINE_HEIGHT, color, fontWeight: weight }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit(true);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            commit(false);
          }
        }}
        onInput={() => {
          if (!composing.current) live();
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          live();
        }}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onBlur={() => commit(true)}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
