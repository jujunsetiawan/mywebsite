// Story 1.6: the first-load budget measures the first project page by `order`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { firstProjectSlug } from '../../scripts/budgets/project-pages.ts';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'project-budget-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function dir(name: string, files: Record<string, string>): string {
  const target = path.join(tmpRoot, name);
  mkdirSync(target);
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(target, file), text);
  return target;
}

describe('firstProjectSlug', () => {
  it('picks the lowest order, not the first file', () => {
    const projects = dir('ordered', {
      'a-first-file.yaml': 'slug: a-first-file\norder: 3\n',
      'b-lowest.yaml': 'slug: b-lowest\norder: 1\n',
      'c-middle.yaml': 'slug: c-middle\norder: 2\n',
      'notes.txt': 'ignored',
    });
    expect(firstProjectSlug(projects)).toBe('b-lowest');
  });

  it('throws naming the file of an invalid entry', () => {
    const projects = dir('invalid', {
      'good.yaml': 'slug: good\norder: 1\n',
      'no-order.yaml': 'slug: no-order\norder: "2"\n',
    });
    expect(() => firstProjectSlug(projects)).toThrow(`invalid project ${path.join(projects, 'no-order.yaml')}`);
    const empty = dir('null-doc', { 'empty.yaml': '' });
    expect(() => firstProjectSlug(empty)).toThrow(`invalid project ${path.join(empty, 'empty.yaml')}`);
  });

  it('throws when the directory holds no project', () => {
    const projects = dir('none', { 'readme.txt': '' });
    expect(() => firstProjectSlug(projects)).toThrow(`no project (*.yaml) in ${projects}`);
  });
});
