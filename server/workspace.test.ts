import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashText } from '../src/hash';
import { Workspace } from './workspace';

const dirs: string[] = [];
function ws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'charpie-ws-'));
  dirs.push(d);
  return new Workspace(d);
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('workspace delete', () => {
  it('moves the file to .trash (unlisted) and restores it', () => {
    const w = ws();
    w.write('a/x', 'rect a "A" at (0, 0) size 100x50\n');
    w.write('y', '');
    const { file, trashed } = w.trash('a/x.charpie');
    expect(file).toBe('a/x.charpie');
    expect(trashed).toMatch(/^\.trash\/[\d-]+\/a\/x\.charpie$/);
    expect(w.list()).toEqual(['y.charpie']);
    expect(fs.readFileSync(path.join(w.root, trashed), 'utf8')).toContain('rect a');
    expect(w.restore(trashed)).toBe('a/x.charpie');
    expect(w.list()).toEqual(['a/x.charpie', 'y.charpie']);
    expect(w.read('a/x')).toContain('rect a');
  });
  it('refuses a file changed since the caller saw it, and missing files', () => {
    const w = ws();
    w.write('x', 'one\n');
    const seen = hashText('one\n');
    w.write('x', 'two\n');
    expect(() => w.trash('x', seen)).toThrow(/changed/);
    expect(w.exists('x')).toBe(true);
    expect(() => w.trash('nope')).toThrow(/not found/);
    w.trash('x', hashText('two\n'));
    expect(w.exists('x')).toBe(false);
  });
  it('stays inside the workspace and never restores over a file', () => {
    const w = ws();
    expect(() => w.trash('../outside')).toThrow(/invalid/);
    w.write('x', 'old\n');
    const { trashed } = w.trash('x');
    w.write('x', 'new\n');
    expect(() => w.restore(trashed)).toThrow(/exists/);
    expect(w.read('x')).toBe('new\n');
    expect(() => w.restore('x.charpie')).toThrow(/invalid/);
    expect(() => w.restore('.trash/../x.charpie')).toThrow(/invalid/);
  });
  it('a second delete of the same name in the same second does not collide', () => {
    const w = ws();
    w.write('x', '1\n');
    const a = w.trash('x').trashed;
    w.write('x', '2\n');
    const b = w.trash('x').trashed;
    expect(a).not.toBe(b);
    expect(fs.readFileSync(path.join(w.root, a), 'utf8')).toBe('1\n');
    expect(fs.readFileSync(path.join(w.root, b), 'utf8')).toBe('2\n');
  });
});
