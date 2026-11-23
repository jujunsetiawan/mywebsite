import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const fixtureRoot = path.join(import.meta.dirname, 'fixtures/content-build');
const astroBin = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');

afterAll(() => {
  for (const dir of ['dist', '.astro', 'node_modules']) {
    rmSync(path.join(fixtureRoot, dir), { recursive: true, force: true });
  }
});

describe('astro build with an invalid content entry', () => {
  it('exits non-zero naming the entry and the field path', () => {
    const run = spawnSync(process.execPath, [astroBin, 'build', '--root', fixtureRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      timeout: 120_000,
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(run.error, output).toBeUndefined();
    expect(run.signal, output).toBeNull();
    expect(run.status, output).not.toBe(0);
    expect(output).toMatch(/projects → broken/);
    expect(output).toMatch(/title\.en/);
  }, 120_000);
});
