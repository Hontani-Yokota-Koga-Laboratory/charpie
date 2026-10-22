/**
 * `family=` fonts in the browser: the server answers with @font-face rules for the very files
 * `check` measures with (GET /api/fonts). Japanese fonts come in unicode-range subsets, so the
 * subsets holding the diagram's characters are loaded before measuring; then the layout is redone.
 */
import { useEffect, useState } from 'react';
import { setFontLookup } from './check/check';
import type { Layout } from './layout';
import { clearMeasureCache } from './text/fit';
import { eastAsianFor } from './text/office';
import { useStore } from './store';

/** family → found on the server (undefined while asking) */
const known = new Map<string, boolean | undefined>();
/** `family|weight` → characters already loaded */
const loaded = new Map<string, Set<string>>();

setFontLookup((f) => known.get(f));

function collect(layout: Layout): Map<string, { weights: Set<number>; text: string }> {
  const out = new Map<string, { weights: Set<number>; text: string }>();
  const add = (family: string | undefined, weight: number, text: string): void => {
    if (!family || !text) return;
    // its Japanese is drawn in the partner font (fontStack)
    const ea = eastAsianFor(family);
    if (ea) add(ea, weight, text);
    if (!out.has(family)) out.set(family, { weights: new Set([700]), text: '' });
    const e = out.get(family)!;
    e.weights.add(weight);
    e.text += text;
  };
  const walk = (l: Layout) => {
    for (const n of l.nodes) {
      if (n.embed) walk(n.embed.layout);
      add(n.style.family, n.style.weight, n.blocks ? (n.def.body?.text ?? '') : n.def.label);
    }
    for (const e of l.edges) add(e.style.family, 500, e.def.label);
  };
  walk(layout);
  return out;
}

async function request(file: string, families: string[]) {
  for (const f of families) known.set(f, undefined);
  try {
    const q = new URLSearchParams({ file });
    for (const f of families) q.append('family', f);
    const r = await fetch(`/api/fonts?${q}`);
    if (!r.ok) throw new Error(String(r.status));
    const { css, missing } = (await r.json()) as { css: string; missing: string[] };
    const el = document.createElement('style');
    el.dataset.charpieFonts = families.join(',');
    el.textContent = css;
    document.head.appendChild(el);
    for (const f of families) known.set(f, !missing.includes(f));
  } catch {
    for (const f of families) known.delete(f);
  }
}

let busy = false;
/** a call came in while busy (an edit, or the re-measure below): run again on the latest layout */
let again = false;
/** Make sure the fonts (and subsets) a layout needs are loaded; re-measure when something new arrived. */
export async function ensureFonts(layout: Layout) {
  const ws = useStore.getState().workspace;
  if (busy) {
    again = true;
    return;
  }
  if (!ws.on || !ws.file || typeof document === 'undefined' || !document.fonts) return;
  const need = collect(layout);
  if (!need.size) return;
  busy = true;
  try {
    const fresh = [...need.keys()].filter((f) => !known.has(f));
    if (fresh.length) await request(ws.file, fresh);
    const loads: Promise<unknown>[] = [];
    for (const [family, { weights, text }] of need) {
      if (!known.get(family)) continue;
      for (const w of weights) {
        const k = `${family}|${w}`;
        const have = loaded.get(k) ?? new Set<string>();
        const add = [...new Set(text)].filter((c) => !have.has(c) && c.trim());
        if (!add.length) continue;
        for (const c of add) have.add(c);
        loaded.set(k, have);
        loads.push(document.fonts.load(`${w} 100px '${family}'`, add.join('')).catch(() => []));
      }
    }
    if (fresh.length || loads.length) {
      await Promise.all(loads);
      clearMeasureCache();
      useStore.getState().remeasure();
    }
  } finally {
    busy = false;
  }
  if (again) {
    again = false;
    void ensureFonts(useStore.getState().layout);
  }
}

/** Self-contained @font-face rules for an exported SVG (the browser cannot load fonts for an <img>). */
export async function fontCssFor(svg: string): Promise<string> {
  const ws = useStore.getState().workspace;
  if (!ws.on || !/font-family="(?:'|&#x27;)(?!Inter)/.test(svg)) return '';
  try {
    const r = await fetch('/api/fonts/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: ws.file, svg }) });
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  }
}

/** file → family names the server can serve (GET /api/fonts/list) */
const lists = new Map<string, Promise<string[]>>();

/** Families the font menu offers for the open file; empty without a server. */
export function useFamilies(): string[] {
  const file = useStore((st) => (st.workspace.on ? st.workspace.file : null));
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!file) return setNames([]);
    let p = lists.get(file);
    if (!p) {
      p = fetch(`/api/fonts/list?${new URLSearchParams({ file })}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ families: string[] }>) : { families: [] }))
        .then((j) => j.families)
        .catch(() => {
          lists.delete(file);
          return [];
        });
      lists.set(file, p);
    }
    let live = true;
    p.then((v) => live && setNames(v));
    return () => {
      live = false;
    };
  }, [file]);
  return names;
}
