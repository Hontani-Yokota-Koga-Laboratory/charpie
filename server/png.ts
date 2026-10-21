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

async function launch() {
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

  return browser;
}

/** Waits for fonts and embedded pictures (image shapes decode asynchronously). */
async function settle(page: import('playwright-core').Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('image')].map(
        (el) =>
          new Promise((done) => {
            const img = new Image();
            img.onload = img.onerror = done;
            img.src = el.getAttribute('href') ?? '';
          }),
      ),
    ),
  );
}

const svgSize = (svg: string) => ({
  w: Math.ceil(Number(/<svg[^>]*\swidth="([\d.]+)"/.exec(svg)?.[1] ?? 1200)),
  h: Math.ceil(Number(/<svg[^>]*\sheight="([\d.]+)"/.exec(svg)?.[1] ?? 800)),
});
const bare = (svg: string) => svg.replace(/^<\?xml[^>]*>\s*/, '');

export async function svgToPng(svg: string, scale = 2): Promise<Buffer> {
  const browser = await launch();
  try {
    const { w, h } = svgSize(svg);
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}\nhtml,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${bare(svg)}</body></html>`);
    await settle(page);
    return await page.screenshot({ clip: { x: 0, y: 0, width: w, height: h }, type: 'png', omitBackground: true });
  } finally {
    await browser.close();
  }
}

/** One PDF page per SVG (vector; slides of a deck share the size of the first one). */
export async function svgsToPdf(svgs: string[]): Promise<Buffer> {
  const browser = await launch();
  try {
    const { w, h } = svgSize(svgs[0] ?? '');
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const pages = svgs.map((s) => `<section>${bare(s)}</section>`).join('');
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}\n@page{size:${w}px ${h}px;margin:0}html,body{margin:0;padding:0}section{width:${w}px;height:${h}px;overflow:hidden;break-after:page}section:last-child{break-after:auto}svg{display:block;width:${w}px;height:${h}px}</style></head><body>${pages}</body></html>`,
    );
    await settle(page);
    return await page.pdf({ width: `${w}px`, height: `${h}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await browser.close();
  }
}
