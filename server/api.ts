import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashText } from '../src/hash';
import fs from 'node:fs';
import path from 'node:path';
import { exportSvg, exportTikz, imageSources } from '../src/exportFormats';
import { analyze, applyOps, issuesAll, measureNodes, summarize, viewParam, type IssueOut, type Op } from './core';
import { views } from '../src/dsl/parse';
import { setEmbedResolver } from '../src/layout';
import { fileResolver } from './embed';
import { helpText } from './help';
import { fontMeasure } from './measure';
import { embedImages, HttpError, IMAGE_MIME, type BrowserState, type Workspace } from './workspace';

type Next = (err?: unknown) => void;

const NEW_FILE = `# 新しい図
set gap=12 grid=10

`;

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBytes(req, 5_000_000)).toString('utf8');
}

const EXT_OF_MIME: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_MIME).filter(([e]) => e !== '.jpeg').map(([e, t]) => [t, e]));

function json<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/**
 * Issues for a file: the browser's (exact canvas metrics) when it has this exact text open, else server-computed.
 * Decks are always checked here, page by page (the browser only checks the page it shows).
 */
function currentIssues(ws: Workspace, file: string, src: string): { source: 'browser' | 'server'; issues: IssueOut[] } {
  const b = ws.browser;
  const deck = views(src)[0] !== undefined;
  if (!deck && b && b.file === file && b.hash === hashText(src) && Date.now() - b.at < 10 * 60_000) return { source: 'browser', issues: b.issues as IssueOut[] };
  return { source: 'server', issues: issuesAll(src, fontMeasure, ws.resolve(file).abs).issues };
}

function writeResult(ws: Workspace, file: string, src: string, created: string[] = []) {
  const { issues, source } = currentIssues(ws, file, src);
  const errors = issues.filter((i) => i.severity === 'error').length;
  return { ok: true, file, hash: hashText(src), created, errors, issuesSource: source, issues };
}

export function createApi(ws: Workspace) {
  // embedded diagrams resolve inside the workspace only
  setEmbedResolver(fileResolver(ws.root));
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api')) return next();
    const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/api'}`;
    const q = url.searchParams;
    try {
      switch (route) {
        case 'GET /api':
        case 'GET /api/help':
          return send(res, 200, helpText(`http://${req.headers.host ?? 'localhost'}`, ws.root), 'text/markdown; charset=utf-8');

        case 'GET /api/health':
          return send(res, 200, { ok: true, root: ws.root, browsers: ws.connectedBrowsers, file: ws.browser?.file ?? null });

        case 'GET /api/files':
          return send(res, 200, {
            root: ws.root,
            open: ws.browser?.file ?? null,
            files: ws.list().map((name) => {
              const src = ws.read(name);
              const a = analyze(src, fontMeasure);
              return { name, nodes: a.doc.nodes.length, edges: a.doc.edges.length, pages: a.doc.deck?.pages.length ?? null, errors: issuesAll(src, fontMeasure).issues.filter((i) => i.severity === 'error').length };
            }),
          });

        case 'POST /api/files': {
          const body = json<{ name: string; src?: string }>(await readBody(req));
          if (!body.name) throw new HttpError(400, 'name is required');
          if (ws.exists(body.name)) throw new HttpError(409, `already exists: ${body.name}`);
          const file = ws.write(body.name, body.src ?? NEW_FILE);
          return send(res, 201, { ok: true, file });
        }

        case 'GET /api/doc': {
          const file = ws.pick(q.get('file'));
          const src = ws.read(file);
          const s = summarize(src, analyze(src, fontMeasure, viewParam(q), ws.resolve(file).abs));
          const ci = currentIssues(ws, file, src);
          return send(res, 200, { file, hash: hashText(src), ...s, issues: ci.issues, issuesSource: ci.source });
        }

        case 'POST /api/doc': // sendBeacon on page unload
        case 'PUT /api/doc': {
          const file = ws.pick(q.get('file') ?? undefined);
          const raw = await readBody(req);
          const body = (req.headers['content-type'] ?? '').includes('json') ? json<{ src: string; base?: string }>(raw) : { src: raw, base: q.get('base') ?? undefined };
          if (typeof body.src !== 'string') throw new HttpError(400, 'src is required');
          // a client that saw this file before must not resurrect it after it was deleted
          if (body.base && !ws.exists(file)) throw new HttpError(410, `file was deleted: ${file}`, { deleted: true });
          // optimistic concurrency: refuse if the file changed since the caller last saw it
          if (body.base && ws.exists(file)) {
            const cur = ws.read(file);
            if (hashText(cur) !== body.base && cur !== body.src) throw new HttpError(409, 'file changed on disk', { conflict: true, src: cur, hash: hashText(cur) });
          }
          const origin = req.headers['x-charpie-origin'] === 'browser' ? 'browser' : 'api';
          ws.write(file, body.src);
          if (origin !== 'browser') ws.broadcast({ type: 'change', file, src: body.src, hash: hashText(body.src) });
          return send(res, 200, writeResult(ws, file, body.src));
        }

        case 'GET /api/measure': {
          const file = ws.pick(q.get('file'));
          return send(res, 200, { file, nodes: measureNodes(analyze(ws.read(file), fontMeasure, viewParam(q), ws.resolve(file).abs), fontMeasure) });
        }

        case 'GET /api/issues': {
          const file = ws.pick(q.get('file'));
          const src = ws.read(file);
          const ci = currentIssues(ws, file, src);
          return send(res, 200, { file, ...ci, errors: ci.issues.filter((i) => i.severity === 'error').length });
        }

        case 'POST /api/ops': {
          const file = ws.pick(q.get('file'));
          const body = json<Op | Op[] | { ops: Op[] }>(await readBody(req));
          const ops = Array.isArray(body) ? body : 'ops' in body ? body.ops : [body];
          const before = ws.read(file);
          const { src, created } = applyOps(before, ops, fontMeasure, viewParam(q));
          if (q.get('strict')) {
            const errs = (s: string) => issuesAll(s, fontMeasure).issues.filter((i) => i.severity === 'error').length;
            const nb = errs(before),
              na = errs(src);
            if (na > nb) throw new HttpError(409, `rejected: errors would increase ${nb} → ${na}`, { issues: issuesAll(src, fontMeasure).issues, preview: src });
          }
          if (src !== before) {
            ws.write(file, src);
            ws.broadcast({ type: 'change', file, src, hash: hashText(src) });
          }
          return send(res, 200, { ...writeResult(ws, file, src, created), changed: src !== before });
        }

        case 'GET /api/export': {
          const file = ws.pick(q.get('file'));
          const a = analyze(ws.read(file), fontMeasure, viewParam(q), ws.resolve(file).abs);
          const fmt = q.get('format') ?? 'svg';
          if (fmt === 'svg') {
            const images = embedImages(path.dirname(ws.resolve(file).abs), imageSources(a.layout), ws.root);
            return send(res, 200, exportSvg(a.layout, q.get('bg') === 'none' ? null : '#ffffff', (s) => images.get(s)), 'image/svg+xml; charset=utf-8');
          }
          if (fmt === 'tikz') return send(res, 200, exportTikz(a.layout), 'text/x-tex; charset=utf-8');
          throw new HttpError(400, 'format must be svg or tikz');
        }

        // images: `src=` is relative to the .charpie file
        case 'GET /api/asset': {
          const src = q.get('src');
          if (!src) throw new HttpError(400, 'src is required');
          const { abs, type } = ws.asset(ws.pick(q.get('file')), src);
          res.statusCode = 200;
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', 'no-cache');
          fs.createReadStream(abs).pipe(res);
          return;
        }

        case 'POST /api/asset': {
          const file = ws.pick(q.get('file'));
          const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const ext = EXT_OF_MIME[type];
          if (!ext) throw new HttpError(415, `unsupported image type: ${type || '(none)'}（${Object.keys(EXT_OF_MIME).join(', ')}）`);
          const data = await readBytes(req, 30_000_000);
          if (!data.length) throw new HttpError(400, 'empty body');
          const src = ws.saveAsset(file, data, ext, q.get('name') ?? undefined);
          return send(res, 201, { ok: true, file, src });
        }

        case 'GET /api/selection':
          return send(res, 200, ws.browser ? { file: ws.browser.file, ...ws.browser.selection, ...(ws.browser.page ? ws.browser.page : {}), unsaved: !!ws.browser.unsaved, at: new Date(ws.browser.at).toISOString() } : { file: null, nodes: [], edges: [], note: 'no browser connected' });

        case 'POST /api/open': {
          const body = json<{ file: string; page?: string; layout?: string }>(await readBody(req));
          const file = ws.resolve(body.file).rel;
          if (!ws.exists(file)) throw new HttpError(404, `file not found: ${file}`);
          ws.broadcast({ type: 'open', file, page: body.page, layout: body.layout });
          return send(res, 200, { ok: true, file, browsers: ws.connectedBrowsers });
        }

        case 'POST /api/select': {
          const body = json<{ nodes?: string[]; edges?: string[]; file?: string; page?: string; layout?: string }>(await readBody(req));
          ws.broadcast({ type: 'select', file: body.file ?? null, nodes: body.nodes ?? [], edges: body.edges ?? [], page: body.page, layout: body.layout });
          return send(res, 200, { ok: true, browsers: ws.connectedBrowsers });
        }

        // ── browser channel
        case 'GET /api/events':
          ws.addClient(res);
          return;
        case 'POST /api/state': {
          const body = json<Omit<BrowserState, 'at'>>(await readBody(req));
          ws.browser = { ...body, at: Date.now() };
          return send(res, 200, { ok: true });
        }
        default:
          throw new HttpError(404, `no such endpoint: ${route}  (GET /api for help)`);
      }
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { ok: false, error: e.message, ...(e.body as object) });
      console.error('[charpie]', e);
      return send(res, 500, { ok: false, error: (e as Error).message });
    }
  };
}
