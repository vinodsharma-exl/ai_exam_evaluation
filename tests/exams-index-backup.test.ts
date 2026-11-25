import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '../src/main/store/file-store';
import { ExamRepo } from '../src/main/store/exam-repo';
import { StudentIndex } from '../src/main/store/student-index';
import { createBackup, restoreBackup, extractZip } from '../src/main/store/backup';
import { ensureLayout, switchDataDir } from '../src/main/store/data-dir';
import { ROOT_FILES } from '../src/shared/paths';
import { tempDir } from './helpers';
import yazl from 'yazl';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

let t: ReturnType<typeof tempDir>;
let dataDir: string;
let store: FileStore;
let repo: ExamRepo;
let index: StudentIndex;

beforeEach(async () => {
  t = tempDir();
  dataDir = join(t.dir, 'AnswerEvalAI');
  await ensureLayout(dataDir);
  store = new FileStore(dataDir);
  repo = new ExamRepo(store);
  index = new StudentIndex(store);
});
afterEach(() => t.cleanup());

async function readyExam() {
  const exam = await repo.createExam({ title: 'Physics Midterm', courseCode: 'PHY101', examDate: '2026-11-20' });
  const { exam: saved, problems } = await repo.saveExam({
    ...exam,
    questions: [
      { label: 'Q1 (a)', number: 'x', order: 9, text: 'Define force', maxMarks: 2, type: 'theory', modelAnswer: 'F = ma', markingPoints: [], finalAnswer: '', expectsDiagram: false, origin: 'manual' },
      { label: '2', number: 'x', order: 9, text: 'Compute', maxMarks: 3, type: 'numerical', modelAnswer: '', markingPoints: [{ id: 'p9', description: 'method', marks: 2 }, { id: 'p9', description: 'answer', marks: 1 }], finalAnswer: '6 N', expectsDiagram: false, origin: 'manual' },
    ],
  });
  return { saved, problems };
}

describe('ExamRepo', () => {
  it('creates an exam with a safe id and recomputes numbers, ids, total and status on save', async () => {
    const { saved, problems } = await readyExam();
    expect(saved.id).toBe('PHY101-Physics-Midterm-2026-11-20');
    expect(problems).toEqual([]);
    expect(saved.status).toBe('ready');
    expect(saved.totalMarks).toBe(5);
    expect(saved.questions.map((q) => q.number)).toEqual(['1a', '2']);
    expect(saved.questions[1]!.markingPoints.map((p) => p.id)).toEqual(['p1', 'p2']);
    const dup = await repo.createExam({ title: 'Physics Midterm', courseCode: 'PHY101', examDate: '2026-11-20' });
    expect(dup.id).toBe('PHY101-Physics-Midterm-2026-11-20-2');
  });

  it('creates students with folder-safe ids and blocks duplicates', async () => {
    const { saved } = await readyExam();
    const s = await repo.createStudent(saved.id, { displayId: '21/CS/045', name: 'Asha Kumar' });
    expect(s.id).toBe('21-CS-045');
    await expect(repo.createStudent(saved.id, { displayId: '21/cs/045' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    const s2 = await repo.createStudent(saved.id, { displayId: '21-CS-045' }); // different text, same folder name
    expect(s2.id).toBe('21-CS-045-2');
  });

  it('duplicates an exam without students', async () => {
    const { saved } = await readyExam();
    await repo.createStudent(saved.id, { displayId: 'S1' });
    const copy = await repo.duplicateExam(saved.id, 'Physics Midterm Sec B');
    expect(copy.questions).toHaveLength(2);
    expect(await repo.listStudents(copy.id)).toHaveLength(0);
  });
});

describe('StudentIndex', () => {
  it('finds students by id ignoring separators, by roll no and by name; rebuilds when deleted', async () => {
    const { saved } = await readyExam();
    await repo.createStudent(saved.id, { displayId: '21/CS/045', name: 'Asha Kumar', rollNo: '45' });
    await repo.createStudent(saved.id, { displayId: '21/CS/046', name: 'Ravi Shah' });
    await index.upsert(saved.id, '21-CS-045');
    await index.upsert(saved.id, '21-CS-046');

    expect((await index.search('21cs045'))[0]?.name).toBe('Asha Kumar');
    expect((await index.search('21-cs'))).toHaveLength(2);
    expect((await index.search('ravi'))[0]?.displayId).toBe('21/CS/046');

    await fs.rm(store.abs(ROOT_FILES.studentIndex));
    expect((await index.search('asha'))).toHaveLength(1); // rebuilt by scanning
  });

  it('groups the same student across exams', async () => {
    const { saved } = await readyExam();
    const other = await repo.createExam({ title: 'Physics Final' });
    await repo.createStudent(saved.id, { displayId: 'S-7', name: 'Mina' });
    await repo.createStudent(other.id, { displayId: 'S7', name: 'Mina' });
    const idx = await index.rebuild();
    expect(idx.students).toHaveLength(1);
    expect(idx.students[0]!.exams).toHaveLength(2);
  });
});

describe('backup and restore', () => {
  it('round-trips data, excludes keys and keeps the previous folder', async () => {
    const { saved } = await readyExam();
    await fs.writeFile(join(dataDir, 'secrets.bin'), 'ENCRYPTED-KEYS');
    const zip = join(t.dir, 'backup.zip');
    const { files } = await createBackup(dataDir, zip, '0.1.0');
    expect(files).toBeGreaterThan(0);

    // Change data after the backup, then restore.
    await repo.createExam({ title: 'Made after backup' });
    const { previousCopy } = await restoreBackup(zip, dataDir);
    const exams = await new ExamRepo(new FileStore(dataDir)).listExams();
    expect(exams.map((e) => e.id)).toEqual([saved.id]);
    expect(await fs.readFile(join(dataDir, 'secrets.bin'), 'utf8')).toBe('ENCRYPTED-KEYS'); // this PC's keys kept
    expect(existsSync(previousCopy)).toBe(true);
  });

  it('rejects zips that are not our backups', async () => {
    const zip = join(t.dir, 'other.zip');
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('hi'), 'readme.txt');
    z.end();
    await pipeline(z.outputStream, createWriteStream(zip));
    await expect(restoreBackup(zip, dataDir)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(readdirSync(t.dir).some((f) => f.includes('.restore-'))).toBe(false); // staging removed
  });

  it('blocks zip-slip paths', async () => {
    // yazl refuses to write "..", so write a same-length safe name and patch the bytes afterwards.
    const zip = join(t.dir, 'evil.zip');
    const safeName = 'ok/aa/aa/escape.txt';
    const evilName = 'ok/../../escape.txt';
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from('x'), safeName, { compress: false });
    z.end();
    await pipeline(z.outputStream, createWriteStream(zip));
    const bytes = await fs.readFile(zip);
    await fs.writeFile(zip, Buffer.from(bytes.toString('latin1').split(safeName).join(evilName), 'latin1'));
    await expect(extractZip(zip, join(t.dir, 'dest'))).rejects.toBeTruthy();
    expect(existsSync(join(t.dir, 'escape.txt'))).toBe(false);
  });
});

describe('data dir switching', () => {
  it('copies data to an empty folder and never deletes the old one', async () => {
    await readyExam();
    const userData = join(t.dir, 'userData');
    const target = join(t.dir, 'NewPlace');
    const out = await switchDataDir({ userData, documents: t.dir }, dataDir, target, true);
    expect(out).toBe(target);
    expect(readdirSync(join(target, 'exams'))).toHaveLength(1);
    expect(readdirSync(join(dataDir, 'exams'))).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(join(userData, 'bootstrap.json'), 'utf8')).dataDir).toBe(target);
  });
});
