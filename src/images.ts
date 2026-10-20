/**
 * Image shapes in the browser: pasted / dropped / picked pictures are uploaded to the
 * server (saved as `assets/<name>-<hash>.png` next to the open .charpie) and inserted as
 * `image imgN at (x, y) size WxH src="assets/..."`. The canvas loads them back through
 * GET /api/asset; exports embed them as data: URIs so the file stands alone.
 */
import { addNodes, uniqueId } from './dsl/patch';
import type { Layout } from './layout';
import type { ImageHref } from './components/Diagram';
import { imageSources } from './exportFormats';
import type { Pt } from './geom/geom';
import { useStore } from './store';

const EXTERNAL = /^(https?:|data:)/;

/** URL the canvas loads an image shape's `src=` from. */
export function assetHref(file: string | null): ImageHref {
  return (src) => (EXTERNAL.test(src) ? src : file ? `/api/asset?file=${encodeURIComponent(file)}&src=${encodeURIComponent(src)}` : undefined);
}

export const isImageFile = (f: File) => /^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/.test(f.type);

/** Longest side of a newly inserted picture (world px); larger ones are scaled down. */
const MAX_SIDE = 320;

async function naturalSize(file: File): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { w: img.naturalWidth || MAX_SIDE, h: img.naturalHeight || MAX_SIDE * 0.75 };
  } catch {
    return { w: MAX_SIDE, h: MAX_SIDE * 0.75 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function upload(file: string, f: File): Promise<string> {
  const r = await fetch(`/api/asset?file=${encodeURIComponent(file)}&name=${encodeURIComponent(f.name || 'pasted')}`, {
    method: 'POST',
    headers: { 'content-type': f.type, 'x-charpie-origin': 'browser' },
    body: f,
  });
  const body = (await r.json()) as { src?: string; error?: string };
  if (!r.ok || !body.src) throw new Error(body.error ?? `upload failed (${r.status})`);
  return body.src;
}

/** World point at the centre of the visible canvas. */
function viewCenter(): Pt {
  const { view } = useStore.getState();
  const el = document.querySelector('.canvas');
  const r = el?.getBoundingClientRect() ?? { width: 800, height: 600 };
  return { x: (r.width / 2 - view.x) / view.zoom, y: (r.height / 2 - view.y) / view.zoom };
}

/** Upload pictures and add them as image shapes centred on `at` (default: the middle of the view). */
export async function insertImages(files: File[], at?: Pt): Promise<void> {
  const s = useStore.getState();
  const imgs = files.filter(isImageFile);
  if (!imgs.length) return;
  const file = s.workspace.on ? s.workspace.file : null;
  if (!file) {
    s.notify('画像の追加は charpie serve（または npm run dev）で開いているときだけ使えます', 'warn');
    return;
  }
  const c = at ?? viewCenter();
  const grid = s.doc.settings.grid;
  const snap = (v: number) => (grid > 0 ? Math.round(v / grid) * grid : Math.round(v));
  const added: string[] = [];
  let offset = 0;
  for (const f of imgs) {
    let src: string;
    try {
      src = await upload(file, f);
    } catch (e) {
      s.notify(`画像を保存できませんでした: ${(e as Error).message}`, 'warn');
      continue;
    }
    const nat = await naturalSize(f);
    const k = Math.min(1, MAX_SIDE / Math.max(nat.w, nat.h));
    const w = Math.max(10, Math.round(nat.w * k)),
      h = Math.max(10, Math.round(nat.h * k));
    const st = useStore.getState();
    // the file may have been switched while uploading
    if (st.workspace.file !== file) return;
    const id = uniqueId(st.doc, 'img');
    st.apply((text, doc) => addNodes(text, doc, [{ kind: 'image', id, x: snap(c.x - w / 2 + offset), y: snap(c.y - h / 2 + offset), w, h, attrs: { src } }]));
    added.push(id);
    offset += 24;
  }
  if (added.length) {
    useStore.getState().select({ nodes: added });
    useStore.getState().notify(`画像を ${added.length} 枚追加しました（assets/ に保存）`, 'ok');
  }
}

/** Let the user pick picture files, then insert them. */
export function pickImages(at?: Pt) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => insertImages([...(input.files ?? [])], at);
  input.click();
}

/** For exports: every image of the layout fetched and turned into a data: URI. */
export async function embeddedImages(layout: Layout): Promise<ImageHref> {
  const href = assetHref(useStore.getState().workspace.file);
  const out = new Map<string, string>();
  await Promise.all(
    imageSources(layout).map(async (src) => {
      const url = href(src);
      if (!url) return;
      if (url.startsWith('data:')) return void out.set(src, url);
      try {
        const blob = await (await fetch(url)).blob();
        out.set(src, await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result as string);
          fr.onerror = () => rej(fr.error);
          fr.readAsDataURL(blob);
        }));
      } catch {
        /* unreachable picture: exported as a placeholder */
      }
    }),
  );
  return (src) => out.get(src);
}
