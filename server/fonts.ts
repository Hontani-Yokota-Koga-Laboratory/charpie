/**
 * Font families for `family=` / `set family=`: one set of font files that the browser (served as
 * @font-face), headless exports (embedded as data: URIs) and `check` / `measure` (fontkit) all use,
 * so every one of them judges the same glyph widths.
 *
 * Where a family comes from, first match wins:
 *   1. `fonts/` next to the .charpie (any .ttf / .otf / .woff / .woff2; the name inside the file counts)
 *   2. an installed Fontsource package `@fontsource/<name in kebab case>` (Google Fonts on npm;
 *      M PLUS Rounded 1c and M PLUS 1p ship with charpie, others: `npm i @fontsource/<name>`)
 *   3. for the usual Office fonts, a metric-compatible free font (same advance widths): `Calibri` is
 *      drawn and measured with Carlito, and so on (ALIASES). The name stays as written, so the TikZ
 *      export still asks lualatex for the real font, and line breaks match where it is installed.
 * Nothing is fetched at run time, so a diagram looks the same offline and on every machine.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as fontkit from 'fontkit';
import { eastAsianFor } from '../src/text/office';

const require = createRequire(import.meta.url);

export interface Face {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  file: string;
  /** code point ranges this file covers (Fontsource subsets); undefined = whatever the file has */
  ranges?: [number, number][];
  /** the same as written in CSS (`U+0-ff,U+131`) */
  rangeCss?: string;
  /** short stable id the server serves the file under */
  id: string;
}

export type FontFile = {
  unitsPerEm: number;
  layout(s: string, features?: Record<string, boolean>): { advanceWidth: number };
  hasGlyphForCodePoint(c: number): boolean;
};

const byId = new Map<string, Face>();
const families = new Map<string, Face[] | null>();
const fontDirs = new Set<string>();
const scanned = new Map<string, Face[]>();

/** Office font → metric-compatible Fontsource family (Croscore / Google ChromeOS fonts) */
const ALIASES: Record<string, string> = {
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'Arimo',
  'times new roman': 'Tinos',
};

const idOf = (file: string) => crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
const key = (name: string) => name.trim().toLowerCase();

/** Also look in `<dir of file>/fonts/` (called for every .charpie analysed). */
export function fontsNear(file: string | undefined) {
  if (!file) return;
  const dir = path.join(path.dirname(path.resolve(file)), 'fonts');
  if (fontDirs.has(dir)) return;
  fontDirs.add(dir);
  // a family that was missing may be here
  for (const [k, v] of families) if (v === null) families.delete(k);
}

function parseRanges(css: string): [number, number][] {
  return css.split(',').flatMap((part) => {
    const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
    if (!m) return [];
    if (m[1].includes('?')) return [[parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)] as [number, number]];
    const a = parseInt(m[1], 16);
    return [[a, m[2] ? parseInt(m[2], 16) : a] as [number, number]];
  });
}

/** Fontsource package: one @font-face per subset and weight in `<weight>.css` / `<weight>-italic.css`. */
function fromFontsource(name: string): Face[] | undefined {
  const slug = key(name).replace(/\s+/g, '-');
  let dir: string;
  try {
    dir = path.dirname(require.resolve(`@fontsource/${slug}/package.json`));
  } catch {
    return undefined;
  }
  const faces: Face[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+(-italic)?\.css$/.test(x))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      const fam = /font-family:\s*'([^']+)'/.exec(block)?.[1];
      const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? 400);
      const style = /font-style:\s*italic/.test(block) ? 'italic' : 'normal';
      const url = /url\(\.\/(files\/[^)]+\.woff2)\)/.exec(block)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]?.trim();
      if (!fam || !url) continue;
      const file = path.join(dir, url);
      faces.push({ family: fam, weight, style, file, ranges: range ? parseRanges(range) : undefined, rangeCss: range, id: idOf(file) });
    }
  }
  return faces.length ? faces : undefined;
}

type NamedFont = FontFile & { familyName?: string; name?: { records?: { preferredFamily?: Record<string, string> } }; 'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean } } };

/** Font files in a `fonts/` directory (and its sub-directories), keyed by the family names inside them. */
function scan(dir: string): Face[] {
  const hit = scanned.get(dir);
  if (hit) return hit;
  const out: Face[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (/\.(ttf|otf|woff2?)$/i.test(e.name)) {
        try {
          const f = fontkit.openSync(p) as unknown as NamedFont;
          const fam = f.name?.records?.preferredFamily?.en ?? f.familyName;
          if (!fam) continue;
          out.push({ family: fam, weight: f['OS/2']?.usWeightClass ?? 400, style: f['OS/2']?.fsSelection?.italic ? 'italic' : 'normal', file: p, id: idOf(p) });
        } catch {
          /* not a font fontkit can read */
        }
      }
    }
  };
  walk(dir, 0);
  scanned.set(dir, out);
  return out;
}

/** Faces of a family, or undefined when it is not available. */
export function findFamily(name: string): Face[] | undefined {
  const k = key(name);
  if (families.has(k)) return families.get(k) ?? undefined;
  let faces: Face[] | undefined;
  for (const dir of fontDirs) {
    const local = scan(dir).filter((f) => key(f.family) === k);
    if (local.length) {
      faces = local;
      break;
    }
  }
  faces ??= fromFontsource(name) ?? (ALIASES[k] ? fromFontsource(ALIASES[k]) : undefined);
  families.set(k, faces ?? null);
  for (const f of faces ?? []) byId.set(f.id, f);
  return faces;
}

export const faceById = (id: string) => byId.get(id);

/** Family names of the installed Fontsource packages (read from their `@font-face` rules). */
let fontsourceNames: string[] | undefined;
function fontsourceFamilies(): string[] {
  if (fontsourceNames) return fontsourceNames;
  const names = new Set<string>();
  let root: string | undefined;
  try {
    root = path.dirname(path.dirname(require.resolve('@fontsource/inter/package.json')));
  } catch {
    /* no Fontsource package next to charpie */
  }
  for (const pkg of root ? fs.readdirSync(root) : []) {
    const dir = path.join(root!, pkg);
    const css = (() => {
      try {
        return fs.readdirSync(dir).find((x) => /^\d+\.css$/.test(x));
      } catch {
        return undefined;
      }
    })();
    const fam = css && /font-family:\s*'([^']+)'/.exec(fs.readFileSync(path.join(dir, css), 'utf8'))?.[1];
    if (fam) names.add(fam);
  }
  return (fontsourceNames = [...names]);
}

/** Every family `family=` can name right now: `fonts/` next to the open files first, then Fontsource packages and their Office names. */
export function listFamilies(): string[] {
  const out = new Set<string>();
  for (const dir of fontDirs) for (const f of scan(dir)) out.add(f.family);
  const packaged = fontsourceFamilies();
  for (const f of packaged) out.add(f);
  for (const [alias, to] of Object.entries(ALIASES))
    if (packaged.includes(to) && ![...out].some((x) => key(x) === alias)) out.add(alias.replace(/\b\w/g, (c) => c.toUpperCase()));
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The weight CSS would pick among `have` for `want` (CSS Fonts 4 §5.2). */
export function matchWeight(want: number, have: number[]): number {
  const ws = [...new Set(have)].sort((a, b) => a - b);
  if (!ws.length) return want;
  if (ws.includes(want)) return want;
  const below = ws.filter((w) => w < want).reverse();
  const above = ws.filter((w) => w > want);
  if (want >= 400 && want <= 500) {
    const mid = above.filter((w) => w <= 500);
    return mid[0] ?? below[0] ?? above[0];
  }
  return want < 400 ? (below[0] ?? above[0]) : (above[0] ?? below[0]);
}

const opened = new Map<string, FontFile | null>();
export function openFace(f: Face): FontFile | null {
  if (!opened.has(f.file)) {
    try {
      opened.set(f.file, fontkit.openSync(f.file) as unknown as FontFile);
    } catch {
      opened.set(f.file, null);
    }
  }
  return opened.get(f.file)!;
}

const covers = (f: Face, cp: number) => !f.ranges || f.ranges.some(([a, b]) => cp >= a && cp <= b);

/** The face that draws `cp` at `weight` (normal style), or undefined (the browser falls back to the default font). */
export function faceFor(faces: Face[], weight: number, cp: number): Face | undefined {
  const normal = faces.filter((f) => f.style === 'normal');
  const pool = normal.length ? normal : faces;
  const w = matchWeight(weight, pool.map((f) => f.weight));
  for (const f of pool) if (f.weight === w && covers(f, cp) && openFace(f)?.hasGlyphForCodePoint(cp)) return f;
  return undefined;
}

// ───────────── CSS ─────────────

const fmt = (file: string) => ({ '.woff2': 'woff2', '.woff': 'woff', '.otf': 'opentype', '.ttf': 'truetype' })[path.extname(file).toLowerCase()] ?? 'truetype';
const MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', opentype: 'font/otf', truetype: 'font/ttf' };
export const fontMime = (file: string) => MIME[fmt(file)];

function faceRule(family: string, f: Face, src: string): string {
  return `@font-face{font-family:'${family}';font-style:${f.style};font-weight:${f.weight};font-display:block;src:url(${src}) format('${fmt(f.file)}');${f.rangeCss ? `unicode-range:${f.rangeCss};` : ''}}`;
}

/** @font-face rules for the browser, pointing at `url(face)`; families that were not found are listed in `missing`. */
export function fontCss(names: string[], url: (f: Face) => string): { css: string; missing: string[] } {
  const rules: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const faces = findFamily(name);
    if (!faces) missing.push(name);
    // registered under the name as written, so `family=m plus 1p` works too
    else for (const f of faces) rules.push(faceRule(name, f, url(f)));
  }
  return { css: rules.join('\n'), missing };
}

/** Families an SVG (from DiagramSvg) asks for: the first name of every font-family attribute. */
export function svgFamilies(svg: string): string[] {
  const out = new Set<string>();
  for (const m of svg.matchAll(/font-family="([^"]+)"/g)) {
    const first = /^\s*'([^']+)'/.exec(m[1].replace(/&#x27;|&#39;|&apos;/g, "'"))?.[1];
    // the default stack starts with Inter, which exports load on their own
    if (first && !/^Inter( Variable)?$/.test(first)) {
      out.add(first);
      const ea = eastAsianFor(first);
      if (ea) out.add(ea);
    }
  }
  return [...out];
}

/**
 * Self-contained @font-face rules (data: URIs) for the families an SVG uses: only the files that
 * hold its characters at its weights, so an export stays small.
 */
export function embeddedFontCss(svg: string, extra: string[] = []): string {
  const text = svg.replace(/<[^>]*>/g, '');
  const cps = new Set<number>();
  for (const ch of text) cps.add(ch.codePointAt(0)!);
  const weights = new Set<number>([...svg.matchAll(/font-weight="(\d+)"/g)].map((m) => Number(m[1])));
  if (!weights.size) weights.add(500);
  const rules: string[] = [];
  for (const name of [...svgFamilies(svg), ...extra]) {
    const faces = findFamily(name);
    if (!faces) continue;
    const used = new Set<Face>();
    for (const w of weights)
      for (const cp of cps) {
        const f = faceFor(faces, w, cp);
        if (f) used.add(f);
      }
    for (const f of used) rules.push(faceRule(name, f, `data:${fontMime(f.file)};base64,${fs.readFileSync(f.file).toString('base64')}`));
  }
  return rules.join('\n');
}

/** The SVG with the faces of its `family=` fonts inside (a <style> after the opening tag), so it stands alone. */
export function embedFonts(svg: string): string {
  const css = embeddedFontCss(svg);
  if (!css) return svg;
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}<style>${css}</style>`);
}
