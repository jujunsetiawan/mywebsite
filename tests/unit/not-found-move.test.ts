// Stories 1.6 and 1.8: the `site-env` post-build step that moves each
// language's not-found pages into place: the site-wide one to
// `<lang>/404.html` and the empty archive to `<lang>/proyek/404.html`.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { moveNotFoundPages } from '../../src/integrations/site-env.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'not-found-move-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A dist/ holding the directory-format sources `<lang>/<dir>404/index.html` for each dir. */
function dist(name: string, langs: string[], dirs: string[] = ['', 'proyek/']): string {
  const root = path.join(tmpRoot, name);
  for (const lang of langs) {
    for (const dir of dirs) {
      mkdirSync(path.join(root, lang, dir, '404'), { recursive: true });
      writeFileSync(path.join(root, lang, dir, '404', 'index.html'), `<html lang="${lang}">${dir}</html>`);
    }
  }
  return root;
}

describe('moveNotFoundPages', () => {
  it('moves <lang>/404/index.html and <lang>/proyek/404/index.html to flat 404.html files', async () => {
    const dir = dist('both', ['id', 'en']);
    expect(await moveNotFoundPages(dir)).toEqual([
      'id/404.html',
      'id/proyek/404.html',
      'en/404.html',
      'en/proyek/404.html',
    ]);
    for (const lang of ['id', 'en']) {
      expect(readFileSync(path.join(dir, lang, '404.html'), 'utf8')).toBe(`<html lang="${lang}"></html>`);
      expect(readFileSync(path.join(dir, lang, 'proyek', '404.html'), 'utf8')).toBe(`<html lang="${lang}">proyek/</html>`);
      expect(existsSync(path.join(dir, lang, '404')), lang).toBe(false);
      expect(existsSync(path.join(dir, lang, 'proyek', '404')), lang).toBe(false);
      expect(readdirSync(path.join(dir, lang)).sort()).toEqual(['404.html', 'proyek']);
    }
  });

  it('fails naming a missing site-wide source page, moving nothing', async () => {
    const dir = dist('no-en-site-wide', ['id', 'en'], ['proyek/']);
    mkdirSync(path.join(dir, 'id', '404'));
    writeFileSync(path.join(dir, 'id', '404', 'index.html'), '');
    await expect(moveNotFoundPages(dir)).rejects.toThrow(
      'site-env: not-found page missing: dist/en/404/index.html (built from src/pages/[lang]/404.astro)',
    );
    // Checked before anything moves.
    expect(existsSync(path.join(dir, 'id', '404', 'index.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'id', 'proyek', '404', 'index.html'))).toBe(true);
  });

  it('fails naming a missing empty-archive source page', async () => {
    const dir = dist('id-only', ['id']);
    await expect(moveNotFoundPages(dir)).rejects.toThrow(
      'site-env: not-found page missing: dist/en/404/index.html (built from src/pages/[lang]/404.astro), ' +
        'dist/en/proyek/404/index.html (built from src/pages/[lang]/proyek/404.astro)',
    );
  });

  it('fails naming every source dir that holds anything besides index.html, moving nothing', async () => {
    const dir = dist('extra', ['id', 'en']);
    writeFileSync(path.join(dir, 'id', 'proyek', '404', 'stray.txt'), '');
    writeFileSync(path.join(dir, 'en', '404', 'b.txt'), '');
    writeFileSync(path.join(dir, 'en', '404', 'a.txt'), '');
    await expect(moveNotFoundPages(dir)).rejects.toThrow(
      'site-env: not-found source dir holds more than index.html: ' +
        'dist/id/proyek/404/ (stray.txt), dist/en/404/ (a.txt, b.txt)',
    );
    // Checked before anything moves: the earlier id/404 source is still in place.
    for (const lang of ['id', 'en']) {
      for (const sub of ['', 'proyek/']) {
        expect(existsSync(path.join(dir, lang, sub, '404', 'index.html')), `${lang}/${sub}`).toBe(true);
        expect(existsSync(path.join(dir, lang, sub, '404.html')), `${lang}/${sub}`).toBe(false);
      }
    }
  });
});
