import { useEffect, useRef, useState } from 'react';
import { Canvas } from './components/Canvas';
import { CodePanel } from './components/CodePanel';
import { Inspector } from './components/Inspector';
import { HealthPanel, Help, Toast, TopBar, ZoomBar, doOpen, doSave, fitAll } from './components/Chrome';
import { TOOL_KEYS, Toolbar, setPaletteOpen } from './components/Tools';
import { useStore } from './store';
import { extractText, pasteText, removeItems } from './dsl/patch';
import { translate } from './ops/arrange';
import { clearMeasureCache } from './text/fit';
import { initRemote } from './remote';
import { useMobile } from './useMobile';
import { MobileSheet } from './components/MobileSheet';
import { deleteSelection, duplicateSelection } from './actions';
import { insertImages, isImageFile } from './images';
import { LayoutBanner, PagesPanel, Presenter } from './components/Pages';

function isTyping(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName) || !!t.closest('.cm-editor'));
}

let clipboard = '';

function useShortcuts(openHelp: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // global (work even in the editor)
      if (mod && k === 's') {
        e.preventDefault();
        doSave(e.shiftKey);
        return;
      }
      if (mod && k === 'o') {
        e.preventDefault();
        doOpen();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === 'F5' && s.doc.deck) {
        e.preventDefault();
        s.setPresenting(true);
        return;
      }
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        s.select({ nodes: s.doc.nodes.filter((n) => !n.locked).map((n) => n.id), edges: s.doc.edges.filter((e) => !e.locked).map((e) => e.key) });
        return;
      }
      const sel = s.selection;
      if (mod && (k === 'c' || k === 'x')) {
        if (!sel.nodes.length && !sel.edges.length) return;
        clipboard = extractText(s.src, s.doc, sel.nodes, sel.edges);
        navigator.clipboard?.writeText(clipboard).catch(() => {});
        if (k === 'x') s.apply((src, doc) => removeItems(src, doc, sel.nodes, sel.edges));
        e.preventDefault();
        return;
      }
      if (mod && k === 'd') {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.nodes.length || sel.edges.length) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (e.key === 'Escape') {
        s.clearSelection();
        s.setTool('select');
        s.setFocusIssue(null);
        return;
      }
      if (e.key === 'Enter' && sel.nodes.length === 1) {
        e.preventDefault();
        s.setEditing({ type: 'node', id: sel.nodes[0] });
        return;
      }
      if (e.key.startsWith('Arrow') && sel.nodes.length) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        s.setSource(translate(s.src, s.doc, sel.nodes, dx, dy), { history: 'coalesce' });
        return;
      }
      if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) {
        fitAll();
        return;
      }
      if (e.key === '?') {
        openHelp();
        return;
      }
      if (e.key === '/' && !mod) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (!mod && !e.altKey && TOOL_KEYS[k]) {
        s.setTool(TOOL_KEYS[k]);
      }
    };
    // Ctrl+V is handled as a paste event: it carries both copied shapes (text) and pictures
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])].filter(isImageFile);
      e.preventDefault();
      if (files.length) {
        insertImages(files);
        return;
      }
      const text = e.clipboardData?.getData('text/plain') || clipboard;
      const st = useStore.getState();
      const r = pasteText(st.src, st.doc, text, 24, 24);
      if (!r.ids.length) return;
      st.setSource(r.src);
      st.select({ nodes: r.ids });
      clipboard = extractText(r.src, useStore.getState().doc, r.ids);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [openHelp]);
}

export function App() {
  const theme = useStore((s) => s.theme);
  const viewMode = useStore((s) => s.viewMode);
  const codeWidth = useStore((s) => s.codeWidth);
  const isDeck = useStore((s) => !!s.doc.deck);
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);
  useShortcuts(() => setHelp(true));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    initRemote();
  }, []);

  // re-measure text once web fonts are ready (canvas metrics depend on them)
  useEffect(() => {
    document.fonts?.ready.then(() => {
      clearMeasureCache();
      useStore.getState().remeasure();
    });
  }, []);

  const startSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const r = mainRef.current!.getBoundingClientRect();
      useStore.getState().setCodeWidth(r.right - ev.clientX);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const mobile = useMobile();
  // phones: one pane at a time
  const mode = mobile && viewMode === 'split' ? 'canvas' : viewMode;
  const showCanvas = mode !== 'code';
  const showCode = mode !== 'canvas';

  return (
    <div className={'app' + (mobile ? ' mobile' : '')}>
      <TopBar onHelp={() => setHelp(true)} />
      <div className="main" ref={mainRef}>
        {showCanvas && isDeck && !mobile && <PagesPanel />}
        {showCanvas && (
          <div className="canvas-wrap">
            <Canvas />
            <LayoutBanner />
            <Toolbar />
            <ZoomBar />
            <HealthPanel />
          </div>
        )}
        {showCanvas && !mobile && (
          <aside className="inspector-dock">
            <Inspector />
          </aside>
        )}
        {showCanvas && mobile && <MobileSheet />}
        {showCanvas && showCode && <div className={'splitter' + (dragging ? ' dragging' : '')} onPointerDown={startSplit} />}
        {showCode && (
          <div style={{ width: showCanvas ? codeWidth : '100%', flex: 'none', minWidth: 0, display: 'flex' }}>
            <CodePanel />
          </div>
        )}
      </div>
      <Toast />
      <Presenter />
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
