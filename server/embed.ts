/** Embedded diagrams (`image ... src="x.charpie"`) on the server: read from disk, relative to the file that names them. */
import fs from 'node:fs';
import path from 'node:path';
import type { EmbedResolver } from '../src/layout';

/** Resolver for `setEmbedResolver`; with `root`, files outside it are not read. */
export function fileResolver(root?: string): EmbedResolver {
  return (src, base) => {
    if (!base || /^(https?:|data:)/.test(src)) return undefined;
    const abs = path.resolve(path.dirname(base), src);
    if (root && !abs.startsWith(root + path.sep)) return undefined;
    try {
      return { text: fs.readFileSync(abs, 'utf8'), base: abs };
    } catch {
      return undefined;
    }
  };
}
