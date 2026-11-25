/**
 * Finds the data folder. Its location is kept in <userData>/bootstrap.json, OUTSIDE the data folder,
 * so the app can find it after the professor moves it.
 * Default: Documents/AnswerEvalAI.
 */
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { BootstrapFile } from '../../shared/schemas/config';
import { DEFAULT_DATA_DIR_NAME } from '../../shared/constants';
import { DIRS } from '../../shared/paths';
import { AppError } from '../../shared/errors';
import { writeJsonAtomic } from './atomic-write';

export interface DataDirPaths {
  userData: string; // Electron app.getPath('userData')
  documents: string; // Electron app.getPath('documents')
}

const bootstrapPath = (p: DataDirPaths) => join(p.userData, 'bootstrap.json');

export async function resolveDataDir(p: DataDirPaths): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(bootstrapPath(p), 'utf8'));
    const parsed = BootstrapFile.safeParse(raw);
    if (parsed.success) return resolve(parsed.data.dataDir);
  } catch {
    /* first run or unreadable bootstrap: use the default */
  }
  return join(p.documents, DEFAULT_DATA_DIR_NAME);
}

export async function saveDataDir(p: DataDirPaths, dataDir: string): Promise<void> {
  await writeJsonAtomic(bootstrapPath(p), { dataDir: resolve(dataDir) });
}

/** Creates the standard top-level folders. Safe to call on every start. */
export async function ensureLayout(dataDir: string): Promise<void> {
  try {
    for (const d of Object.values(DIRS)) await fs.mkdir(join(dataDir, d), { recursive: true });
  } catch (err) {
    throw new AppError('DATA_DIR_UNWRITABLE', `${dataDir}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }
}

/**
 * Moves to a new data folder. With moveExisting, the old folder is COPIED (never deleted) and the
 * professor can remove it after checking. The target must be empty or an existing AnswerEvalAI folder.
 */
export async function switchDataDir(
  p: DataDirPaths,
  from: string,
  to: string,
  moveExisting: boolean,
): Promise<string> {
  const target = resolve(to);
  if (resolve(from) === target) return target;
  if (target.startsWith(resolve(from) + '\\') || target.startsWith(resolve(from) + '/')) {
    throw new AppError('VALIDATION', 'The new folder cannot be inside the current data folder.');
  }
  await fs.mkdir(target, { recursive: true });
  const existing = await fs.readdir(target);
  const looksLikeOurs = existing.includes('config.json') || existing.includes('exams');
  if (moveExisting) {
    if (existing.length > 0 && !looksLikeOurs) {
      throw new AppError('VALIDATION', 'Choose an empty folder to copy your data into.');
    }
    if (looksLikeOurs) throw new AppError('ALREADY_EXISTS', 'That folder already contains AnswerEval AI data. Switch without copying to use it.');
    // Copy item by item: fs.cp refuses an existing (even empty) target folder when errorOnExist is set.
    for (const entry of await fs.readdir(from)) {
      await fs.cp(join(from, entry), join(target, entry), { recursive: true, errorOnExist: true, force: false });
    }
  }
  await ensureLayout(target);
  await saveDataDir(p, target);
  return target;
}
