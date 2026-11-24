// Story 1.3: office-styled static layout — keyboard, focus, hit areas, flags,
// bar sizing and reflow. Local build (flags off) served by `wrangler dev`.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

/** Number of entries in a content collection (each renders one focusable link on the homes). */
const entryCount = (collection: string) =>
  readdirSync(path.join(process.cwd(), 'content', collection)).filter((name) => name.endsWith('.yaml')).length;
/** Tab steps for the probe walk: fixed chrome/probe base (Story 1.4) + project and award links. */
const TAB_BUDGET = 10 + entryCount('projects') + entryCount('awards');

const LANGS = [
  { lang: 'id', credit: 'Jun Studio mempersembahkan', projects: 'Proyek', skip: 'Langsung ke konten' },
  { lang: 'en', credit: 'Jun Studio presents', projects: 'Projects', skip: 'Skip to content' },
] as const;

/** Expected letterbox bar height for a viewport: clamp(40px, 10dvh, 96px), 40px when tiny/short. */
function expectedBarHeight(width: number, height: number): number {
  if (width <= 320 || height <= 480) return 40;
  return Math.min(96, Math.max(40, height * 0.1));
}

async function barHeights(page: Page) {
  return page.evaluate(() => {
    const h = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().height;
    return { top: h('header.bar--top'), bottom: h('footer.bar--bottom') };
  });
}

function tabKey(shift = false): string {
  return shift ? 'Shift+Tab' : 'Tab';
}

/**
 * Playwright's WebKit (like Safari with "Press Tab to highlight each item" off)
 * never moves Tab focus to links, and Option/Alt+Tab does not help on the
 * Windows/Linux builds — CI's WebKit covers logic/layout only. Keyboard paths
 * are proven in the Chromium projects (desktop, 390×844, 844×390).
 */
function skipKeyboardOnWebKit(browserName: string) {
  test.skip(browserName === 'webkit', 'Playwright WebKit does not Tab to links (layout-only coverage)');
}

async function activeInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    return {
      id: el.id,
      className: el.className,
      text: el.textContent?.trim() ?? '',
      chrome: el.dataset.chrome ?? null,
      inBar: el.closest('.bar') !== null || el.classList.contains('skip-link'),
      top: r.top,
      bottom: r.bottom,
      viewport: window.innerHeight,
    };
  });
}

for (const copy of LANGS) {
  test.describe(`/${copy.lang}/ static layout`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/${copy.lang}/`);
    });

    test('renders bars, credit line, projects link and footer in the page language', async ({ page }) => {
      const header = page.locator('header.bar--top');
      await expect(header).toBeVisible();
      await expect(page.locator('footer.bar--bottom')).toBeVisible();
      await expect(header.locator('[data-chrome="credit"]')).toHaveText(copy.credit);
      await expect(header.locator('[data-chrome="credit"]')).toHaveAttribute('href', `/${copy.lang}/`);
      await expect(header.locator('[data-chrome="projects"]')).toHaveText(copy.projects);
      await expect(header.locator('[data-chrome="projects"]')).toHaveAttribute('href', `/${copy.lang}/#proyek`);
      await expect(page.locator('main#main')).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Jujun Setiawan');
      for (const sel of ['header.bar--top', 'footer.bar--bottom']) {
        const style = await page.locator(sel).evaluate((el) => {
          const cs = getComputedStyle(el);
          return { bg: cs.backgroundColor, position: cs.position };
        });
        expect(style.bg, sel).toBe('rgb(0, 0, 0)');
        expect(style.position, sel).toBe('sticky');
      }
    });

    test('flag-gated items and film-only toggles are absent while flags are off', async ({ page }) => {
      for (const key of ['skip-story', 'awards', 'contact']) {
        await expect(page.locator(`[data-chrome="${key}"]`)).toHaveCount(0);
      }
      // The bars hold no hub/contact items; the awards section in the content is Story 1.5's.
      for (const bar of ['header.bar--top', 'footer.bar--bottom']) {
        await expect(page.locator(bar)).not.toContainText(/Lewati Cerita|Skip Story|Penghargaan|Awards|Hubungi|Contact/);
      }
      await expect(page.locator('body')).not.toContainText(/Lewati Cerita|Skip Story|Hubungi|Contact/);
      await expect(page.locator('button')).toHaveCount(0);
    });

    test('skip link is first in tab order and moves focus to #main', async ({ page, browserName }) => {
      skipKeyboardOnWebKit(browserName);
      await page.keyboard.press(tabKey());
      const first = await activeInfo(page);
      expect(first?.className).toContain('skip-link');
      await expect(page.locator('.skip-link')).toHaveText(copy.skip);
      const box = await page.locator('.skip-link').boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
      await expect.poll(async () => (await activeInfo(page))?.id).toBe('main');
    });

    test('focus ring: 2px ink.primary outline with a 4px black halo', async ({ page, browserName }) => {
      skipKeyboardOnWebKit(browserName);
      await page.keyboard.press(tabKey()); // skip link
      await page.keyboard.press(tabKey()); // first visible chrome link
      const ring = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          style: cs.outlineStyle,
          width: cs.outlineWidth,
          color: cs.outlineColor,
          shadow: cs.boxShadow,
        };
      });
      expect(ring.tag).toBe('A');
      expect(ring.style).toBe('solid');
      expect(ring.width).toBe('2px');
      expect(ring.color).toBe('rgb(241, 235, 224)');
      expect(ring.shadow).toBe('rgb(0, 0, 0) 0px 0px 0px 4px');
    });

    test('every visible interactive target is at least 44x44 px', async ({ page }) => {
      const targets = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
          .filter((el) => {
            const cs = getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.clipPath === 'none' && el.id !== 'main';
          })
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { label: el.dataset.chrome ?? el.textContent?.trim() ?? el.tagName, w: r.width, h: r.height };
          }),
      );
      expect(targets.length).toBeGreaterThan(0);
      for (const t of targets) {
        expect(t.w, `${t.label} width`).toBeGreaterThanOrEqual(44);
        expect(t.h, `${t.label} height`).toBeGreaterThanOrEqual(44);
      }
    });

    test('focused elements in the content never sit under the letterbox bars', async ({ page, browserName }) => {
      skipKeyboardOnWebKit(browserName);
      // Make the page long and give it focusable content far below the fold.
      // (CSSOM changes from the test are not subject to the page CSP.)
      await page.evaluate(() => {
        const main = document.getElementById('main')!;
        for (let i = 0; i < 3; i += 1) {
          const spacer = document.createElement('div');
          spacer.style.height = '1500px';
          main.append(spacer);
          const link = document.createElement('a');
          link.href = `#probe-${i}`;
          link.textContent = `probe ${i}`;
          link.className = 'probe';
          main.append(link);
        }
      });
      const { top: barH, bottom: footH } = await barHeights(page);
      const visit = async (shift: boolean, steps: number) => {
        const probes = new Set<string>();
        for (let i = 0; i < steps; i += 1) {
          await page.keyboard.press(tabKey(shift));
          const info = await activeInfo(page);
          if (!info || info.inBar || info.id === 'main') continue;
          if (info.className === 'probe') probes.add(info.text);
          expect(info.top, `${info.text} top`).toBeGreaterThanOrEqual(barH - 0.5);
          expect(info.bottom, `${info.text} bottom`).toBeLessThanOrEqual(info.viewport - footH + 0.5);
        }
        return [...probes].sort();
      };
      // Not vacuous: all three probes far below the fold are focused both ways.
      // Step budget: the Story 1.4 base (skip link + credit + projects + ID/EN
      // switch + 3 probes + slack) plus one link per project and award entry.
      const all = ['probe 0', 'probe 1', 'probe 2'];
      expect(await visit(false, TAB_BUDGET)).toEqual(all);
      expect(await visit(true, TAB_BUDGET)).toEqual(all);
      // After the skip link, the top of the content is not hidden under the top bar.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.locator('.skip-link').focus();
      await page.keyboard.press('Enter');
      const mainTop = await page.locator('#main').evaluate((el) => el.getBoundingClientRect().top);
      expect(mainTop).toBeGreaterThanOrEqual(barH - 0.5);
    });
  });
}

// ---------- Bar height and reflow ----------

const SIZES = [
  { name: '320x640', width: 320, height: 640 },
  { name: '400pct-zoom-1280x720', width: 320, height: 180 },
  { name: '390x844', width: 390, height: 844 },
  { name: '844x390', width: 844, height: 390 },
  { name: '1440x900', width: 1440, height: 900 },
] as const;

// WCAG 1.4.12 text-spacing bookmarklet values.
const TEXT_SPACING_CSS = `* {
  line-height: 1.5 !important;
  letter-spacing: 0.12em !important;
  word-spacing: 0.16em !important;
}
p { margin-bottom: 2em !important; }`;

/** Problems: horizontal scroll, text outside the viewport, text spilling out of a bar or clipped by overflow. */
async function reflowProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    const vw = root.clientWidth;
    if (root.scrollWidth > vw) problems.push(`horizontal scroll: scrollWidth ${root.scrollWidth} > ${vw}`);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      // Skip link and visually hidden text are intentionally clipped.
      if (!text || !parent || parent.closest('.skip-link, .visually-hidden')) continue;
      const cs = getComputedStyle(parent);
      if (cs.visibility === 'hidden' || parent.getClientRects().length === 0) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.right > vw + 0.5) problems.push(`"${text}" outside viewport (${r.left}..${r.right} of ${vw})`);
      const bar = parent.closest('.bar');
      if (bar) {
        const b = bar.getBoundingClientRect();
        if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)
          problems.push(`"${text}" spills out of its bar (${r.top}..${r.bottom} vs ${b.top}..${b.bottom})`);
      }
      for (let el: Element | null = parent; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        if (s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1)
          problems.push(`"${text}" clipped horizontally by <${el.tagName.toLowerCase()}>`);
        if (s.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1)
          problems.push(`"${text}" clipped vertically by <${el.tagName.toLowerCase()}>`);
      }
    }
    return problems;
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

function desktopProjectsOnly(testInfo: TestInfo) {
  // The size matrix sets its own viewports; running it under the mobile
  // projects would only repeat the same sizes.
  test.skip(testInfo.project.name.startsWith('mobile'), 'size matrix runs in the desktop projects');
}

for (const size of SIZES) {
  test.describe(`reflow at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    for (const { lang } of LANGS) {
      test(`/${lang}/ has no horizontal scroll or clipped text, bars sized`, async ({ page }, testInfo) => {
        desktopProjectsOnly(testInfo);
        await page.goto(`/${lang}/`);
        expect(await reflowProblems(page)).toEqual([]);
        const bars = await barHeights(page);
        const expected = expectedBarHeight(size.width, size.height);
        expect(bars.top).toBeCloseTo(expected, 0);
        expect(bars.bottom).toBeCloseTo(expected, 0);
        const creditVisible = await page.locator('[data-chrome="credit"]').isVisible();
        expect(creditVisible).toBe(size.width >= 760);
        await attachScreenshot(page, testInfo, `${lang}-${size.name}.png`);
      });
    }
  });

  test.describe(`reflow at ${size.name} with WCAG text-spacing overrides`, () => {
    // The page CSP (`style-src 'self'`) would block the injected override sheet.
    test.use({ viewport: { width: size.width, height: size.height }, bypassCSP: true });

    test('/id/ has no horizontal scroll or clipped text', async ({ page }, testInfo) => {
      desktopProjectsOnly(testInfo);
      await page.goto('/id/');
      await page.addStyleTag({ content: TEXT_SPACING_CSS });
      // The override really applies (0.12em of the 16px body text).
      expect(await page.locator('#main').evaluate((el) => getComputedStyle(el).letterSpacing)).toBe('1.92px');
      expect(await reflowProblems(page)).toEqual([]);
      await attachScreenshot(page, testInfo, `id-${size.name}-text-spacing.png`);
    });
  });
}

test.describe('bars drop to 40px', () => {
  for (const vp of [
    { width: 320, height: 900 },
    { width: 1280, height: 480 },
    { width: 844, height: 390 },
  ]) {
    test.describe(`${vp.width}x${vp.height}`, () => {
      test.use({ viewport: vp });
      test('top and bottom bars are 40px', async ({ page }, testInfo) => {
        desktopProjectsOnly(testInfo);
        await page.goto('/id/');
        expect(await barHeights(page)).toEqual({ top: 40, bottom: 40 });
      });
    });
  }
});
