// Writes the environment-dependent deploy files into `dist/` after the build
// (Story 1.2): `robots.txt`, and for non-production an `X-Robots-Tag: noindex`
// line added to the `/*` rule of the shared `_headers` (copied from
// `public/_headers`). Workers static assets read a single `_headers` file and
// a second `/*` block replaces the first one's headers (verified with
// `wrangler dev`: the CSP disappeared), so the line goes into the existing
// `/*` block; a new block is appended only when there is none.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { isIndexable, type SiteConfig } from '../../config/site.schema.ts';

export const NOINDEX_HEADER_LINE = '  X-Robots-Tag: noindex';

export function robotsTxt(config: SiteConfig): string {
  return isIndexable(config) ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n';
}

/** `_headers` content for this environment, given the shared committed file (may be empty). */
export function headersFile(shared: string, config: SiteConfig): string {
  if (isIndexable(config)) return shared;
  const lines = shared === '' ? [] : shared.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const ruleIndex = lines.findIndex((line) => line.trimEnd() === '/*');
  if (ruleIndex === -1) {
    if (lines.length > 0) lines.push('');
    lines.push('/*', NOINDEX_HEADER_LINE);
  } else {
    lines.splice(ruleIndex + 1, 0, NOINDEX_HEADER_LINE);
  }
  return `${lines.join('\n')}\n`;
}

export async function writeEnvOutput(distDir: string, config: SiteConfig): Promise<void> {
  const headersPath = path.join(distDir, '_headers');
  let shared = '';
  try {
    shared = await readFile(headersPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(headersPath, headersFile(shared, config));
  await writeFile(path.join(distDir, 'robots.txt'), robotsTxt(config));
}

export default function siteEnv(config: SiteConfig): AstroIntegration {
  return {
    name: 'site-env',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        await writeEnvOutput(fileURLToPath(dir), config);
        logger.info(`env "${config.env}": robots.txt ${isIndexable(config) ? 'allows' : 'disallows'} crawling`);
      },
    },
  };
}
