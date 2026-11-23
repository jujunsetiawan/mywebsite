import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkFile,
  checkLayers,
  extractImports,
  findBrowserGlobals,
  sanitize,
} from '../../scripts/budgets/layer-imports.ts';

const fixtures = path.resolve(import.meta.dirname, 'fixtures/layers');

describe('layer-import check on fixtures', () => {
  it('clean tree passes', () => {
    expect(checkLayers(path.join(fixtures, 'clean'))).toEqual([]);
  });

  it('violating tree reports every file + rule', () => {
    const violations = checkLayers(path.join(fixtures, 'violating'));
    const summary = violations.map((v) => `${v.file}|${v.rule}|${v.detail}`);

    expect(summary).toContain(
      "src/film/systems/bad.ts|systems-no-adapters-or-browser|imports src/film/adapters via '../adapters/dom.ts'",
    );
    expect(summary).toContain(
      "src/film/systems/bad.ts|systems-no-adapters-or-browser|imports src/film/adapters via '/src/film/adapters/dom.ts'",
    );
    expect(summary).toContain(
      "src/film/systems/bad.ts|systems-no-adapters-or-browser|references browser global 'window'",
    );
    expect(summary).toContain(
      "src/film/core/bad-core.ts|core-no-systems-or-adapters|imports src/film/systems via '../systems/bad.ts'",
    );
    expect(summary).toContain(
      "src/pages/index.astro|pages-no-core-or-systems|imports src/film/core via '../film/core/bad-core.ts'",
    );
    // Adapters may use browser globals.
    expect(violations.some((v) => v.file.includes('adapters'))).toBe(false);
    expect(violations).toHaveLength(5);
  });

  it('reports line numbers', () => {
    const [first] = checkLayers(path.join(fixtures, 'violating')).filter((v) => v.detail.includes('window'));
    expect(first?.line).toBe(5);
  });
});

describe('checkFile rules', () => {
  it('core must not import adapters', () => {
    const v = checkFile('src/film/core/a.ts', "import x from '../adapters/b.ts';");
    expect(v.map((x) => x.rule)).toEqual(['core-no-systems-or-adapters']);
  });

  it('pages must not import systems via alias', () => {
    const v = checkFile('src/pages/x.astro', "---\nimport s from '/src/film/systems/s.ts';\n---\n<p/>");
    expect(v.map((x) => x.rule)).toEqual(['pages-no-core-or-systems']);
  });

  it('pages must not import core from an .astro <script> body', () => {
    const v = checkFile('src/pages/x.astro', "<p/>\n<script>\n  import a from '/src/film/core/a.ts';\n</script>");
    expect(v.map((x) => x.rule)).toEqual(['pages-no-core-or-systems']);
  });

  it('pages may import adapters', () => {
    expect(checkFile('src/pages/x.astro', "---\nimport a from '../film/adapters/a.ts';\n---")).toEqual([]);
  });

  it('files outside ruled dirs are ignored', () => {
    expect(checkFile('src/layouts/L.astro', "---\nimport s from '../film/systems/s.ts';\n---")).toEqual([]);
  });

  it('each browser global is detected in systems', () => {
    for (const g of ['navigator', 'localStorage', 'sessionStorage', 'requestAnimationFrame', 'location', 'HTMLElement', 'matchMedia', 'document']) {
      const v = checkFile('src/film/systems/s.ts', `export const x = ${g};`);
      expect(v, g).toHaveLength(1);
    }
  });
});

describe('scanner helpers', () => {
  it('extracts static, re-export, side-effect and dynamic imports', () => {
    const specs = extractImports(
      [
        "import a from './a.ts';",
        "import type { B } from './b.ts';",
        "export { c } from './c.ts';",
        "export * from './d.ts';",
        "import './e.ts';",
        "const f = await import('./f.ts');",
        '// import g from "./g.ts";',
      ].join('\n'),
    ).map((r) => r.specifier);
    expect(specs).toEqual(['./a.ts', './b.ts', './c.ts', './d.ts', './e.ts', './f.ts']);
  });

  it('ignores globals in comments, strings and property access', () => {
    const code = "// window\nconst s = 'document'; obj.location = 1; const t = `${'x'} navigator`;";
    expect(findBrowserGlobals(code)).toEqual([]);
  });

  it('ignores property keys and member names but flags ternary branches', () => {
    expect(findBrowserGlobals('const o = { location: 1 }; type T = { document?: string };')).toEqual([]);
    expect(findBrowserGlobals('const w = ok ? window : null;').map((g) => g.name)).toEqual(['window']);
  });

  it('detects globals inside template expressions', () => {
    expect(findBrowserGlobals('const t = `${window.innerWidth}px`;').map((g) => g.name)).toEqual(['window']);
  });

  it('sanitize preserves length and line breaks', () => {
    const src = "a /* x\ny */ 'z'\n// c";
    const out = sanitize(src, true);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(3);
  });
});
