// Story 1.10: the build-time Open Graph renderer — PNG output (signature,
// 1200×630, 8-bit RGB), the wrapping/ellipsis helper, layout inside the safe
// margin, non-ASCII text, token colours, fonts + licences, render errors
// naming the image, and the renderer staying out of pages and client code.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import satori from 'satori';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { writeOgImages } from '../../src/integrations/og-images.ts';
import { loadOgContent, type OgContent, type OgProject } from '../../src/og/content.ts';
import { loadOgFonts, OG_FONT_FILES, type OgFonts } from '../../src/og/fonts.ts';
import { expectedImagePaths, OG_HEIGHT, OG_WIDTH, projectImagePath, siteImagePath } from '../../src/og/paths.ts';
import { encodeRgbPng, PNG_COLOR_RGB, PNG_SIGNATURE, readPngHeader } from '../../src/og/png.ts';
import {
  MARGIN,
  OG_TYPE,
  projectImageTree,
  renderProjectImage,
  renderSiteImage,
  siteImageTree,
  type OgNode,
} from '../../src/og/render.ts';
import { ELLIPSIS, fontMeasure, wrapText } from '../../src/og/text.ts';
import { OG_COLOR_TOKENS, ogColors, parseCssTokens, type OgColors } from '../../src/og/tokens.ts';
import { repoRoot } from './helpers/astro-build.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'og-render-'));
let content: OgContent;
let fonts: OgFonts;
let colors: OgColors;
const tokensCss = readFileSync(path.join(repoRoot, 'src/styles/tokens.css'), 'utf8');

beforeAll(async () => {
  content = await loadOgContent(path.join(repoRoot, 'content'));
  fonts = await loadOgFonts(repoRoot);
  colors = ogColors(tokensCss);
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function expectOgPng(png: Uint8Array): void {
  expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  expect(readPngHeader(png)).toEqual({ width: OG_WIDTH, height: OG_HEIGHT, bitDepth: 8, colorType: PNG_COLOR_RGB });
}

/** Text of every line element (a div whose children is a string) under `node`, in order. */
function lines(node: OgNode): string[] {
  const children = node.props.children;
  if (typeof children === 'string') return [children];
  return (children ?? []).flatMap(lines);
}

/**
 * satori's laid-out `<text>` boxes (embedFont: false keeps text as `<text>`
 * elements). satori's `y` is the BASELINE and `height` the line-box height
 * (font-size × line-height); it centres the hhea content area (ascender −
 * descender) in the line box, so the line box top is
 * `y − (height − content) / 2 − ascender` (verified against satori's own layout).
 */
async function textBoxes(tree: OgNode) {
  const svg = await satori(tree, { width: OG_WIDTH, height: OG_HEIGHT, fonts: fonts.satori, embedFont: false });
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"([^>]*)>([^<]*)<\/text>/g)].map((m) => {
    const attrs = m[5]!;
    const size = Number(/font-size="([\d.]+)"/.exec(attrs)![1]);
    const family = /font-family="([^"]+)"/.exec(attrs)![1] === 'inter' ? 'Inter' : 'Source Serif 4';
    const style = /font-style="italic"/.test(attrs) ? 'italic' : 'normal';
    const font = fonts.metrics[`${family}/${style}`]![0]!;
    const ascent = (font.ascender / font.unitsPerEm) * size;
    const content = ((font.ascender - font.descender) / font.unitsPerEm) * size;
    const baseline = Number(m[2]);
    const height = Number(m[4]);
    return { x: Number(m[1]), top: baseline - (height - content) / 2 - ascent, width: Number(m[3]), height, text: m[6]! };
  });
}

const project = (name: string, outcome: string): OgProject => ({
  slug: 'x',
  name: { id: name, en: name },
  oneLineOutcome: { id: outcome, en: outcome },
});

const LONG_NAME =
  'Sistem Order Distribusi Nasional Terpadu untuk Seluruh Gudang, Toko, Distributor dan Mitra Logistik di Indonesia';
const LONG_OUTCOME = Array.from({ length: 12 }, () => 'Order toko ke distributor tersambung langsung ke stok real-time.').join(' ');

describe('renderer output', () => {
  it('site images are 1200×630 8-bit RGB PNGs in each language', async () => {
    for (const lang of ['id', 'en'] as const) expectOgPng(await renderSiteImage({ lang, content, colors, fonts }));
  });

  it('every committed project renders a 1200×630 8-bit RGB PNG in each language', async () => {
    expect(content.projects.length).toBeGreaterThan(0);
    for (const lang of ['id', 'en'] as const) {
      for (const p of content.projects) expectOgPng(await renderProjectImage({ lang, content, colors, fonts }, p));
    }
  });

  it('rendering is deterministic (same input → same bytes)', async () => {
    const input = { lang: 'id' as const, content, colors, fonts };
    expect(Buffer.compare(await renderSiteImage(input), await renderSiteImage(input))).toBe(0);
  });

  it('text is in the image language: caps credit uppercased, job title per language', () => {
    for (const lang of ['id', 'en'] as const) {
      const text = lines(siteImageTree({ lang, content, colors, fonts }));
      expect(text).toEqual([content.credit[lang].toLocaleUpperCase(lang), content.name, content.jobTitle[lang]]);
    }
    expect(lines(siteImageTree({ lang: 'id', content, colors, fonts }))[0]).toBe('JUN STUDIO MEMPERSEMBAHKAN');
    expect(lines(siteImageTree({ lang: 'en', content, colors, fonts }))[0]).toBe('JUN STUDIO PRESENTS');
    const p = content.projects[0]!;
    const text = lines(projectImageTree({ lang: 'en', content, colors, fonts }, p));
    expect(text[0]).toBe('JUN STUDIO PRESENTS');
    expect(text.join(' ')).toContain(p.name.en);
    expect(text.at(-1)).toBe(content.name);
  });

  it('matrix: a long project name wraps to 2 lines + ellipsis; the outcome to at most 3', async () => {
    const tree = projectImageTree({ lang: 'id', content, colors, fonts }, project(LONG_NAME, LONG_OUTCOME));
    const [, middle] = tree.props.children as OgNode[];
    const [nameBlock, outcomeBlock] = middle!.props.children as OgNode[];
    const nameLines = lines(nameBlock!);
    expect(nameLines).toHaveLength(2);
    expect(nameLines[1]!.endsWith(ELLIPSIS)).toBe(true);
    expect(LONG_NAME.startsWith(nameLines[0]!)).toBe(true);
    const outcomeLines = lines(outcomeBlock!);
    expect(outcomeLines).toHaveLength(3);
    expect(outcomeLines[2]!.endsWith(ELLIPSIS)).toBe(true);
    expectOgPng(await renderProjectImage({ lang: 'id', content, colors, fonts }, project(LONG_NAME, LONG_OUTCOME)));
  });

  it('laid-out text stays inside the 64 px safe margin (no clipped text), long or short', async () => {
    const trees = [
      projectImageTree({ lang: 'id', content, colors, fonts }, project(LONG_NAME, LONG_OUTCOME)),
      projectImageTree({ lang: 'en', content, colors, fonts }, project('WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 'MMMM '.repeat(80))),
      siteImageTree({ lang: 'id', content, colors, fonts }),
      ...content.projects.map((p) => projectImageTree({ lang: 'id', content, colors, fonts }, p)),
    ];
    for (const tree of trees) {
      const boxes = (await textBoxes(tree)).filter((box) => box.text.trim() !== '');
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box.x, box.text).toBeGreaterThanOrEqual(MARGIN - 0.01);
        expect(box.x + box.width, box.text).toBeLessThanOrEqual(OG_WIDTH - MARGIN + 0.01);
        expect(box.top, box.text).toBeGreaterThanOrEqual(MARGIN - 0.5);
        expect(box.top + box.height, box.text).toBeLessThanOrEqual(OG_HEIGHT - MARGIN + 0.5);
      }
      // Each line element is laid out on one row: as many distinct line tops as lines.
      expect(new Set(boxes.map((box) => box.top.toFixed(2))).size).toBe(lines(tree).length);
    }
  });

  it('non-ASCII text renders without throwing', async () => {
    const names = ['Łódź — Café Ñandú «Ğüşİ» “quoted” 3–4 €', 'Sistem Antrean Rumah Sakit · Kecamatan Cimahi', '東京 مرحبا Привет'];
    for (const name of names) {
      const p = project(name, `${name} — ${name}`);
      expectOgPng(await renderProjectImage({ lang: 'id', content, colors, fonts }, p));
      expectOgPng(await renderSiteImage({ lang: 'en', content: { ...content, name, jobTitle: p.name }, colors, fonts }));
    }
  });
});

describe('wrapText', () => {
  // Every character is 10 px wide.
  const measure = (text: string) => [...text].length * 10;

  it('short text stays on one line; whitespace is collapsed; blank text gives no line', () => {
    expect(wrapText('  Halo   dunia ', { maxWidth: 200, maxLines: 2, measure })).toEqual(['Halo dunia']);
    expect(wrapText('   ', { maxWidth: 200, maxLines: 2, measure })).toEqual([]);
  });

  it('wraps greedily by words within maxWidth', () => {
    expect(wrapText('aaa bbb ccc ddd', { maxWidth: 70, maxLines: 3, measure })).toEqual(['aaa bbb', 'ccc ddd']);
  });

  it('text past maxLines is cut and the last line ends in an ellipsis that fits', () => {
    // "ccc ddd…" is 80 px > 70: the whole last word goes.
    const result = wrapText('aaa bbb ccc ddd eee fff', { maxWidth: 70, maxLines: 2, measure });
    expect(result).toEqual(['aaa bbb', `ccc${ELLIPSIS}`]);
    for (const line of result) expect(measure(line)).toBeLessThanOrEqual(70);
    expect(wrapText('aaa bb ccc dd eee', { maxWidth: 70, maxLines: 2, measure })).toEqual(['aaa bb', `ccc dd${ELLIPSIS}`]);
  });

  it('the ellipsis drops trailing punctuation and spaces', () => {
    expect(wrapText('abc, def ghi', { maxWidth: 50, maxLines: 1, measure })).toEqual([`abc${ELLIPSIS}`]);
  });

  it('a word wider than a line is broken by character', () => {
    expect(wrapText('abcdefghij xy', { maxWidth: 40, maxLines: 5, measure })).toEqual(['abcd', 'efgh', 'ij', 'xy']);
    const cut = wrapText('abcdefghijkl', { maxWidth: 40, maxLines: 2, measure });
    expect(cut).toEqual(['abcd', `efg${ELLIPSIS}`]);
  });

  it('exactly maxLines of text gets no ellipsis', () => {
    expect(wrapText('aaa bbb ccc', { maxWidth: 30, maxLines: 3, measure })).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('rejects invalid options', () => {
    expect(() => wrapText('a', { maxWidth: 0, maxLines: 1, measure })).toThrow(/invalid options/);
    expect(() => wrapText('a', { maxWidth: 10, maxLines: 0, measure })).toThrow(/invalid options/);
  });

  it('fontMeasure uses the first subset that has the glyph, a fallback width otherwise', () => {
    const latin = { unitsPerEm: 1000, ascender: 800, descender: -200, advance: (cp: number) => (cp < 0x100 ? 500 : undefined) };
    const ext = { unitsPerEm: 2000, ascender: 1600, descender: -400, advance: (cp: number) => (cp < 0x250 ? 2000 : undefined) };
    const m = fontMeasure([latin, ext], 20, 1, 0.6);
    expect(m('a')).toBeCloseTo(10 + 1);
    expect(m('Ł')).toBeCloseTo(20 + 1);
    expect(m('東')).toBeCloseTo(12 + 1);
    expect(() => fontMeasure([], 20)).toThrow(/no font metrics/);
  });

  it('real font metrics: wider text measures wider', () => {
    const m = fontMeasure(fonts.metrics['Source Serif 4/normal']!, OG_TYPE.projectName.size);
    expect(m('W')).toBeGreaterThan(m('i'));
    expect(m('Jujun Setiawan')).toBeGreaterThan(300);
  });
});

describe('colours, fonts and licences', () => {
  it('colours are the tokens.css values; none is pure white', () => {
    const tokens = parseCssTokens(tokensCss);
    for (const [role, property] of Object.entries(OG_COLOR_TOKENS)) {
      expect(colors[role as keyof OgColors].toLowerCase()).toBe(tokens.get(property)!.toLowerCase());
    }
    for (const value of Object.values(colors)) expect(value.toUpperCase()).not.toBe('#FFFFFF');
  });

  it('a missing or non-opaque token fails naming the property', () => {
    expect(() => ogColors(tokensCss.replace(/--ink-soft:[^;]+;/, ''))).toThrow('--ink-soft is missing');
    expect(() => ogColors(tokensCss.replace(/--surface-panel:[^;]+;/, '--surface-panel: #06050480;'))).toThrow(
      '--surface-panel must be an opaque #RRGGBB colour',
    );
  });

  it('fonts: weight 400 .woff, Source Serif 4 latin + latin-ext normal + italic, Inter latin + latin-ext', () => {
    expect(OG_FONT_FILES.map((f) => f.specifier).sort()).toEqual(
      [
        '@fontsource/inter/files/inter-latin-400-normal.woff',
        '@fontsource/inter/files/inter-latin-ext-400-normal.woff',
        '@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff',
        '@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff',
        '@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-italic.woff',
        '@fontsource/source-serif-4/files/source-serif-4-latin-ext-400-normal.woff',
      ].sort(),
    );
    expect(fonts.satori.every((f) => f.weight === 400)).toBe(true);
  });

  it('dependencies are exact devDependency pins; both fonts are in licenses/assets.yaml as OFL-1.1 fonts used in og-images', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const pins = {
      satori: '0.63.2',
      '@resvg/resvg-js': '2.6.2',
      '@fontsource/source-serif-4': '5.3.1',
      '@fontsource/inter': '5.3.0',
    };
    for (const [name, version] of Object.entries(pins)) {
      expect(pkg.devDependencies[name], name).toBe(version);
      expect(pkg.dependencies[name], name).toBeUndefined();
    }
    const record = parseYaml(readFileSync(path.join(repoRoot, 'licenses/assets.yaml'), 'utf8')) as {
      assets: { id: string; kind?: string; licence: string; source: string; 'used-in': string[] }[];
    };
    for (const pkgName of ['@fontsource/source-serif-4', '@fontsource/inter'] as const) {
      const entry = record.assets.find((a) => a.source === `npm ${pkgName} ${pins[pkgName]}`);
      expect(entry, pkgName).toBeDefined();
      expect(entry).toMatchObject({ kind: 'font', licence: 'OFL-1.1', 'used-in': ['og-images'] });
    }
  });

  it('the renderer and fonts are never imported by pages, components or layouts', () => {
    const scan = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? scan(full) : [full];
      });
    for (const dir of ['src/pages', 'src/components', 'src/layouts']) {
      for (const file of scan(path.join(repoRoot, dir))) {
        const source = readFileSync(file, 'utf8');
        expect(source, file).not.toMatch(/satori|resvg|@fontsource|og\/render|og\/fonts|og\/content|og-images/);
      }
    }
  });
});

describe('PNG helpers', () => {
  it('encodeRgbPng rejects transparency and wrong buffer sizes', () => {
    const rgba = new Uint8Array(2 * 2 * 4).fill(255);
    expect(readPngHeader(encodeRgbPng(rgba, 2, 2))).toEqual({ width: 2, height: 2, bitDepth: 8, colorType: PNG_COLOR_RGB });
    rgba[7] = 0;
    expect(() => encodeRgbPng(rgba, 2, 2)).toThrow(/pixel \(1, 0\) is not opaque/);
    expect(() => encodeRgbPng(new Uint8Array(3), 2, 2)).toThrow(/expected 16 RGBA bytes/);
  });

  it('readPngHeader returns null for non-PNG bytes', () => {
    expect(readPngHeader(Buffer.from('not a png at all, definitely not one'))).toBeNull();
  });
});

describe('writeOgImages', () => {
  it('writes the site image and every project image per language', async () => {
    const dist = path.join(tmpRoot, 'dist-ok');
    const written = await writeOgImages(dist, { rootDir: repoRoot, contentDir: path.join(repoRoot, 'content') });
    expect([...written].sort()).toEqual(expectedImagePaths(content.projects.map((p) => p.slug)));
    expect(written).toContain(siteImagePath('id'));
    expect(written).toContain(projectImagePath('en', content.projects[0]!.slug));
    for (const file of written) expectOgPng(readFileSync(path.join(dist, file)));
  });

  it('an empty CONTENT_DIR counts as unset (reads <root>/content)', async () => {
    const saved = process.env.CONTENT_DIR;
    process.env.CONTENT_DIR = '';
    try {
      const written = await writeOgImages(path.join(tmpRoot, 'dist-empty-env'), { rootDir: repoRoot });
      expect([...written].sort()).toEqual(expectedImagePaths(content.projects.map((p) => p.slug)));
    } finally {
      if (saved === undefined) delete process.env.CONTENT_DIR;
      else process.env.CONTENT_DIR = saved;
    }
  });

  it('a write failure fails naming the image', async () => {
    const blocker = path.join(tmpRoot, 'blocker');
    writeFileSync(blocker, 'not a directory');
    await expect(writeOgImages(blocker, { rootDir: repoRoot, contentDir: path.join(repoRoot, 'content') })).rejects.toThrow(
      /^og-images: cannot write dist\/og\/site-id\.png: /,
    );
  });

  it('matrix: a missing font fails naming the image', async () => {
    await expect(
      writeOgImages(path.join(tmpRoot, 'dist-no-font'), {
        rootDir: repoRoot,
        contentDir: path.join(repoRoot, 'content'),
        loadFonts: () =>
          loadOgFonts(repoRoot, [{ family: 'Inter', style: 'normal', specifier: '@fontsource/inter/files/inter-nope-400-normal.woff' }]),
      }),
    ).rejects.toThrow(/^og-images: cannot render dist\/og\/site-id\.png: og fonts: cannot read @fontsource\/inter\/files\/inter-nope-400-normal\.woff/);
  });

  it('matrix: a satori error fails naming the image', async () => {
    await expect(
      writeOgImages(path.join(tmpRoot, 'dist-satori'), {
        rootDir: repoRoot,
        contentDir: path.join(repoRoot, 'content'),
        loadFonts: async () => ({ ...fonts, satori: [] }),
      }),
    ).rejects.toThrow(/^og-images: cannot render dist\/og\/site-id\.png: /);
  });
});
