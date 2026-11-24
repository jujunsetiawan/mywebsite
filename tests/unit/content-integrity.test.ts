// Story 1.5 cross-entry rules (`src/content/integrity.ts`): matrix rows that a
// single-entry schema cannot see, and the committed content passing them.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  assertContentIntegrity,
  byOrder,
  checkContentIntegrity,
  ContentIntegrityError,
  type IntegrityInput,
} from '../../src/content/integrity.ts';
import { repoRoot } from './helpers/astro-build.ts';

const project = (id: string, slug = id, order = 1) => ({ id, data: { slug, order } });

function input(overrides: Partial<IntegrityInput> = {}): IntegrityInput {
  return {
    projects: [project('a', 'a', 1), project('b', 'b', 2)],
    awards: [
      { id: 'x', data: { order: 1 } },
      { id: 'y', data: { order: 2 } },
    ],
    testimonials: [
      { id: 't1', data: { order: 1, project: 'a' } },
      { id: 't2', data: { order: 2 } },
    ],
    ...overrides,
  };
}

describe('checkContentIntegrity', () => {
  it('valid content has no problems', () => {
    expect(checkContentIntegrity(input())).toEqual([]);
  });

  it('slug ≠ file name fails naming the entry and slug', () => {
    expect(checkContentIntegrity(input({ projects: [project('a', 'a', 1), project('b', 'c', 2)] }))).toEqual([
      'projects → b: slug — must equal the file name "b" (content/projects/b.yaml), got "c"',
    ]);
  });

  it('duplicate slug fails naming both entries', () => {
    const problems = checkContentIntegrity(input({ projects: [project('a', 'a', 1), project('b', 'a', 2)] }));
    expect(problems).toContain('projects → a, b: slug — duplicate "a"');
  });

  it('duplicate project order fails naming both entries', () => {
    expect(checkContentIntegrity(input({ projects: [project('a', 'a', 1), project('b', 'b', 1)] }))).toEqual([
      'projects → a, b: order — duplicate 1',
    ]);
  });

  it('duplicate award and testimonial order fail naming both entries', () => {
    const problems = checkContentIntegrity(
      input({
        awards: [
          { id: 'x', data: { order: 3 } },
          { id: 'y', data: { order: 3 } },
        ],
        testimonials: [
          { id: 't1', data: { order: 1 } },
          { id: 't2', data: { order: 1 } },
        ],
      }),
    );
    expect(problems).toEqual(['awards → x, y: order — duplicate 3', 'testimonials → t1, t2: order — duplicate 1']);
  });

  it('unknown testimonial project fails naming the testimonial and project', () => {
    expect(
      checkContentIntegrity(input({ testimonials: [{ id: 't1', data: { order: 1, project: 'nope' } }] })),
    ).toEqual(['testimonials → t1: project — no project with slug "nope"']);
  });

  it('a testimonial may reference no project', () => {
    expect(checkContentIntegrity(input({ testimonials: [{ id: 't1', data: { order: 1 } }] }))).toEqual([]);
  });
});

describe('assertContentIntegrity', () => {
  it('throws listing every problem', () => {
    const broken = input({
      projects: [project('a', 'b', 1)],
      testimonials: [{ id: 't1', data: { order: 1, project: 'nope' } }],
    });
    expect(() => assertContentIntegrity(broken)).toThrow(ContentIntegrityError);
    expect(() => assertContentIntegrity(broken)).toThrow(
      /projects → a: slug — must equal the file name[\s\S]*testimonials → t1: project — no project with slug "nope"/,
    );
  });

  it('does not throw for valid content', () => {
    expect(() => assertContentIntegrity(input())).not.toThrow();
  });
});

describe('byOrder', () => {
  it('sorts by order without mutating the input', () => {
    const items = [project('c', 'c', 3), project('a', 'a', 1), project('b', 'b', 2)];
    expect(byOrder(items).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(items.map(({ id }) => id)).toEqual(['c', 'a', 'b']);
  });
});

describe('committed content', () => {
  const read = (collection: string) =>
    readdirSync(path.join(repoRoot, 'content', collection))
      .filter((name) => name.endsWith('.yaml'))
      .map((name) => ({
        id: name.replace(/\.yaml$/, ''),
        data: parseYaml(readFileSync(path.join(repoRoot, 'content', collection, name), 'utf8')),
      }));

  it('passes every cross-entry rule', () => {
    expect(
      checkContentIntegrity({ projects: read('projects'), awards: read('awards'), testimonials: read('testimonials') }),
    ).toEqual([]);
  });
});
