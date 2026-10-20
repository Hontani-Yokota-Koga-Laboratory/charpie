/**
 * PNG export: render the exported SVG in headless Chromium (playwright-core) with
 * the same Inter files `measure.ts` uses, so what you see matches what `check` judged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function fontFaces(): string {
  const faces: string[] = [];
  for (const subset of ['latin', 'latin-ext']) {
    for (const weight of [400, 500, 600, 700]) {
      try {
        const file = require.resolve(`@fontsource/inter/files/inter-${subset}-${weight}-normal.woff2`);
        const b64 = fs.readFileSync(file).toString('base64');
        faces.push(`@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
      } catch {
        /* font missing: Chromium falls back to a system font */
      }
    }
  }
  return faces.join('\n');
}

/** Browsers playwright may have downloaded for another version (the pinned one is often missing). */
function fallbackExecutables(): string[] {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter((x): x is string => !!x);
  const rel = [
    ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
    ['chrome-linux64', 'chrome'],
    ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-win', 'chrome.exe'],
  ];
  const out: string[] = [];
  for (const root of roots) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium')).sort().reverse();
    } catch {
      continue;
    }
    for (const d of dirs) for (const r of rel) out.push(path.join(root, d, ...r));
  }
  return out.filter((p) => fs.existsSync(p));
}

export async function svgToPng(svg: string, scale = 2): Promise<Buffer> {
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('PNG export needs playwright-core (npm i -D playwright-core) and a Chromium build (npx playwright install chromium)');
  }
  const args = ['--no-sandbox', '--disable-gpu'];
  const candidates = [process.env.CHARPIE_CHROME, undefined, ...fallbackExecutables()];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let lastErr: unknown;
  for (const executablePath of candidates) {
    if (executablePath === '') continue;
    try {
      browser = await chromium.launch({ args, ...(executablePath ? { executablePath } : {}) });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!browser) throw new Error(`could not launch Chromium (set CHARPIE_CHROME or run npx playwright install chromium): ${(lastErr as Error)?.message?.split('\n')[0] ?? ''}`);

  try {
    const w = Math.ceil(Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 1200));
    const h = Math.ceil(Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 800));
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    const body = svg.replace(/^<\?xml[^>]*>\s*/, '');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}\nhtml,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${body}</body></html>`);
    await page.evaluate(() => document.fonts.ready);
    return await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h }, type: 'png', omitBackground: true });
  } finally {
    await browser.close();
  }
}
