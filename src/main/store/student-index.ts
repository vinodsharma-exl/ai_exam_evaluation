/**
 * index/students.json: a derived cache for fast search by student ID or name across all exams.
 * It is safe to delete. It is rebuilt from the exam folders when missing or corrupt.
 */
import {
  type StudentIndexEntry,
  type StudentIndexFile,
  toSearchKey,
} from '../../shared/schemas/index-file';
import type { ExamFile } from '../../shared/schemas/exam';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from './file-store';

type ExamRef = StudentIndexEntry['exams'][number];

export class StudentIndex {
  constructor(
    private readonly store: FileStore,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  private async buildRef(exam: ExamFile, studentId: string): Promise<{ ref: ExamRef; displayId: string; name: string; rollNo: string } | null> {
    const student = await this.store.read('student', P.studentFile(exam.id, studentId));
    if (!student) return null;
    const [final, evaluation] = await Promise.all([
      this.store.read('final', P.finalFile(exam.id, studentId)).catch(() => null),
      this.store.read('evaluation', P.evaluationFile(exam.id, studentId)).catch(() => null),
    ]);
    const total = final ? final.total : evaluation ? evaluation.totals.recommended : null;
    return {
      displayId: student.displayId,
      name: student.name,
      rollNo: student.rollNo,
      ref: {
        examId: exam.id,
        studentId,
        examTitle: exam.title,
        examDate: exam.examDate,
        status: student.status,
        total,
        maxTotal: exam.totalMarks,
        isFinal: final?.status === 'finalized',
        needsReviewCount: evaluation?.questions.filter((q) => q.status === 'needs_review').length ?? 0,
        updatedAt: student.updatedAt,
      },
    };
  }

  /** Full scan of every exam folder. Runs on first start, when the index is missing or corrupt, or on request. */
  async rebuild(): Promise<StudentIndexFile> {
    const byKey = new Map<string, StudentIndexEntry>();
    for (const examId of await this.store.listDirs(P.DIRS.exams)) {
      if (!P.isSafeId(examId)) continue;
      let exam: ExamFile | null = null;
      try {
        exam = await this.store.read('exam', P.examFile(examId));
      } catch (err) {
        this.log(`index: skip exam ${examId}: ${(err as Error).message}`);
      }
      if (!exam) continue;
      for (const studentId of await this.store.listDirs(P.studentsDir(examId))) {
        if (!P.isSafeId(studentId)) continue;
        try {
          const built = await this.buildRef(exam, studentId);
          if (built) addRef(byKey, built);
        } catch (err) {
          this.log(`index: skip ${examId}/${studentId}: ${(err as Error).message}`);
        }
      }
    }
    const file: StudentIndexFile = {
      schemaVersion: SCHEMA_VERSIONS.studentIndex,
      builtAt: new Date().toISOString(),
      students: sortEntries([...byKey.values()]),
    };
    return this.store.write('studentIndex', P.ROOT_FILES.studentIndex, file);
  }

  async load(): Promise<StudentIndexFile> {
    try {
      const f = await this.store.read('studentIndex', P.ROOT_FILES.studentIndex);
      if (f) return f;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'FILE_CORRUPT')) throw err;
    }
    return this.rebuild();
  }

  /** Refreshes one student's entry after any change (upload, evaluation, finalize, rename). */
  async upsert(examId: string, studentId: string): Promise<void> {
    const exam = await this.store.read('exam', P.examFile(examId));
    const built = exam ? await this.buildRef(exam, studentId) : null;
    await this.load(); // make sure an index exists before updating it
    await this.store.update('studentIndex', P.ROOT_FILES.studentIndex, (cur) => {
      if (!cur) return undefined;
      const byKey = new Map<string, StudentIndexEntry>();
      for (const e of cur.students) {
        const exams = e.exams.filter((x) => !(x.examId === examId && x.studentId === studentId));
        if (exams.length) byKey.set(e.searchKey, { ...e, exams });
      }
      if (built) addRef(byKey, built);
      return { ...cur, students: sortEntries([...byKey.values()]) };
    });
  }

  /** Removes all entries for an exam (e.g. after the exam is deleted). */
  async removeExam(examId: string): Promise<void> {
    await this.store.update('studentIndex', P.ROOT_FILES.studentIndex, (cur) => {
      if (!cur) return undefined;
      const students = cur.students
        .map((e) => ({ ...e, exams: e.exams.filter((x) => x.examId !== examId) }))
        .filter((e) => e.exams.length > 0);
      return { ...cur, students };
    });
  }

  /**
   * Matching: an exact ID match ranks first, then ID prefix, then ID contains, then name contains.
   * Separators are ignored ("21/cs/045" finds "21-CS-045").
   */
  async search(query: string, limit = 50): Promise<StudentIndexEntry[]> {
    const idx = await this.load();
    const q = query.trim().toLowerCase();
    if (!q) return idx.students.slice(0, limit);
    const key = toSearchKey(q);
    const scored: Array<{ e: StudentIndexEntry; score: number }> = [];
    for (const e of idx.students) {
      let score = 0;
      if (key && e.searchKey === key) score = 100;
      else if (key && e.searchKey.startsWith(key)) score = 80;
      else if (key && e.searchKey.includes(key)) score = 60;
      else if (e.rollNo && toSearchKey(e.rollNo) === key) score = 70;
      else if (e.name.toLowerCase().includes(q)) score = 40;
      if (score > 0) scored.push({ e, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.e.displayId.localeCompare(b.e.displayId, undefined, { numeric: true }))
      .slice(0, limit)
      .map((s) => s.e);
  }
}

function addRef(
  byKey: Map<string, StudentIndexEntry>,
  b: { ref: ExamRef; displayId: string; name: string; rollNo: string },
): void {
  const searchKey = toSearchKey(b.displayId) || b.displayId.toLowerCase();
  const existing = byKey.get(searchKey);
  if (existing) {
    existing.exams.push(b.ref);
    // Prefer the most recently updated name.
    if (b.name && b.ref.updatedAt >= latest(existing)) existing.name = b.name;
    if (b.rollNo && !existing.rollNo) existing.rollNo = b.rollNo;
  } else {
    byKey.set(searchKey, { searchKey, displayId: b.displayId, name: b.name, rollNo: b.rollNo, exams: [b.ref] });
  }
}

function latest(e: StudentIndexEntry): string {
  return e.exams.reduce((m, x) => (x.updatedAt > m ? x.updatedAt : m), '');
}

function sortEntries(entries: StudentIndexEntry[]): StudentIndexEntry[] {
  for (const e of entries) e.exams.sort((a, b) => (b.examDate ?? b.updatedAt).localeCompare(a.examDate ?? a.updatedAt));
  return entries.sort((a, b) => a.displayId.localeCompare(b.displayId, undefined, { numeric: true }));
}
