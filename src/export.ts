import { diagramBounds } from './components/Diagram';
import type { Layout } from './layout';
import { exportSvg } from './exportFormats';

export { exportSvg, exportTikz } from './exportFormats';

export async function exportPng(layout: Layout, scale = 2, bg = '#ffffff'): Promise<Blob> {
  const svg = exportSvg(layout, bg);
  const b = diagramBounds(layout);
  const w = Math.ceil((b.w + 48) * scale),
    h = Math.ceil((b.h + 48) * scale);
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
