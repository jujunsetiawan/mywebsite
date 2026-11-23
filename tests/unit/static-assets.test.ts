import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  checkStaticAssets,
  formatStaticAssets,
  listFiles,
} from '../../scripts/budgets/static-assets.ts';

const many = (count: number) => Array.from({ length: count }, (_, i) => ({ path: `f${i}.html`, bytes: 10 }));

describe('checkStaticAssets', () => {
  it('uses the Workers free-tier limits', () => {
    expect(MAX_FILES).toBe(20_000);
    expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });

  it('passes at exactly 20,000 files and fails at 20,001', () => {
    expect(checkStaticAssets(many(20_000)).ok).toBe(true);
    expect(checkStaticAssets(many(20_001)).ok).toBe(false);
  });

  it('passes a file of exactly 25 MiB and fails one byte larger', () => {
    expect(checkStaticAssets([{ path: 'og.png', bytes: MAX_FILE_BYTES }]).ok).toBe(true);
    const result = checkStaticAssets([{ path: 'og.png', bytes: MAX_FILE_BYTES + 1 }]);
    expect(result.ok).toBe(false);
    expect(formatStaticAssets(result)).toContain('OVERSIZED: og.png');
  });

  it('lists files recursively with forward-slash paths', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'static-assets-'));
    try {
      mkdirSync(path.join(dir, 'id'));
      writeFileSync(path.join(dir, 'id', 'index.html'), 'abc');
      writeFileSync(path.join(dir, 'robots.txt'), 'x');
      const files = listFiles(dir).sort((a, b) => a.path.localeCompare(b.path));
      expect(files).toEqual([
        { path: 'id/index.html', bytes: 3 },
        { path: 'robots.txt', bytes: 1 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
