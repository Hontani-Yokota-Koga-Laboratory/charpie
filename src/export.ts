import { diagramBounds } from './components/Diagram';
import type { Layout } from './layout';
import { exportSvg } from './exportFormats';
import { embeddedImages } from './images';

export { exportSvg, exportTikz } from './exportFormats';

/** SVG with the pictures of image shapes embedded, so the file stands alone. */
export async function exportSvgStandalone(layout: Layout, bg: string | null = '#ffffff'): Promise<string> {
  return exportSvg(layout, bg, await embeddedImages(layout));
}

export async function exportPng(layout: Layout, scale = 2, bg = '#ffffff'): Promise<Blob> {
  const svg = await exportSvgStandalone(layout, bg);
  const b = layout.frame ?? diagramBounds(layout);
  const pad = layout.frame ? 0 : 48;
  const w = Math.ceil((b.w + pad) * scale),
    h = Math.ceil((b.h + pad) * scale);
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
    ctx.drawImage(img, 0, 0, w, h);
    return await new Promise<Blob>((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('PNG 変換に失敗しました'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * PDF of a deck through the browser's print dialog ("Save as PDF"): one page per slide, vector,
 * with the app's fonts (the page's stylesheets are copied into the print frame).
 */
export async function printPages(layouts: Layout[], title: string): Promise<void> {
  const f = layouts[0]?.frame ?? { x: 0, y: 0, w: 1280, h: 720 };
  const svgs = await Promise.all(layouts.map((l) => exportSvgStandalone(l)));
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title></head><body>${svgs
      .map((s) => `<section>${s.replace(/^<\?xml[^>]*>\s*/, '')}</section>`)
      .join('')}</body></html>`,
  );
  doc.close();
  for (const el of document.querySelectorAll('style, link[rel="stylesheet"]')) doc.head.appendChild(doc.importNode(el, true));
  const style = doc.createElement('style');
  style.textContent = `@page{size:${f.w}px ${f.h}px;margin:0}html,body{margin:0!important;padding:0!important;background:#fff!important;overflow:visible!important;height:auto!important}section{width:${f.w}px;height:${f.h}px;overflow:hidden;break-after:page}section:last-child{break-after:auto}svg{display:block;width:${f.w}px;height:${f.h}px}`;
  doc.head.appendChild(style);
  await doc.fonts?.ready;
  await new Promise((r) => setTimeout(r, 100));
  frame.contentWindow!.focus();
  frame.contentWindow!.print();
  setTimeout(() => frame.remove(), 60_000);
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
