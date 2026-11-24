// Story 1.6: the `site-env` post-build step that moves each language's
// empty-archive page to `<lang>/proyek/404.html`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moveArchiveEmptyPages } from '../../src/integrations/site-env.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'archive-empty-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function dist(name: string, langs: string[]): string {
  const dir = path.join(tmpRoot, name);
  for (const lang of langs) {
    mkdirSync(path.join(dir, lang, 'proyek', '404'), { recursive: true });
    writeFileSync(path.join(dir, lang, 'proyek', '404', 'index.html'), `<html lang="${lang}"></html>`);
  }
  return dir;
}

describe('moveArchiveEmptyPages', () => {
  it('moves <lang>/proyek/404/index.html to <lang>/proyek/404.html and removes the empty dir', async () => {
    const dir = dist('both', ['id', 'en']);
    expect(await moveArchiveEmptyPages(dir)).toEqual(['id/proyek/404.html', 'en/proyek/404.html']);
    for (const lang of ['id', 'en']) {
      expect(readFileSync(path.join(dir, lang, 'proyek', '404.html'), 'utf8')).toBe(`<html lang="${lang}"></html>`);
      expect(existsSync(path.join(dir, lang, 'proyek', '404'))).toBe(false);
    }
  });

  it('fails naming the missing source page', async () => {
    const dir = dist('id-only', ['id']);
    await expect(moveArchiveEmptyPages(dir)).rejects.toThrow(
      'site-env: empty-archive page missing: dist/en/proyek/404/index.html',
    );
  });

  it('fails when the source dir holds anything besides index.html', async () => {
    const dir = dist('extra', ['id', 'en']);
    writeFileSync(path.join(dir, 'id', 'proyek', '404', 'stray.txt'), '');
    await expect(moveArchiveEmptyPages(dir)).rejects.toThrow();
  });
});
