// Writes the Open Graph images into `dist/og/` at the end of the build
// (Story 1.10): one site image per language and one image per project per
// language, rendered from `content/` (or `CONTENT_DIR`) by `src/og/render.ts`.
// Any render error fails the build naming the image. The images are plain
// dist/ files, so `npm run budgets` counts them toward the static-asset limits.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { LOCALES } from '../content/schemas.ts';
import { loadOgContent } from '../og/content.ts';
import { loadOgFonts, type OgFonts } from '../og/fonts.ts';
import { projectImagePath, siteImagePath } from '../og/paths.ts';
import { renderProjectImage, renderSiteImage } from '../og/render.ts';
import { ogColors } from '../og/tokens.ts';

export interface WriteOgImagesOptions {
  /** Project root (resolves the font packages and `src/styles/tokens.css`). */
  rootDir: string;
  /** Content directory; defaults to a non-empty `CONTENT_DIR`, then `<rootDir>/content`. */
  contentDir?: string | undefined;
  /** Test seam: font loader (defaults to `loadOgFonts(rootDir)`). */
  loadFonts?: () => Promise<OgFonts>;
}

interface Job {
  /** dist-relative image path. */
  file: string;
  render: (fonts: OgFonts) => Promise<Buffer>;
}

/**
 * Renders and writes every OG image under `distDir`; returns the written
 * dist-relative paths. Throws `og-images: cannot render dist/<file>: …` or
 * `og-images: cannot write dist/<file>: …` on the first failure (fonts are
 * loaded inside each image's attempt, so a missing font also names the image).
 */
export async function writeOgImages(distDir: string, options: WriteOgImagesOptions): Promise<string[]> {
  // An empty CONTENT_DIR counts as unset, as in src/content.config.ts.
  const contentDir = options.contentDir ?? (process.env.CONTENT_DIR || path.join(options.rootDir, 'content'));
  const content = await loadOgContent(contentDir);
  const colors = ogColors(await readFile(path.join(options.rootDir, 'src/styles/tokens.css'), 'utf8'));
  let fontsPromise: Promise<OgFonts> | undefined;
  const fonts = () => (fontsPromise ??= (options.loadFonts ?? (() => loadOgFonts(options.rootDir)))());

  const jobs: Job[] = LOCALES.flatMap((lang) => [
    { file: siteImagePath(lang), render: (f) => renderSiteImage({ lang, content, colors, fonts: f }) },
    ...content.projects.map(
      (project): Job => ({
        file: projectImagePath(lang, project.slug),
        render: (f) => renderProjectImage({ lang, content, colors, fonts: f }, project),
      }),
    ),
  ]);

  const written: string[] = [];
  for (const job of jobs) {
    let png: Buffer;
    try {
      png = await job.render(await fonts());
    } catch (error) {
      throw new Error(`og-images: cannot render dist/${job.file}: ${(error as Error).message}`, { cause: error });
    }
    const target = path.join(distDir, job.file);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, png);
    } catch (error) {
      throw new Error(`og-images: cannot write dist/${job.file}: ${(error as Error).message}`, { cause: error });
    }
    written.push(job.file);
  }
  return written;
}

export default function ogImages(): AstroIntegration {
  let rootDir = process.cwd();
  return {
    name: 'og-images',
    hooks: {
      'astro:config:done': ({ config }) => {
        rootDir = fileURLToPath(config.root);
      },
      'astro:build:done': async ({ dir, logger }) => {
        const written = await writeOgImages(fileURLToPath(dir), { rootDir });
        logger.info(`${written.length} Open Graph images in dist/og/`);
      },
    },
  };
}
