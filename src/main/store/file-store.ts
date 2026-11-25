/**
 * Typed JSON file store over the data dir.
 *
 * - read(): parse → migrate → zod validate. Missing → null. Broken → quarantined as
 *   *.corrupt-<timestamp>.json (never deleted) and FILE_CORRUPT thrown.
 * - write(): validate → atomic write. Invalid data is never written.
 * - update(): read-modify-write under a per-file mutex.
 * All paths are RELATIVE to the data dir (see shared/paths.ts). Absolute or escaping paths are rejected.
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { z } from 'zod';
import { FILE_SCHEMAS, type FileKind } from '../../shared/schemas/index';
import { AppError } from '../../shared/errors';
import { writeJsonAtomic, writeFileAtomic, copyFileAtomic } from './atomic-write';
import { migrate } from './migrations';
import { KeyedMutex } from './mutex';

export type FileOf<K extends FileKind> = z.infer<(typeof FILE_SCHEMAS)[K]>;

export class FileStore {
  private readonly mutex = new KeyedMutex();

  constructor(private root: string) {}

  get dataDir(): string {
    return this.root;
  }

  /** Used when the professor changes the data folder. */
  setRoot(root: string): void {
    this.root = root;
  }

  /** Resolves a relative path inside the data dir. Throws on anything that escapes it. */
  abs(rel: string): string {
    if (isAbsolute(rel)) throw new Error(`Expected a relative path, got ${rel}`);
    const full = normalize(join(this.root, rel));
    const back = relative(this.root, full);
    if (back.startsWith('..') || isAbsolute(back) || back.split(sep).includes('..')) {
      throw new Error(`Path escapes data dir: ${rel}`);
    }
    return full;
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async read<K extends FileKind>(kind: K, rel: string): Promise<FileOf<K> | null> {
    let text: string;
    try {
      text = await fs.readFile(this.abs(rel), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err) {
      await this.quarantine(rel);
      throw new AppError('FILE_CORRUPT', `${rel}: invalid JSON (${(err as Error).message})`);
    }
    const { doc, migrated } = migrate(kind, raw); // NEWER_FILE_VERSION propagates; the file is left untouched
    const parsed = FILE_SCHEMAS[kind].safeParse(doc);
    if (!parsed.success) {
      await this.quarantine(rel);
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError('FILE_CORRUPT', `${rel}: ${issues}`);
    }
    if (migrated) await this.writeValidated(rel, parsed.data);
    return parsed.data as FileOf<K>;
  }

  /** Like read(), but throws NOT_FOUND instead of returning null. */
  async readRequired<K extends FileKind>(kind: K, rel: string): Promise<FileOf<K>> {
    const v = await this.read(kind, rel);
    if (v === null) throw new AppError('NOT_FOUND', rel);
    return v;
  }

  async write<K extends FileKind>(kind: K, rel: string, value: FileOf<K>): Promise<FileOf<K>> {
    return this.mutex.run(rel, () => this.writeUnlocked(kind, rel, value));
  }

  /**
   * Atomic read-modify-write. `fn` receives the current value (or null) and returns the new value.
   * Returning undefined means "no change" and nothing is written.
   */
  async update<K extends FileKind>(
    kind: K,
    rel: string,
    fn: (current: FileOf<K> | null) => FileOf<K> | undefined | Promise<FileOf<K> | undefined>,
  ): Promise<FileOf<K> | null> {
    return this.mutex.run(rel, async () => {
      const current = await this.read(kind, rel);
      const next = await fn(current);
      if (next === undefined) return current;
      return this.writeUnlocked(kind, rel, next);
    });
  }

  private async writeUnlocked<K extends FileKind>(kind: K, rel: string, value: FileOf<K>): Promise<FileOf<K>> {
    const parsed = FILE_SCHEMAS[kind].safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new AppError('VALIDATION', `${kind} → ${rel}: ${issues}`);
    }
    await this.writeValidated(rel, parsed.data);
    return parsed.data as FileOf<K>;
  }

  private async writeValidated(rel: string, data: unknown): Promise<void> {
    try {
      await writeJsonAtomic(this.abs(rel), data);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC') {
        throw new AppError('DATA_DIR_UNWRITABLE', `${rel}: ${code}`);
      }
      throw err;
    }
  }

  async writeBytes(rel: string, data: Uint8Array): Promise<void> {
    await this.mutex.run(rel, () => writeFileAtomic(this.abs(rel), data));
  }

  async readBytes(rel: string): Promise<Buffer> {
    return fs.readFile(this.abs(rel));
  }

  async importFile(srcAbsolute: string, rel: string): Promise<void> {
    await this.mutex.run(rel, () => copyFileAtomic(srcAbsolute, this.abs(rel)));
  }

  async listDirs(rel: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async listFiles(rel: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async mkdir(rel: string): Promise<void> {
    await fs.mkdir(this.abs(rel), { recursive: true });
  }

  async remove(rel: string): Promise<void> {
    await fs.rm(this.abs(rel), { recursive: true, force: true });
  }

  /** Renames a broken file aside. Never deletes. Returns the new relative path. */
  async quarantine(rel: string): Promise<string | null> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = rel.replace(/\.json$/, '') + `.corrupt-${stamp}.json`;
    try {
      await fs.rename(this.abs(rel), this.abs(target));
      return target;
    } catch {
      return null;
    }
  }

  /** Checks the data dir can be written to by writing and deleting a probe file. */
  async checkWritable(): Promise<boolean> {
    try {
      await fs.mkdir(this.root, { recursive: true });
      const probe = join(this.root, `.write-probe-${process.pid}`);
      await fs.writeFile(probe, 'ok');
      await fs.rm(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}
