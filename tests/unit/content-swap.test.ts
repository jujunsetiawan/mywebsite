// Story 1.5: swapping dummy for real content is a `content/` edit only. Real
// `astro build`s of the site from a temp copy of `content/` (via the
// `CONTENT_DIR` test seam), serialised through the shared build helper.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'content-swap-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Copies the committed `content/` to a temp dir and applies `edit` to it. */
function contentCopy(name: string, edit: (dir: string) => void): string {
  const dir = path.join(tmpRoot, `content-${name}`);
  cpSync(path.join(repoRoot, 'content'), dir, { recursive: true });
  edit(dir);
  return dir;
}

function replaceIn(file: string, from: string, to: string): void {
  const text = readFileSync(file, 'utf8');
  expect(text, `${file} contains ${from}`).toContain(from);
  writeFileSync(file, text.replace(from, to));
}

function build(name: string, contentDir: string) {
  const outDir = path.join(tmpRoot, `dist-${name}`);
  const result = astroBuild(outDir, { SITE_ENV: 'development', CONTENT_DIR: contentDir }, { freshContentStore: true });
  return { ...result, read: (file: string) => readFileSync(path.join(outDir, file), 'utf8') };
}

describe('content swap', () => {
  it('a project name edited in content only shows on /id/ and /en/ after rebuild', () => {
    const dir = contentCopy('renamed', (root) => {
      const file = path.join(root, 'projects/dashboard-operasional.yaml');
      replaceIn(file, 'id: Dashboard Operasional', 'id: Pusat Kendali Gudang');
      replaceIn(file, 'en: Operations Dashboard', 'en: Warehouse Control Room');
    });
    const { run, output, read } = build('renamed', dir);
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).toBe(0);

    const id = read('id/index.html');
    const en = read('en/index.html');
    expect(id).toMatch(/href="\/id\/proyek\/dashboard-operasional\/"><span[^>]*>Pusat Kendali Gudang<\/span>/);
    expect(en).toMatch(/href="\/en\/proyek\/dashboard-operasional\/"><span[^>]*>Warehouse Control Room<\/span>/);
    for (const html of [id, en]) expect(html).not.toMatch(/Dashboard Operasional|Operations Dashboard/);
    // The untouched entries still render.
    expect(id).toContain('Sistem Order Distribusi');
    expect(en).toContain('Payment Integration');
  }, 180_000);

  it('cross-entry problems fail astro build naming entry and field', () => {
    const dir = contentCopy('broken', (root) => {
      replaceIn(path.join(root, 'testimonials/maya-kusumadewi.yaml'), 'company:', 'project: nope\ncompany:');
      replaceIn(
        path.join(root, 'projects/integrasi-pembayaran.yaml'),
        'slug: integrasi-pembayaran',
        'slug: integrasi-bayar',
      );
    });
    const { run, output } = build('broken', dir);
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).not.toBe(0);
    expect(output).toContain('testimonials → maya-kusumadewi: project — no project with slug "nope"');
    expect(output).toContain(
      'projects → integrasi-pembayaran: slug — must equal the file name "integrasi-pembayaran" (content/projects/integrasi-pembayaran.yaml), got "integrasi-bayar"',
    );
  }, 180_000);
});
