/**
 * Sync with `charpie serve` (or the Vite dev API):
 * the open .charpie file on disk ⇄ this editor, plus state reports for Claude Code.
 *
 * Disk → editor is always live. Editor → disk is either every change (autoSave)
 * or only on save(); until then the edits are "dirty" and a change made on disk
 * meanwhile is held back as a conflict instead of overwriting them.
 */
import { useStore } from './store';
import { hashText } from './hash';
import { issuesOut } from './check/report';
import { unionBox } from './geom/geom';

let synced = ''; // hash of the text last known to equal the file on disk
let pushTimer: ReturnType<typeof setTimeout> | undefined;
let stateTimer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> = Promise.resolve();
/** latest disk version that arrived while there were unsaved edits */
let incoming: { src: string; hash: string } | null = null;

const LAST_FILE = 'charpie:lastFile';

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-charpie-origin': 'browser', ...(init?.headers ?? {}) } });
  return { status: r.status, body: (await r.json()) as T };
}

export async function initRemote(): Promise<boolean> {
  let health: { ok: boolean; root: string };
  try {
    const r = await fetch('/api/health');
    if (!r.ok) return false;
    health = await r.json();
  } catch {
    return false;
  }
  const st = useStore.getState();
  st.setWorkspace({ on: true, root: health.root, status: 'live' });
  const files = await refreshFiles();

  const fromUrl = new URLSearchParams(location.search).get('file');
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_FILE);
  } catch {
    /* ignore */
  }
  let file: string | undefined = [fromUrl, last].find((f): f is string => !!f && files.includes(f)) ?? files[0];
  if (!file) {
    // empty folder: seed it with whatever is in the editor
    file = (await createFile('diagram', useStore.getState().src)) ?? undefined;
  }
  if (file) await openFile(file);
  connectEvents();
  watchStore();
  return true;
}

export async function refreshFiles(): Promise<string[]> {
  const { body } = await api<{ files: { name: string }[] }>('/api/files');
  const files = body.files.map((f) => f.name);
  useStore.getState().setWorkspace({ files });
  return files;
}

export async function createFile(name: string, src?: string): Promise<string | null> {
  const { status, body } = await api<{ file?: string; error?: string }>('/api/files', { method: 'POST', body: JSON.stringify({ name, src }) });
  if (status >= 400) {
    useStore.getState().notify(body.error ?? '作成に失敗しました', 'warn');
    return null;
  }
  await refreshFiles();
  return body.file!;
}

export async function openFile(file: string) {
  if (useStore.getState().workspace.dirty) {
    if (!confirm('未保存の変更があります。保存してから切り替えますか？\n（キャンセルで切り替えを中止）')) return;
    if (!(await save())) return;
  }
  await flush();
  const { status, body } = await api<{ src: string; hash: string; error?: string }>(`/api/doc?file=${encodeURIComponent(file)}`);
  if (status >= 400) {
    useStore.getState().notify(body.error ?? '開けませんでした', 'warn');
    return;
  }
  synced = body.hash;
  incoming = null;
  const s = useStore.getState();
  s.setWorkspace({ file, dirty: false, conflict: false });
  s.setFileName(file);
  s.clearSelection();
  s.loadExternal(body.src, { resetHistory: true });
  if (useStore.getState().src === body.src) useStore.setState({ past: [], future: [] });
  try {
    localStorage.setItem(LAST_FILE, file);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  url.searchParams.set('file', file);
  history.replaceState(null, '', url);
  requestAnimationFrame(() => fitToCanvas());
  reportState();
}

function fitToCanvas() {
  window.dispatchEvent(new CustomEvent('charpie:fit'));
}

/** Push the current text to disk now. */
export function flush(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = undefined;
    pending = pending.then(() => push()).then(() => {});
  }
  return pending;
}

/** Push the current text now (manual-save mode). Resolves to false if nothing was written. */
export function save(): Promise<boolean> {
  clearTimeout(pushTimer);
  pushTimer = undefined;
  const run = pending.then(() => push(true));
  pending = run.then(() => {});
  return run;
}

/** Throw away unsaved edits and show what is on disk (stays undoable). */
export async function revert() {
  const file = useStore.getState().workspace.file;
  if (!file) return;
  const { body } = await api<{ src: string; hash: string }>(`/api/doc?file=${encodeURIComponent(file)}`);
  synced = body.hash;
  incoming = null;
  useStore.getState().loadExternal(body.src);
  markDirty();
}

function markDirty() {
  const s = useStore.getState();
  const dirty = !!s.workspace.file && hashText(s.src) !== synced;
  if (!dirty && incoming) {
    // edits were undone back to the saved text: now take the newer disk version
    const next = incoming;
    incoming = null;
    synced = next.hash;
    queueMicrotask(() => useStore.getState().loadExternal(next.src));
    return;
  }
  const conflict = dirty && incoming !== null;
  if (dirty !== s.workspace.dirty || conflict !== s.workspace.conflict) s.setWorkspace({ dirty, conflict });
}

async function push(manual = false): Promise<boolean> {
  const s = useStore.getState();
  const file = s.workspace.file;
  if (!file) return false;
  const src = s.src;
  const h = hashText(src);
  if (h === synced) {
    markDirty();
    return true;
  }
  let base = synced;
  if (manual && incoming) {
    // the file changed on disk after our edits began
    if (!confirm(`${file} はこの画面の外（Claude Code など）でも変更されています。\nこの画面の内容で上書きしますか？\n（キャンセルで保存を中止。「外部の版を読み込む」で向こうを採用できます）`)) return false;
    base = incoming.hash;
  }
  s.setWorkspace({ status: 'saving' });
  let ok = false;
  try {
    const { status, body } = await api<{ hash?: string; src?: string; conflict?: boolean; deleted?: boolean; error?: string }>(`/api/doc?file=${encodeURIComponent(file)}`, {
      method: 'PUT',
      body: JSON.stringify({ src, base }),
    });
    if (status === 410 && body.deleted) {
      onDeleted(file);
    } else if (status === 409 && body.conflict && body.src !== undefined) {
      if (manual) {
        // changed on disk between our check and the write: keep the edits, ask again on the next save
        incoming = { src: body.src, hash: body.hash! };
        useStore.getState().notify('ファイルが外部で変更されていました。もう一度保存すると上書きの確認が出ます', 'warn');
      } else {
        synced = body.hash!;
        useStore.getState().loadExternal(body.src);
        useStore.getState().notify('ファイルが外部で変更されていたため、そちらを優先しました（Ctrl+Z で戻せます）', 'warn');
      }
    } else if (status >= 400) {
      useStore.getState().notify(body.error ?? '保存に失敗しました', 'warn');
    } else {
      synced = body.hash ?? h;
      incoming = null;
      ok = true;
    }
    useStore.getState().setWorkspace({ status: 'live' });
  } catch {
    useStore.getState().setWorkspace({ status: 'offline' });
  }
  markDirty();
  reportState();
  return ok;
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    pending = pending.then(() => push()).then(() => {});
  }, 250);
}

/** Let the server (and thus Claude Code) know what the user sees and has selected. */
function reportState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const s = useStore.getState();
    if (!s.workspace.on) return;
    fetch('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: s.workspace.file, hash: hashText(s.src), selection: s.selection, issues: issuesOut(s, s.src), unsaved: s.workspace.dirty }),
    }).catch(() => {});
  }, 200);
}

function watchStore() {
  useStore.subscribe((s, prev) => {
    if (!s.workspace.file) return;
    if (s.src !== prev.src && s.origin !== 'remote' && s.autoSave) schedulePush();
    if (s.src !== prev.src) markDirty();
    if (s.autoSave && !prev.autoSave && s.workspace.dirty && !s.workspace.conflict) schedulePush();
    if (s.src !== prev.src || s.selection !== prev.selection || s.issues !== prev.issues || s.workspace.dirty !== prev.workspace.dirty) reportState();
  });
  window.addEventListener('beforeunload', (e) => {
    const st = useStore.getState();
    if (!st.autoSave && st.workspace.dirty) {
      e.preventDefault();
      return;
    }
    if (pushTimer && useStore.getState().workspace.file) {
      const s = useStore.getState();
      navigator.sendBeacon?.(`/api/doc?file=${encodeURIComponent(s.workspace.file!)}&base=${synced}`, new Blob([s.src], { type: 'text/plain' }));
    }
  });
}

function connectEvents() {
  const es = new EventSource('/api/events');
  let wasDown = false;
  es.onopen = () => {
    useStore.getState().setWorkspace({ status: 'live' });
    if (wasDown) {
      wasDown = false;
      const f = useStore.getState().workspace.file;
      refreshFiles();
      if (f) resync(f);
    }
  };
  es.onerror = () => {
    wasDown = true;
    useStore.getState().setWorkspace({ status: 'offline' });
  };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    const s = useStore.getState();
    switch (ev.type) {
      case 'change': {
        if (ev.file !== s.workspace.file) return;
        if (ev.src === s.src) {
          synced = ev.hash;
          incoming = null;
          markDirty();
          return;
        }
        if (!s.autoSave && s.workspace.dirty) {
          // keep the unsaved edits; let the user choose on save
          incoming = { src: ev.src, hash: ev.hash };
          markDirty();
          s.notify(`${ev.file} が外部で更新されました（未保存の編集があるため読み込んでいません）`, 'warn');
          return;
        }
        // remote wins over a not-yet-sent local edit (it stays in undo history)
        clearTimeout(pushTimer);
        pushTimer = undefined;
        synced = ev.hash;
        incoming = null;
        s.loadExternal(ev.src);
        markDirty();
        s.notify(`${ev.file} が外部で更新されました`);
        return;
      }
      case 'files':
        s.setWorkspace({ files: ev.files });
        if (s.workspace.file && !ev.files.includes(s.workspace.file)) onDeleted(s.workspace.file);
        return;
      case 'open':
        if (ev.file !== s.workspace.file) openFile(ev.file).then(() => s.notify(`${ev.file} を開きました（外部から）`));
        return;
      case 'select': {
        if (ev.file && ev.file !== s.workspace.file) return;
        const nodes = (ev.nodes as string[]).filter((id) => s.doc.nodeMap.has(id));
        const edges = (ev.edges as string[]).filter((k) => s.layout.edgeMap.has(k));
        s.select({ nodes, edges });
        revealSelection(nodes, edges);
        return;
      }
    }
  };
}

/** The open file disappeared from disk: stop syncing it (never recreate it). */
function onDeleted(file: string) {
  clearTimeout(pushTimer);
  pushTimer = undefined;
  synced = '';
  incoming = null;
  const s = useStore.getState();
  s.setWorkspace({ file: null, dirty: false, conflict: false });
  s.notify(`${file} はディスクから削除されました。編集内容はこのタブにだけ残っています`, 'warn');
}

async function resync(file: string) {
  const { body } = await api<{ src: string; hash: string }>(`/api/doc?file=${encodeURIComponent(file)}`);
  const s = useStore.getState();
  if (body.src !== s.src && hashText(s.src) === synced) {
    synced = body.hash;
    s.loadExternal(body.src);
  } else if (body.src !== s.src) {
    if (s.autoSave) schedulePush();
    else if (body.hash !== synced) incoming = { src: body.src, hash: body.hash };
  }
  markDirty();
}

/** Pan so the given items are visible. */
function revealSelection(nodes: string[], edges: string[]) {
  const s = useStore.getState();
  const boxes = [...nodes.map((id) => s.layout.nodeMap.get(id)!.box), ...edges.flatMap((k) => s.layout.edgeMap.get(k)!.pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))];
  const b = unionBox(boxes);
  const el = document.querySelector('.canvas');
  if (!b || !el) return;
  const r = el.getBoundingClientRect();
  const v = s.view;
  const sx = b.x * v.zoom + v.x,
    sy = b.y * v.zoom + v.y;
  const inView = sx > 40 && sy > 40 && sx + b.w * v.zoom < r.width - 40 && sy + b.h * v.zoom < r.height - 40;
  if (!inView) s.setView({ x: r.width / 2 - (b.x + b.w / 2) * v.zoom, y: r.height / 2 - (b.y + b.h / 2) * v.zoom });
}
