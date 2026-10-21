/**
 * Embedded diagrams in the browser: `image ... src="other.charpie"` is fetched through /api/asset
 * (relative to the file that names it), cached, and laid out inline. A change to that file on disk
 * (SSE) refreshes it.
 */
import { setEmbedResolver } from './layout';
import { useStore } from './store';

/** workspace-relative path → text (null: could not be read) */
const cache = new Map<string, string | null>();
const pending = new Set<string>();

function join(from: string, src: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const p of src.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}

async function load(from: string, src: string, key: string) {
  if (pending.has(key)) return;
  pending.add(key);
  try {
    const r = await fetch(`/api/asset?file=${encodeURIComponent(from)}&src=${encodeURIComponent(src)}`);
    cache.set(key, r.ok ? await r.text() : null);
  } catch {
    cache.set(key, null);
  } finally {
    pending.delete(key);
  }
  useStore.getState().remeasure();
}

export function initEmbeds() {
  setEmbedResolver((src, base) => {
    const from = base ?? useStore.getState().workspace.file;
    if (!from || !useStore.getState().workspace.on || /^(https?:|data:)/.test(src)) return undefined;
    const key = join(from, src);
    const text = cache.get(key);
    if (text === undefined) {
      void load(from, src, key);
      return undefined;
    }
    return text === null ? undefined : { text, base: key };
  });
}

/** Another file changed on disk: if it is embedded somewhere, redraw with the new text. */
export function embedChanged(file: string, src: string) {
  if (!cache.has(file) || cache.get(file) === src) return;
  cache.set(file, src);
  useStore.getState().remeasure();
}
