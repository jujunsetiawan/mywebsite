// Story 1.10 matrix "content swap": the first project (by `order`) renamed
// in a temp copy of `content/` (CONTENT_DIR seam) → the rebuilt project image
// differs from the committed content's image, matches a render of the new
// name, and the page's og:title / og:image:alt use the new name. Nothing here
// depends on which projects `content/` holds. Real `astro build`, serialised
// through the shared build helper; the og check passes on the output.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { loadSiteConfig } from '../../config/load.ts';
import { checkOgDir, ogMeta } from '../../scripts/checks/og.ts';
import { loadOgContent } from '../../src/og/content.ts';
import { loadOgFonts } from '../../src/og/fonts.ts';
import { projectImagePath } from '../../src/og/paths.ts';
import { renderProjectImage } from '../../src/og/render.ts';
import { ogColors } from '../../src/og/tokens.ts';
import { astroBuild, repoRoot } from './helpers/astro-build.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'og-swap-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NEW_NAME = { id: 'Pusat Kendali Uji Ganti Nama', en: 'Renamed Test Control Room' } as const;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('OG content swap', () => {
  it('a renamed project rebuilds its image and tags with the new name', async () => {
    const committedDir = path.join(repoRoot, 'content');
    const contentDir = path.join(tmpRoot, 'content');
    cpSync(committedDir, contentDir, { recursive: true });

    // The first project by `order` in the copy; its YAML file is `<slug>.yaml` (integrity rule).
    const committed = await loadOgContent(contentDir);
    const target = committed.projects[0]!;
    const yamlFile = path.join(contentDir, 'projects', `${target.slug}.yaml`);
    const doc = parseDocument(readFileSync(yamlFile, 'utf8'));
    doc.setIn(['name', 'id'], NEW_NAME.id);
    doc.setIn(['name', 'en'], NEW_NAME.en);
    writeFileSync(yamlFile, doc.toString());

    const outDir = path.join(tmpRoot, 'dist');
    const { run, output } = astroBuild(outDir, { SITE_ENV: 'development', CONTENT_DIR: contentDir }, { freshContentStore: true });
    expect(run.error, output).toBeUndefined();
    expect(run.status, output).toBe(0);

    const fonts = await loadOgFonts(repoRoot);
    const colors = ogColors(readFileSync(path.join(repoRoot, 'src/styles/tokens.css'), 'utf8'));
    const render = async (dir: string, lang: 'id' | 'en') => {
      const content = await loadOgContent(dir);
      const project = content.projects.find((p) => p.slug === target.slug)!;
      return renderProjectImage({ lang, content, colors, fonts }, project);
    };

    for (const lang of ['id', 'en'] as const) {
      const built = readFileSync(path.join(outDir, projectImagePath(lang, target.slug)));
      expect(Buffer.compare(built, await render(committedDir, lang)), `${lang} image differs from the old one`).not.toBe(0);
      expect(Buffer.compare(built, await render(contentDir, lang)), `${lang} image is the render of the new name`).toBe(0);

      const meta = ogMeta(readFileSync(path.join(outDir, lang, `proyek/${target.slug}/index.html`), 'utf8'));
      expect(meta.get('og:title')?.[0]).toMatch(new RegExp(`^${escape(NEW_NAME[lang])} — `));
      expect(meta.get('og:image:alt')).toEqual(meta.get('og:title'));
      expect(meta.get('og:image:alt')?.[0]).not.toContain(target.name[lang]);
    }

    const { productionOrigin } = loadSiteConfig({ siteEnv: 'development', configDir: path.join(repoRoot, 'config') });
    expect(checkOgDir(outDir, productionOrigin).problems).toEqual([]);
  }, 180_000);
});
