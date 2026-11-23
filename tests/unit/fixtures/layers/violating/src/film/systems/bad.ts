import { bind } from '../adapters/dom.ts';

export async function run(): Promise<number> {
  const lazy = await import('/src/film/adapters/dom.ts');
  return bind() + lazy.bind() + window.innerWidth;
}
