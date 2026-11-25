// Open Graph image check over a built dist/ (Story 1.10).
//
// - Every HTML page has exactly one `og:image`, absolute on the configured
//   production origin, resolving to a file in dist/: its own per-language
//   project image on a project page (`<lang>/proyek/<slug>/index.html`), the
//   site image of the page language (`<html lang>`) everywhere else.
// - `og:image:width`/`og:image:height` say 1200/630.
// - Every referenced image is a PNG whose IHDR is 1200×630, 8-bit RGB.
// - Every expected image exists (both site images; both language images of
//   every project page) and no file under `og/` is orphaned.
// Pure core (`checkOg`) plus a disk wrapper; wired into `npm run budgets`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, type Locale } from '../../src/content/schemas.ts';
import { isLocale } from '../../src/i18n/routes.ts';
import { OG_DIR, OG_HEIGHT, OG_WIDTH, expectedImagePaths, projectImagePath, siteImagePath } from '../../src/og/paths.ts';
import { PNG_COLOR_RGB, readPngHeader } from '../../src/og/png.ts';
import { listFiles } from '../budgets/static-assets.ts';
import { tagAttrs } from './i18n-routes.ts';

export interface OgProblem {
  /** dist-relative file the problem is about. */
  file: string;
  problem: string;
}

export interface OgResult {
  /** Pages checked. */
  pages: number;
  /** Image files checked (dist-relative). */
  images: string[];
  problems: OgProblem[];
  ok: boolean;
}

/** `content` of every `<meta property|name="…">` (entity-decoded), grouped by property/name. */
export function ogMeta(html: string): Map<string, string[]> {
  const meta = new Map<string, string[]>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = tagAttrs(tag[0]);
    const key = attrs.property ?? attrs.name;
    if (key === undefined || attrs.content === undefined) continue;
    meta.set(key, [...(meta.get(key) ?? []), attrs.content]);
  }
  return meta;
}

function htmlLang(html: string): string | undefined {
  const tag = /<html\b[^>]*>/i.exec(html)?.[0];
  return tag === undefined ? undefined : tagAttrs(tag).lang;
}

/** Slug of a project page file (`<lang>/proyek/<slug>/index.html`); null otherwise. */
function projectPage(file: string): { lang: Locale; slug: string } | null {
  const match = /^([^/]+)\/proyek\/([^/]+)\/index\.html$/.exec(file);
  return match && isLocale(match[1]!) ? { lang: match[1] as Locale, slug: match[2]! } : null;
}

/**
 * Pure check. `files` are dist-relative paths with forward slashes; `readText`
 * and `readBytes` read one of them; `origin` is the bare production origin.
 */
export function checkOg(
  files: readonly string[],
  readText: (file: string) => string,
  readBytes: (file: string) => Uint8Array,
  origin: string,
): OgResult {
  const fileSet = new Set(files);
  const problems: OgProblem[] = [];
  const report = (file: string, problem: string) => problems.push({ file, problem });
  const pages = [...files].filter((f) => f.endsWith('.html')).sort();
  const slugs = new Set<string>();
  const referenced = new Set<string>();

  for (const file of pages) {
    const html = readText(file);
    const project = projectPage(file);
    if (project) slugs.add(project.slug);
    const meta = ogMeta(html);

    const images = meta.get('og:image') ?? [];
    if (images.length !== 1) {
      report(file, `expected exactly 1 og:image, found ${images.length}`);
      continue;
    }
    const url = images[0]!;
    if (!url.startsWith(`${origin}/`)) {
      report(file, `og:image ${url} is not on the production origin ${origin}`);
      continue;
    }
    const image = url.slice(origin.length + 1);
    const lang = project?.lang ?? htmlLang(html);
    if (lang === undefined || !isLocale(lang)) {
      report(file, `cannot tell the page language (<html lang="${lang ?? ''}">)`);
    } else {
      const expected = project ? projectImagePath(lang, project.slug) : siteImagePath(lang);
      if (image !== expected) report(file, `og:image ${url} should be ${origin}/${expected}`);
    }
    if (!fileSet.has(image)) {
      report(file, `og:image ${url} does not resolve to a file in dist/ (expected dist/${image})`);
    } else {
      referenced.add(image);
    }
    for (const [prop, value] of [
      ['og:image:width', OG_WIDTH],
      ['og:image:height', OG_HEIGHT],
    ] as const) {
      const values = meta.get(prop) ?? [];
      if (values.length !== 1 || values[0] !== String(value)) {
        report(file, `${prop} must be ${value}, found ${values.length === 0 ? 'none' : values.join(', ')}`);
      }
    }
  }

  // Every image that exists under og/ (referenced or not) must be a 1200×630 8-bit RGB PNG.
  const ogFiles = [...files].filter((f) => f.startsWith(`${OG_DIR}/`)).sort();
  for (const image of [...new Set([...ogFiles, ...referenced])].sort()) {
    const header = readPngHeader(readBytes(image));
    if (header === null) {
      report(image, 'is not a PNG');
    } else if (header.width !== OG_WIDTH || header.height !== OG_HEIGHT) {
      report(image, `is ${header.width}×${header.height}, expected ${OG_WIDTH}×${OG_HEIGHT}`);
    } else if (header.bitDepth !== 8 || header.colorType !== PNG_COLOR_RGB) {
      report(image, `must be 8-bit RGB without alpha (bit depth ${header.bitDepth}, colour type ${header.colorType})`);
    }
  }

  const expected = expectedImagePaths([...slugs]);
  for (const image of expected) if (!fileSet.has(image)) report(image, `missing expected image dist/${image}`);
  const expectedSet = new Set(expected);
  for (const image of ogFiles) {
    if (!expectedSet.has(image)) report(image, 'orphaned: no page uses this image');
  }

  return { pages: pages.length, images: ogFiles, problems, ok: problems.length === 0 };
}

/** Runs the check over a dist/ directory on disk. */
export function checkOgDir(distDir: string, origin: string): OgResult {
  const files = listFiles(distDir).map((file) => file.path);
  return checkOg(
    files,
    (file) => readFileSync(path.join(distDir, file), 'utf8'),
    (file) => readFileSync(path.join(distDir, file)),
    origin,
  );
}

export function formatOg(result: OgResult, origin: string): string {
  return [
    `Open Graph images — dist/ (origin ${origin})`,
    `  pages: ${result.pages}, images: ${result.images.length} (${LOCALES.length} languages)`,
    ...result.problems.map((p) => `  FAIL ${p.file}: ${p.problem}`),
    `  ${result.ok ? 'PASS' : 'FAIL'}`,
  ].join('\n');
}

// Standalone: `node scripts/checks/og.ts <distDir> <productionOrigin>`; exit 1 on failure.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [distDir, origin] = process.argv.slice(2);
  if (distDir === undefined || origin === undefined) {
    console.error('usage: node scripts/checks/og.ts <distDir> <productionOrigin>');
    process.exit(2);
  }
  const result = checkOgDir(distDir, origin);
  console.log(formatOg(result, origin));
  process.exit(result.ok ? 0 : 1);
}
