import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '../src/main/store/file-store';
import { writeFileAtomic, cleanupTempFiles } from '../src/main/store/atomic-write';
import { ConfigService, deepMerge } from '../src/main/store/config-service';
import { AppError } from '../src/shared/errors';
import { ROOT_FILES } from '../src/shared/paths';
import type { GlobalQueueFile } from '../src/shared/schemas/jobs';
import { tempDir, iso } from './helpers';

let t: ReturnType<typeof tempDir>;
let store: FileStore;
beforeEach(() => {
  t = tempDir();
  store = new FileStore(t.dir);
});
afterEach(() => t.cleanup());

const queue = (n: number): GlobalQueueFile => ({
  schemaVersion: 1,
  items: Array.from({ length: n }, (_, i) => ({ examId: 'E1', studentId: `S${i}`, addedAt: iso })),
  autoRun: false,
  updatedAt: iso,
});

describe('atomic write', () => {
  it('replaces the file and leaves no temp files', async () => {
    const f = join(t.dir, 'a', 'x.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(await fs.readFile(f, 'utf8')).toBe('two');
    expect(readdirSync(join(t.dir, 'a'))).toEqual(['x.json']);
  });

  it('cleans up stale temp files from a crash', async () => {
    await fs.mkdir(join(t.dir, 'exams', 'E1'), { recursive: true });
    await fs.writeFile(join(t.dir, 'exams', 'E1', '.exam.json.123.abcd.tmp'), 'partial');
    expect(await cleanupTempFiles(t.dir)).toBe(1);
  });
});

describe('FileStore', () => {
  it('round-trips a validated file and returns null when missing', async () => {
    expect(await store.read('globalQueue', ROOT_FILES.globalQueue)).toBeNull();
    await store.write('globalQueue', ROOT_FILES.globalQueue, queue(2));
    const back = await store.read('globalQueue', ROOT_FILES.globalQueue);
    expect(back?.items).toHaveLength(2);
  });

  it('refuses to write invalid data', async () => {
    const bad = { ...queue(1), items: [{ examId: '../evil', studentId: 'S', addedAt: iso }] };
    await expect(store.write('globalQueue', ROOT_FILES.globalQueue, bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await store.exists(ROOT_FILES.globalQueue)).toBe(false);
  });

  it('quarantines corrupt JSON instead of deleting it', async () => {
    await fs.writeFile(join(t.dir, 'queue.json'), '{ "schemaVersion": 1, "items": [');
    await expect(store.read('globalQueue', ROOT_FILES.globalQueue)).rejects.toMatchObject({ code: 'FILE_CORRUPT' });
    const files = readdirSync(t.dir);
    expect(files.some((f) => f.startsWith('queue.corrupt-'))).toBe(true);
    expect(files).not.toContain('queue.json');
  });

  it('quarantines schema-invalid files', async () => {
    await fs.writeFile(join(t.dir, 'queue.json'), JSON.stringify({ schemaVersion: 1, items: 'nope', updatedAt: iso }));
    await expect(store.read('globalQueue', ROOT_FILES.globalQueue)).rejects.toBeInstanceOf(AppError);
  });

  it('leaves files from a newer app version untouched', async () => {
    await fs.writeFile(join(t.dir, 'queue.json'), JSON.stringify({ ...queue(0), schemaVersion: 99 }));
    await expect(store.read('globalQueue', ROOT_FILES.globalQueue)).rejects.toMatchObject({ code: 'NEWER_FILE_VERSION' });
    expect(readdirSync(t.dir)).toContain('queue.json');
  });

  it('accepts a UTF-8 BOM (files edited in Notepad)', async () => {
    await fs.writeFile(join(t.dir, 'queue.json'), '\uFEFF' + JSON.stringify(queue(1)));
    expect((await store.read('globalQueue', ROOT_FILES.globalQueue))?.items).toHaveLength(1);
  });

  it('rejects paths that escape the data dir', () => {
    expect(() => store.abs('../outside.json')).toThrow();
    expect(() => store.abs('exams/../../x')).toThrow();
    expect(() => store.abs('C:\\Windows\\x')).toThrow();
  });

  it('serialises concurrent updates (no lost writes)', async () => {
    await store.write('globalQueue', ROOT_FILES.globalQueue, queue(0));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.update('globalQueue', ROOT_FILES.globalQueue, (cur) => ({
          ...cur!,
          items: [...cur!.items, { examId: 'E1', studentId: `S${i}`, addedAt: iso }],
        })),
      ),
    );
    expect((await store.read('globalQueue', ROOT_FILES.globalQueue))?.items).toHaveLength(40);
  });
});

describe('ConfigService', () => {
  it('creates defaults, deep-merges patches and rejects invalid values', async () => {
    const cfg = new ConfigService(store);
    const c = await cfg.get();
    expect(c.stages.ocr.providerId).toBe('gemini');
    const u = await cfg.update({ grading: { strictness: 'strict' } });
    expect(u.grading.strictness).toBe('strict');
    expect(u.grading.allowHalfMarks).toBe(true); // untouched sibling kept
    await expect(cfg.update({ grading: { strictness: 'harsh' } })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await cfg.get()).grading.strictness).toBe('strict');
  });

  it('never stores keys in config.json', async () => {
    const cfg = new ConfigService(store);
    await cfg.update({ providers: { groq: { apiKey: 'gsk_secret123456' } } });
    const raw = await fs.readFile(join(t.dir, 'config.json'), 'utf8');
    expect(raw).not.toContain('gsk_secret');
  });

  it('starts from defaults if config.json is corrupt', async () => {
    await fs.writeFile(join(t.dir, 'config.json'), 'garbage');
    const c = await new ConfigService(store).get();
    expect(c.schemaVersion).toBe(1);
  });

  it('records edited capabilities and connection tests', async () => {
    const cfg = new ConfigService(store);
    const ref = { providerId: 'groq' as const, model: 'llama-3.3-70b-versatile' };
    const caps = await cfg.updateModelCapabilities(ref, { requestsPerMinute: 5 });
    expect(caps.requestsPerMinute).toBe(5);
    await cfg.recordConnectionTest(ref, { at: iso, ok: true, vision: true }, true);
    const after = await cfg.capabilities(ref);
    expect(after.supportsVision).toBe(true);
    expect(after.requestsPerMinute).toBe(5);
  });

  it('deepMerge replaces arrays', () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 5 } })).toEqual({ a: [3], b: { c: 1, d: 5 } });
  });
});
