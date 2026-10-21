/**
 * A minimal PDF writer: one JPEG per page, the page exactly the picture's size (no margins).
 * The fallback when the server cannot render a vector PDF (no charpie serve, no Chromium there).
 */

export type PdfPage = { jpeg: Uint8Array; px: { w: number; h: number }; size: { w: number; h: number } };

const enc = new TextEncoder();

/** `size` is the page in CSS px (1px = 0.75pt); `px` the picture's pixels. */
export function jpegPdf(pages: PdfPage[], title = ''): Blob {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(u);
    at += u.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = at;
    put(`${n} 0 obj\n`);
    body();
    put('\nendobj\n');
  };
  const pt = (v: number) => String(Math.round(v * 0.75 * 100) / 100);
  // 1 catalog, 2 page tree, 3 info, then 3 objects per page: page, content, image
  const first = 4;
  const ids = pages.map((_, i) => first + i * 3);
  put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  obj(1, () => put('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => put(`<< /Type /Pages /Count ${pages.length} /Kids [${ids.map((n) => `${n} 0 R`).join(' ')}] >>`));
  obj(3, () => put(`<< /Producer (Charpie) /Title <FEFF${title.split('').map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}> >>`));
  pages.forEach((p, i) => {
    const n = ids[i];
    const w = pt(p.size.w),
      h = pt(p.size.h);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n, () => put(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`));
    obj(n + 1, () => put(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    obj(n + 2, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${p.px.w} /Height ${p.px.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      put(p.jpeg);
      put('\nendstream');
    });
  });
  const count = first + pages.length * 3;
  const xref = at;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}
