/** .pptx of a file (every page of a deck, or the one diagram), shared by `charpie export -o x.pptx` and POST /api/export/pptx. */
import path from 'node:path';
import type { View } from '../src/dsl/types';
import { imageSources } from '../src/exportFormats';
import { exportPptx, type PptxImage } from '../src/pptx';
import { analyze } from './core';
import { embedFonts } from './fonts';
import { fontMeasure } from './measure';
import { pdfViews } from './pdf';
import { svgsToPngs } from './png';
import { embedImages } from './workspace';

export async function filePptx(src: string, file: string, view?: View, within?: string): Promise<{ pptx: Buffer; pages: number }> {
  const layouts = pdfViews(src, view).map((v) => analyze(src, fontMeasure, v, file).layout);
  const uris = embedImages(path.dirname(file), [...new Set(layouts.flatMap(imageSources))], within);
  const image = (s: string): PptxImage | undefined => {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(uris.get(s) ?? '');
    return m ? { mime: m[1], data: new Uint8Array(Buffer.from(m[2], 'base64')) } : undefined;
  };
  const pptx = await exportPptx(layouts, {
    image,
    // family= fonts travel inside each SVG, so the pictures are drawn with them
    raster: async (jobs) => (await svgsToPngs(jobs.map((j) => ({ ...j, svg: embedFonts(j.svg) })))).map((b) => new Uint8Array(b)),
    title: path.basename(file).replace(/\.charpie$/, ''),
  });
  return { pptx: Buffer.from(pptx), pages: layouts.length };
}
