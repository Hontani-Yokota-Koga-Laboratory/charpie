/**
 * Fonts that PowerPoint has (installed with Windows / Office, or Microsoft 365 cloud fonts) and that
 * charpie measures with the same advance widths: Calibri & co. through their metric-compatible free
 * fonts (server/fonts.ts ALIASES), the BIZ UD fonts as they are. `set compat=pptx` keeps a file to
 * these, so a .pptx export breaks its lines where charpie does.
 */
export const OFFICE_FAMILIES = ['Calibri', 'Arial', 'Cambria', 'Times New Roman', 'BIZ UDPGothic', 'BIZ UDPMincho'] as const;

const key = (f: string) => f.trim().toLowerCase();
const OFFICE = new Set<string>(OFFICE_FAMILIES.map(key));

/**
 * Japanese partner of a Latin-only Office font: its kana / kanji are drawn (and measured, and written
 * to .pptx as the East Asian font) in this one, as Office pairs them, instead of whatever system font.
 */
const EAST_ASIAN: Record<string, string> = {
  calibri: 'BIZ UDPGothic',
  arial: 'BIZ UDPGothic',
  cambria: 'BIZ UDPMincho',
  'times new roman': 'BIZ UDPMincho',
};

export const isOfficeFamily = (family: string | undefined) => !!family && OFFICE.has(key(family));
export const eastAsianFor = (family: string | undefined): string | undefined => (family ? EAST_ASIAN[key(family)] : undefined);
