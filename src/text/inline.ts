/**
 * Inline markup in labels: `$...$` formulas and `**bold**` spans.
 *
 * - `**` opens bold only when another `**` follows later in the same line (an unpaired `**`,
 *   as in `x**2`, is plain text). Inside `$...$` it is TeX, never markup.
 * - `\$` and `\*` are a literal `$` / `*`.
 */
export type Inline = { math: false; s: string; bold: boolean } | { math: true; s: string; bold: boolean };

/** Quick test before the full split. */
export const mayHaveMarkup = (s: string) => s.includes('$') || s.includes('**') || s.includes('\\');

/** Index of the `$` closing a formula that starts at `from`, or -1. */
export function mathClose(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '$') return j;
  }
  return -1;
}

/** Index of the next `**` outside formulas, from `from` on, or -1. */
export function boldClose(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '$') {
      const e = mathClose(s, j + 1);
      if (e > j + 1) j = e;
    } else if (s[j] === '*' && s[j + 1] === '*') return j;
  }
  return -1;
}

/** Split one line into text / formula pieces with their bold state. */
export function splitInline(s: string): Inline[] {
  if (!mayHaveMarkup(s)) return [{ math: false, s, bold: false }];
  const out: Inline[] = [];
  let text = '';
  let bold = false;
  const flush = () => {
    if (text) {
      const last = out[out.length - 1];
      if (last && !last.math && last.bold === bold) last.s += text;
      else out.push({ math: false, s: text, bold });
    }
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '$' || s[i + 1] === '*')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '$') {
      const end = mathClose(s, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ math: true, s: s.slice(i + 1, end), bold });
        i = end + 1;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*' && (bold || boldClose(s, i + 2) >= 0)) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  if (!out.length) out.push({ math: false, s: '', bold: false });
  return out;
}

/** The text as drawn (markup removed, formulas kept as their source). */
export function plainText(s: string): string {
  return splitInline(s)
    .map((g) => (g.math ? `$${g.s}$` : g.s))
    .join('');
}

/** True when a line needs per-run drawing (a formula or a bold span). */
export function hasRich(s: string): boolean {
  return mayHaveMarkup(s) && splitInline(s).some((g) => g.math || g.bold);
}
