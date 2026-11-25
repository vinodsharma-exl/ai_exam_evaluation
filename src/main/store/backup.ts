/**
 * ZIP backup and restore of the whole data folder.
 *
 * Backup: everything except backups/, temp files and secrets.bin. The keys are DPAPI-encrypted to this
 * Windows account, so they would be useless elsewhere, and a ZIP of student data should not carry keys.
 *
 * Restore (safe by design):
 *   1. Extract into a staging folder next to the data folder (zip-slip protected).
 *   2. Check it is an AnswerEval AI backup (manifest + valid config.json if present).
 *   3. Rename the current data folder to "<name>.before-restore-<timestamp>" (kept, not deleted).
 *   4. Rename staging into place and carry over the current secrets.bin.
 */
import { createWriteStream, promises as fs } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { ConfigFile } from '../../shared/schemas/config';
import { APP_NAME } from '../../shared/constants';
import { AppError } from '../../shared/errors';

export const MANIFEST_NAME = 'answereval-backup.json';
const EXCLUDE_TOP = new Set(['backups']);
const EXCLUDE_FILES = new Set(['secrets.bin']);

async function* walk(root: string, dir = root): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(root, full);
    const top = rel.split(sep)[0]!;
    if (EXCLUDE_TOP.has(top)) continue;
    if (e.isDirectory()) yield* walk(root, full);
    else if (e.isFile()) {
      if (EXCLUDE_FILES.has(e.name) || e.name.endsWith('.tmp') || e.name.startsWith('secrets.bin.')) continue;
      yield full;
    }
  }
}

export async function createBackup(dataDir: string, outFile: string, appVersion: string): Promise<{ files: number; bytes: number }> {
  const zip = new yazl.ZipFile();
  let files = 0;
  for await (const full of walk(dataDir)) {
    const rel = relative(dataDir, full).split(sep).join('/');
    // Already-compressed formats are stored as they are; JSON is deflated.
    const compress = !/\.(jpe?g|png|pdf|zip|xlsx)$/i.test(rel);
    zip.addFile(full, rel, { compress });
    files++;
  }
  const manifest = { app: APP_NAME, appVersion, createdAt: new Date().toISOString(), files };
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), MANIFEST_NAME);
  zip.end();
  const tmp = `${outFile}.partial`;
  await fs.mkdir(dirname(outFile), { recursive: true });
  await pipeline(zip.outputStream, createWriteStream(tmp));
  await fs.rename(tmp, outFile);
  const { size } = await fs.stat(outFile);
  return { files, bytes: size };
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zf) => (err || !zf ? rej(err) : res(zf))),
  );
}

/** Extracts the zip into `dest`. Every entry path is checked to stay inside dest. */
export async function extractZip(file: string, dest: string): Promise<number> {
  const zf = await openZip(file);
  const root = resolve(dest);
  let count = 0;
  await new Promise<void>((res, rej) => {
    zf.on('error', rej);
    zf.on('end', res);
    zf.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const target = resolve(root, name);
      if (name.includes('\\') || (target !== root && !target.startsWith(root + sep))) {
        zf.close();
        rej(new AppError('VALIDATION', `Unsafe path in backup: ${name}`));
        return;
      }
      if (name.endsWith('/')) {
        fs.mkdir(target, { recursive: true }).then(() => zf.readEntry(), rej);
        return;
      }
      zf.openReadStream(entry, (err, rs) => {
        if (err || !rs) return rej(err);
        fs.mkdir(dirname(target), { recursive: true })
          .then(() => pipeline(rs, createWriteStream(target)))
          .then(() => {
            count++;
            zf.readEntry();
          }, rej);
      });
    });
    zf.readEntry();
  });
  return count;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function renameDirWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 8 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        throw new AppError('DATA_DIR_UNWRITABLE', `Could not rename ${basename(from)} (${code}). Close any Explorer window showing the data folder and try again.`);
      }
      await sleep(250 * (i + 1));
    }
  }
}

export async function restoreBackup(zipFile: string, dataDir: string): Promise<{ previousCopy: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parent = dirname(resolve(dataDir));
  const name = basename(resolve(dataDir));
  const staging = join(parent, `${name}.restore-${stamp}`);
  const previous = join(parent, `${name}.before-restore-${stamp}`);
  try {
    await extractZip(zipFile, staging);
    const manifestText = await fs.readFile(join(staging, MANIFEST_NAME), 'utf8').catch(() => null);
    if (!manifestText || JSON.parse(manifestText).app !== APP_NAME) {
      throw new AppError('VALIDATION', 'This ZIP is not an AnswerEval AI backup.');
    }
    const cfgText = await fs.readFile(join(staging, 'config.json'), 'utf8').catch(() => null);
    if (cfgText && !ConfigFile.safeParse(JSON.parse(cfgText)).success) {
      throw new AppError('FILE_CORRUPT', 'config.json in the backup is invalid.');
    }
    await fs.rm(join(staging, MANIFEST_NAME), { force: true });
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  // Keep this machine's keys.
  await fs.copyFile(join(dataDir, 'secrets.bin'), join(staging, 'secrets.bin')).catch(() => undefined);
  await renameDirWithRetry(dataDir, previous);
  try {
    await renameDirWithRetry(staging, dataDir);
  } catch (err) {
    await renameDirWithRetry(previous, dataDir).catch(() => undefined); // roll back
    throw err;
  }
  return { previousCopy: previous };
}
