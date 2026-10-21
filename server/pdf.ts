/** PDF of a file (every page of a deck, or the one diagram), shared by `charpie export -o x.pdf` and POST /api/export/pdf. */
import path from 'node:path';
import { views } from '../src/dsl/parse';
import type { View } from '../src/dsl/types';
import { exportSvg, imageSources } from '../src/exportFormats';
import { analyze } from './core';
import { embedFonts } from './fonts';
import { fontMeasure } from './measure';
import { svgsToPdf } from './png';
import { embedImages } from './workspace';

/** Standalone SVG of one view (pictures and family= fonts embedded); `within` keeps pictures inside the workspace. */
export function standaloneSvg(src: string, file: string, view: View | undefined, within?: string): string {
  const l = analyze(src, fontMeasure, view, file).layout;
  const images = embedImages(path.dirname(file), imageSources(l), within);
  return embedFonts(exportSvg(l, '#ffffff', (s) => images.get(s)));
}

/** The views a PDF holds: the pages of a deck (or just `view`), else the single diagram. */
export function pdfViews(src: string, view?: View): (View | undefined)[] {
  return view ? [view] : views(src).filter((v) => !v || 'page' in v);
}

export async function filePdf(src: string, file: string, view?: View, within?: string): Promise<{ pdf: Buffer; pages: number }> {
  const vs = pdfViews(src, view);
  return { pdf: await svgsToPdf(vs.map((v) => standaloneSvg(src, file, v, within))), pages: vs.length };
}
