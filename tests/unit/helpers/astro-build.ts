// Runs a real `astro build` of the repo root for unit tests.
//
// Builds of the same root share `.astro/.prerender`, so two test files
// building concurrently (Vitest runs files in parallel) race on emitted CSS
// (`ENOENT … rename .astro/.prerender/_astro/*.css`). A repo-local directory
// lock serialises them across Vitest workers.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const repoRoot = path.resolve(import.meta.dirname, '../../..');
const astroBin = path.join(repoRoot, 'node_modules/astro/bin/astro.mjs');
const LOCK_DIR = path.join(repoRoot, 'node_modules/.cache/astro-build.lock');
const PID_FILE = path.join(LOCK_DIR, 'pid');
const STALE_MS = 60_000;
const WAIT_LIMIT_MS = 10 * 60_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Stale when the owner pid is dead, or when the pid file is missing/unreadable
 * and the lock dir is older than STALE_MS (an owner between mkdir and writing
 * its pid is fresh, not stale).
 */
function isStale(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) return !isAlive(pid);
  } catch {
    // Missing pid file: fall through to the age check.
  }
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS;
  } catch {
    return false; // Lock already gone: just retry.
  }
}

/** Renames first so two waiters can never both delete (and then both take) the lock. */
function breakStaleLock(): void {
  const grave = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(LOCK_DIR, grave);
  } catch {
    return; // Someone else broke or released it first.
  }
  // Between our staleness check and the rename, another waiter may have broken
  // the stale lock and a live owner taken a fresh one: hand that one back.
  let pid = NaN;
  try {
    pid = Number(readFileSync(path.join(grave, 'pid'), 'utf8'));
  } catch {
    // No pid file: stale by age.
  }
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    try {
      renameSync(grave, LOCK_DIR);
    } catch {
      // Path re-taken meanwhile; leave the grave in place rather than delete a live lock.
    }
    return;
  }
  rmSync(grave, { recursive: true, force: true });
}

function withBuildLock<T>(fn: () => T): T {
  mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(PID_FILE, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale()) breakStaleLock();
      if (Date.now() - started > WAIT_LIMIT_MS) throw new Error(`timed out waiting for ${LOCK_DIR}`);
      sleep(200);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

/** `astro build --outDir <outDir>` of the repo root with extra env; returns the spawn result and combined output. */
export function astroBuild(
  outDir: string,
  env: Record<string, string>,
): { run: SpawnSyncReturns<string>; output: string } {
  return withBuildLock(() => {
    const run = spawnSync(process.execPath, [astroBin, 'build', '--outDir', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      timeout: 120_000,
    });
    return { run, output: `${run.stdout}\n${run.stderr}` };
  });
}
