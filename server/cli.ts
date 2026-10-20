#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, applyOps, issuesOut, measureNodes, type NodeMeasure } from './core';
import { createApi } from './api';
import { fontMeasure } from './measure';
import { svgToPng } from './png';
import { Workspace } from './workspace';
import { exportSvg, exportTikz } from '../src/exportFormats';

const HELP = `charpie — text-first diagram editor

Usage:
  charpie serve [dir] [--port 5173] [--host]   UI + API + live file sync for *.charpie in dir (default: .)
  charpie check <file...> [--json]             report overlaps / overflow / arrows through shapes (exit 1 on errors)
  charpie fix <file...>                        auto-resolve layout problems in place
  charpie measure <file...> [--json]           per shape: font size, text block vs box (slack), and the
                                               smallest box that still fits the label as written (fit)
  charpie export <file> [--format svg|tikz|png] [--scale 2] [-o out]
                                               png renders via headless Chromium (format inferred from -o x.png)
  charpie hook                                 Claude Code PostToolUse hook (reads hook JSON on stdin)
`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function arg(args: string[], name: string, short?: string): string | undefined {
  const i = args.findIndex((a) => a === name || (short && a === short));
  if (i >= 0) return args.splice(i, 2)[1];
  const eq = args.findIndex((a) => a.startsWith(name + '='));
  if (eq >= 0) return args.splice(eq, 1)[0].slice(name.length + 1);
  return undefined;
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

function formatIssues(file: string, src: string) {
  const a = analyze(src, fontMeasure);
  const issues = issuesOut(a, src);
  const lines = issues.map((i) => `${file}:${i.line ?? 1}: ${i.severity}: ${i.message} [${i.code}]`);
  return { issues, lines, errors: issues.filter((i) => i.severity === 'error').length, ignored: a.ignored.length };
}

async function serve(args: string[]) {
  const port = Number(arg(args, '--port', '-p') ?? process.env.PORT ?? 5173);
  const host = flag(args, '--host') ? '0.0.0.0' : '127.0.0.1';
  const dir = args[0] ?? '.';
  const ws = new Workspace(dir);
  ws.watch();
  const api = createApi(ws);
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error(`UI build not found at ${dist}. Run "npm run build" in the charpie repo first.`);
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    api(req, res, () => {
      const url = new URL(req.url ?? '/', 'http://x');
      let p = path.join(dist, decodeURIComponent(url.pathname));
      if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, 'index.html');
      res.setHeader('Content-Type', MIME[path.extname(p)] ?? 'application/octet-stream');
      if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(p).pipe(res);
    });
  });
  server.listen(port, host, () => {
    const files = ws.list();
    console.log(`\n  ◆ Charpie  http://localhost:${port}/`);
    console.log(`    dir      ${ws.root}  (${files.length} file${files.length === 1 ? '' : 's'})`);
    console.log(`    API      http://localhost:${port}/api   ← give this to Claude Code\n`);
  });
  const stop = () => {
    ws.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function check(args: string[]) {
  const asJson = flag(args, '--json');
  if (!args.length) throw new Error('usage: charpie check <file...>');
  let errors = 0;
  const out: Record<string, unknown> = {};
  for (const f of args) {
    const src = fs.readFileSync(f, 'utf8');
    const r = formatIssues(f, src);
    errors += r.errors;
    if (asJson) out[f] = r.issues;
    else if (r.lines.length) console.log(r.lines.join('\n'));
    else console.log(`${f}: ok`);
    if (!asJson && r.ignored) console.log(`${f}: (${r.ignored} ignored via ignore=)`);
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
  process.exit(errors ? 1 : 0);
}

function fix(args: string[]) {
  for (const f of args) {
    const src = fs.readFileSync(f, 'utf8');
    const { src: out } = applyOps(src, [{ op: 'fix' }], fontMeasure);
    if (out !== src) fs.writeFileSync(f, out);
    const r = formatIssues(f, out);
    console.log(r.lines.length ? r.lines.join('\n') : `${f}: ok${out !== src ? ' (fixed)' : ''}`);
  }
}

function measureCmd(args: string[]) {
  const asJson = flag(args, '--json');
  if (!args.length) throw new Error('usage: charpie measure <file...>');
  const out: Record<string, NodeMeasure[]> = {};
  for (const f of args) {
    const rows = measureNodes(analyze(fs.readFileSync(f, 'utf8'), fontMeasure), fontMeasure);
    if (asJson) {
      out[f] = rows;
      continue;
    }
    const idW = Math.max(0, ...rows.map((r) => r.id.length));
    const sz = (b: { w: number; h: number }) => `${Math.round(b.w)}x${Math.round(b.h)}`;
    const sign = (v: number) => (v >= 0 ? '+' : '') + Math.round(v);
    for (const r of rows) {
      const font = `${r.font}px${r.auto ? ' auto' : ''}`;
      const slack = `${sign(r.slack.w)}/${sign(r.slack.h)}`;
      console.log(
        `${f}:${r.line}: ${r.id.padEnd(idW)}  ${r.kind.padEnd(7)} ${font.padEnd(10)} box ${sz(r.box).padEnd(9)} text ${sz(r.text).padEnd(9)} slack ${slack.padEnd(9)} fit ${sz(r.fit)}${r.overflow ? '  OVERFLOW' : ''}`,
      );
    }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));
}

async function exportCmd(args: string[]) {
  const out = arg(args, '-o') ?? arg(args, '--out');
  const fmt = arg(args, '--format', '-f') ?? (out?.endsWith('.png') ? 'png' : out?.endsWith('.tex') ? 'tikz' : 'svg');
  const a = analyze(fs.readFileSync(args[0], 'utf8'), fontMeasure);
  if (fmt === 'png') {
    const png = await svgToPng(exportSvg(a.layout), Number(arg(args, '--scale') ?? 2) || 2);
    if (out) fs.writeFileSync(out, png);
    else process.stdout.write(png);
    return;
  }
  const text = fmt === 'tikz' ? exportTikz(a.layout) : exportSvg(a.layout);
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
}

/** Claude Code PostToolUse hook: report layout problems after a .charpie file is edited. */
async function hook() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input: { tool_input?: { file_path?: string; path?: string } } = {};
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const file = input.tool_input?.file_path ?? input.tool_input?.path;
  if (!file || !file.endsWith('.charpie') || !fs.existsSync(file)) return;
  const r = formatIssues(file, fs.readFileSync(file, 'utf8'));
  if (!r.issues.length) return;
  const msg = [`Charpie: ${r.errors} error(s), ${r.issues.length - r.errors} warning(s) in ${path.basename(file)}`, ...r.lines, r.errors ? 'Fix these (adjust geometry, or run `charpie fix <file>` / POST /api/ops {"op":"fix"}).' : ''].filter(Boolean).join('\n');
  if (r.errors) {
    // exit 2: stderr is fed back to Claude
    process.stderr.write(msg + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'serve':
        return await serve(args);
      case 'check':
        return check(args);
      case 'fix':
        return fix(args);
      case 'measure':
        return measureCmd(args);
      case 'export':
        return await exportCmd(args);
      case 'hook':
        return await hook();
      default:
        console.log(HELP);
        process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
    }
  } catch (e) {
    console.error('charpie:', (e as Error).message);
    process.exit(1);
  }
}

main();
