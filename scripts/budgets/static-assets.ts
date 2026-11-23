// Static-asset limits for Cloudflare Workers static assets (free tier):
// at most 20,000 files and no single file larger than 25 MiB.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB

export interface AssetFile {
  /** Path relative to the dist root, forward slashes. */
  path: string;
  bytes: number;
}

export interface StaticAssetsResult {
  fileCount: number;
  maxFiles: number;
  maxFileBytes: number;
  oversized: AssetFile[];
  largest: AssetFile | null;
  ok: boolean;
}

export function checkStaticAssets(
  files: readonly AssetFile[],
  maxFiles: number = MAX_FILES,
  maxFileBytes: number = MAX_FILE_BYTES,
): StaticAssetsResult {
  const oversized = files.filter((f) => f.bytes > maxFileBytes);
  let largest: AssetFile | null = null;
  for (const f of files) if (largest === null || f.bytes > largest.bytes) largest = f;
  return {
    fileCount: files.length,
    maxFiles,
    maxFileBytes,
    oversized,
    largest,
    ok: files.length <= maxFiles && oversized.length === 0,
  };
}

export function listFiles(rootDir: string): AssetFile[] {
  const out: AssetFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.push({ path: path.relative(rootDir, full).split(path.sep).join('/'), bytes: statSync(full).size });
      }
    }
  };
  walk(rootDir);
  return out;
}

export function formatStaticAssets(result: StaticAssetsResult): string {
  const lines = [
    'Static-asset limits — dist/',
    `  files: ${result.fileCount} (limit ${result.maxFiles})`,
    `  largest: ${result.largest ? `${result.largest.path} ${result.largest.bytes} B` : '(none)'} (limit ${result.maxFileBytes} B per file)`,
    ...result.oversized.map((f) => `  OVERSIZED: ${f.path} ${f.bytes} B`),
    `  ${result.ok ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}
