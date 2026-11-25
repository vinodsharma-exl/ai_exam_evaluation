/**
 * Crash-safe file writes: write to a temp file in the same folder, fsync, then rename over the target.
 * A reader always sees either the old or the new file, never a half-written one.
 *
 * On Windows, rename can fail briefly with EPERM/EBUSY/EACCES while antivirus or the search indexer has
 * the target open. We retry for up to ~1.5s before giving up.
 */
import { promises as fs } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 700];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (!RETRY_CODES.has(code) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeFileAtomic(target, JSON.stringify(value, null, 2) + '\n');
}

/** Copy a file into place atomically (e.g. an uploaded PDF), so a crash never leaves a truncated copy. */
export async function copyFileAtomic(src: string, target: string): Promise<void> {
  const dir = dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.copyFile(src, tmp);
  try {
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Removes stale *.tmp files left by a crash. Called once at startup on the data dir. */
export async function cleanupTempFiles(root: string, maxDepth = 6): Promise<number> {
  let removed = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.name.startsWith('.') && e.name.endsWith('.tmp')) {
        await fs.rm(p, { force: true }).catch(() => undefined);
        removed++;
      }
    }
  }
  await walk(root, 0);
  return removed;
}
