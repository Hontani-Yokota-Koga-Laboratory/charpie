import { diagramBounds } from './components/Diagram';
import type { Layout } from './layout';
import { exportSvg } from './exportFormats';
import { embeddedImages } from './images';
import { fontCssFor } from './fonts';
import { withEmbeds } from './embeds';
import { jpegPdf, type PdfPage } from './pdf';

export { exportSvg, exportTikz, exportTikzDeck } from './exportFormats';

/** SVG with the pictures of image shapes embedded, so the file stands alone. */
export async function exportSvgStandalone(layout: Layout, bg: string | null = '#ffffff'): Promise<string> {
  const svg = exportSvg(layout, bg, await embeddedImages(layout));
  // family= fonts travel inside the file (an SVG drawn as an image cannot load them)
  const css = await fontCssFor(svg);
  return css ? svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style>${css}</style>`) : svg;
}

/** The exported picture's size in CSS px: the page of a slide, else the diagram plus a margin. */
function pictureSize(layout: Layout): { w: number; h: number } {
  const b = layout.frame ?? diagramBounds(layout);
  const pad = layout.frame ? 0 : 48;
  return { w: b.w + pad, h: b.h + pad };
}

async function rasterize(layout: Layout, scale: number, bg: string, type: 'image/png' | 'image/jpeg'): Promise<{ blob: Blob; w: number; h: number }> {
  const svg = await exportSvgStandalone(layout, bg);
  const size = pictureSize(layout);
  const w = Math.ceil(size.w * scale),
    h = Math.ceil(size.h * scale);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('SVG の描画に失敗しました'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    if (type === 'image/jpeg') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('画像への変換に失敗しました'))), type, 0.92));
    return { blob, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportPng(layout: Layout, scale = 2, bg = '#ffffff'): Promise<Blob> {
  return (await rasterize(layout, scale, bg, 'image/png')).blob;
}

/**
 * PDF of the open file: every page of a deck, else the diagram. The server renders it as vector
 * (headless Chromium, the same as `charpie export -o x.pdf`) from the text as it is now, saved or not;
 * without it, the pages are drawn here as pictures. Either way the page is exactly the slide — no
 * print dialog, so no margins or scaling that depend on the browser.
 */
export async function exportPdf(file: string | null, src: string, layouts: () => Layout[]): Promise<{ pdf: Blob; vector: boolean }> {
  if (file) {
    try {
      const r = await fetch('/api/export/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file, src }) });
      if (r.ok) return { pdf: await r.blob(), vector: true };
      console.warn('[charpie] server PDF failed:', ((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status);
    } catch (e) {
      console.warn('[charpie] server PDF failed:', e);
    }
  }
  const ls = await withEmbeds(layouts);
  const pages: PdfPage[] = [];
  for (const l of ls) {
    const { blob, w, h } = await rasterize(l, 2, '#ffffff', 'image/jpeg');
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), px: { w, h }, size: pictureSize(l) });
  }
  return { pdf: jpegPdf(pages, file?.replace(/^.*\//, '').replace(/\.charpie$/, '') ?? ''), vector: false };
}

// ───────────── file helpers ─────────────

export function download(name: string, data: Blob | string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type FileHandle = { name: string; createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>; getFile(): Promise<File> };
let handle: FileHandle | null = null;
const w = window as unknown as {
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
};
const PICKER_TYPES = [{ description: 'Charpie diagram', accept: { 'text/plain': ['.charpie', '.txt'] } }];

/** Save to the current file handle (File System Access API) or download. */
export async function saveFile(name: string, text: string, saveAs = false): Promise<string | null> {
  if (w.showSaveFilePicker) {
    try {
      if (!handle || saveAs) handle = await w.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES });
      const ws = await handle.createWritable();
      await ws.write(text);
      await ws.close();
      return handle.name;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  download(name, text);
  return name;
}

export async function openFile(): Promise<{ name: string; text: string } | null> {
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: PICKER_TYPES });
      handle = h;
      const file = await h.getFile();
      return { name: file.name, text: await file.text() };
    } catch (e) {
      if ((e as Error).name === 'AbortError') return null;
    }
  }
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.charpie,.txt,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      res(file ? { name: file.name, text: await file.text() } : null);
    };
    input.click();
  });
}

export function resetFileHandle() {
  handle = null;
}
