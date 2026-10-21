import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { hashText } from '../src/hash';

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

/** Image shapes' `src=` read relative to the .charpie file (`dir`), embedded as data: URIs for exports. */
export function embedImages(dir: string, srcs: string[], within?: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const src of srcs) {
    if (/^(https?:|data:)/.test(src)) {
      out.set(src, src);
      continue;
    }
    const abs = path.resolve(dir, src);
    const type = IMAGE_MIME[path.extname(abs).toLowerCase()];
    if (!type || (within && !abs.startsWith(within + path.sep))) continue;
    try {
      out.set(src, `data:${type};base64,${fs.readFileSync(abs).toString('base64')}`);
    } catch {
      /* missing file: drawn as a placeholder */
    }
  }
  return out;
}

/** deleted files go here (dot folder: not listed, not watched) */
const TRASH = '.trash';

export interface BrowserState {
  file: string | null;
  hash: string;
  selection: { nodes: string[]; edges: string[] };
  /** deck: the page / layout on the canvas */
  page?: { page: string } | { layout: string } | null;
  issues: unknown[];
  /** the browser has edits that are not written to disk yet (manual-save mode) */
  unsaved?: boolean;
  at: number;
}

export type ServerEvent =
  | { type: 'change'; file: string; src: string; hash: string }
  | { type: 'files'; files: string[] }
  | { type: 'open'; file: string; page?: string; layout?: string }
  | { type: 'select'; file: string | null; nodes: string[]; edges: string[]; page?: string; layout?: string }
  | { type: 'hello'; root: string };

/** A directory of .charpie files, watched for external edits (e.g. Claude Code). */
export class Workspace {
  readonly root: string;
  private known = new Map<string, string>();
  private clients = new Set<ServerResponse>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: fs.FSWatcher | null = null;
  browser: BrowserState | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Relative, normalized, guaranteed-inside-root path ending in .charpie */
  resolve(name: string): { rel: string; abs: string } {
    let rel = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel.endsWith('.charpie')) rel += '.charpie';
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new HttpError(400, `invalid file name: ${name}`);
    return { rel: path.relative(this.root, abs).split(path.sep).join('/'), abs };
  }

  list(): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(abs, depth + 1);
        else if (e.isFile() && e.name.endsWith('.charpie')) out.push(path.relative(this.root, abs).split(path.sep).join('/'));
      }
    };
    walk(this.root, 0);
    return out.sort();
  }

  exists(name: string): boolean {
    return fs.existsSync(this.resolve(name).abs);
  }

  read(name: string): string {
    const { rel, abs } = this.resolve(name);
    if (!fs.existsSync(abs)) throw new HttpError(404, `file not found: ${rel}`);
    const src = fs.readFileSync(abs, 'utf8');
    this.known.set(rel, src);
    return src;
  }

  /** Atomic write; the watcher will not echo this change back. */
  write(name: string, src: string): string {
    const { rel, abs } = this.resolve(name);
    const isNew = !fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, src);
    fs.renameSync(tmp, abs);
    this.known.set(rel, src);
    if (isNew) this.broadcast({ type: 'files', files: this.list() });
    return rel;
  }

  /**
   * "Delete" = move into `.trash/<time>/<rel>` (hidden from the list and the watcher), so it can be restored.
   * `hash`: refuse when the file changed since the caller last saw it. Pictures in assets/ are left alone
   * (other files may use them).
   */
  trash(name: string, hash?: string): { file: string; trashed: string } {
    const { rel, abs } = this.resolve(name);
    if (!fs.existsSync(abs)) throw new HttpError(404, `file not found: ${rel}`);
    const cur = fs.readFileSync(abs, 'utf8');
    if (hash && hashText(cur) !== hash) throw new HttpError(409, `file changed on disk: ${rel}`, { conflict: true, hash: hashText(cur) });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    let dir = path.join(this.root, TRASH, stamp);
    for (let i = 2; fs.existsSync(path.join(dir, rel)); i++) dir = path.join(this.root, TRASH, `${stamp}-${i}`);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    this.known.delete(rel);
    this.broadcast({ type: 'files', files: this.list() });
    return { file: rel, trashed: path.relative(this.root, dest).split(path.sep).join('/') };
  }

  /** Put a trashed file back where it was; never over an existing file. */
  restore(trashed: string): string {
    const norm = trashed.replace(/\\/g, '/');
    const abs = path.resolve(this.root, norm);
    const base = path.join(this.root, TRASH) + path.sep;
    if (!abs.startsWith(base) || !abs.endsWith('.charpie')) throw new HttpError(400, `invalid trash path: ${trashed}`);
    if (!fs.existsSync(abs)) throw new HttpError(404, `not in trash: ${trashed}`);
    // .trash/<stamp>/<rel>
    const rel = path.relative(base, abs).split(path.sep).slice(1).join('/');
    const { abs: to } = this.resolve(rel);
    if (fs.existsSync(to)) throw new HttpError(409, `already exists: ${rel}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(abs, to);
    try {
      fs.rmdirSync(path.dirname(abs)); // the stamp folder, when empty
    } catch {
      /* not empty */
    }
    this.known.set(rel, fs.readFileSync(to, 'utf8'));
    this.broadcast({ type: 'files', files: this.list() });
    return rel;
  }

  /** An image referenced from `file` (relative to its folder); must stay inside the workspace. */
  asset(file: string, src: string): { abs: string; type: string } {
    const dir = path.dirname(this.resolve(file).abs);
    const abs = path.resolve(dir, src.replace(/\\/g, '/'));
    const ext = path.extname(abs).toLowerCase();
    // a .charpie is served as text: the browser lays it out itself (embedded diagrams)
    const type = ext === '.charpie' ? 'text/plain; charset=utf-8' : IMAGE_MIME[ext];
    if (!abs.startsWith(this.root + path.sep) || !type) throw new HttpError(400, `invalid image path: ${src}`);
    if (!fs.existsSync(abs)) throw new HttpError(404, `image not found: ${src}`);
    return { abs, type };
  }

  /**
   * Save a pasted / dropped image into `assets/` next to `file`. Named by content hash, so pasting the
   * same picture twice reuses one file. Returns the path to write in `src=` (relative to the .charpie).
   */
  saveAsset(file: string, data: Buffer, ext: string, name?: string): string {
    const dir = path.dirname(this.resolve(file).abs);
    const stem = (name ?? '').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const hash = crypto.createHash('sha1').update(data).digest('hex').slice(0, 10);
    const base = `${stem ? stem + '-' : ''}${hash}${ext}`;
    const abs = path.join(dir, 'assets', base);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
    }
    return `assets/${base}`;
  }

  /** Default file for API calls: explicit > browser's open file > the only file. */
  pick(name?: string | null): string {
    if (name) return this.resolve(name).rel;
    if (this.browser?.file && this.exists(this.browser.file)) return this.browser.file;
    const files = this.list();
    if (files.length === 1) return files[0];
    throw new HttpError(400, files.length ? `複数のファイルがあります。?file= で指定してください: ${files.join(', ')}` : 'ファイルがありません。PUT /api/doc?file=name で作成してください');
  }

  // ───────── live updates ─────────

  watch() {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, filename) => {
        if (!filename) return;
        const rel = String(filename).split(path.sep).join('/');
        if (!rel.endsWith('.charpie') || rel.split('/').some((p) => p.startsWith('.'))) return;
        clearTimeout(this.timers.get(rel));
        this.timers.set(
          rel,
          setTimeout(() => this.onFsChange(rel), 40),
        );
      });
    } catch (e) {
      console.warn('[charpie] file watching unavailable:', (e as Error).message);
    }
  }

  private onFsChange(rel: string) {
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs)) {
      this.known.delete(rel);
      this.broadcast({ type: 'files', files: this.list() });
      return;
    }
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      return;
    }
    const prev = this.known.get(rel);
    if (prev === src) return;
    this.known.set(rel, src);
    if (prev === undefined) this.broadcast({ type: 'files', files: this.list() });
    this.broadcast({ type: 'change', file: rel, src, hash: hashText(src) });
  }

  addClient(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', root: this.root } satisfies ServerEvent)}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  get connectedBrowsers() {
    return this.clients.size;
  }

  broadcast(ev: ServerEvent) {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  close() {
    this.watcher?.close();
    for (const c of this.clients) c.end();
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}
