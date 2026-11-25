/**
 * Exams (templates) and students. Pure file operations; no AI here.
 */
import { promises as fs } from 'node:fs';
import { ExamFile, type Question } from '../../shared/schemas/exam';
import type { StudentFile, StudentStatus } from '../../shared/schemas/student';
import type { ExtractionFile } from '../../shared/schemas/extraction';
import type { EvaluationFile } from '../../shared/schemas/evaluation';
import type { FinalFile } from '../../shared/schemas/final';
import type { JobsFile } from '../../shared/schemas/jobs';
import { normalizeQuestionNumber } from '../../shared/schemas/common';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import * as P from '../../shared/paths';
import { computeExamTotal, examReadiness } from '../../shared/grading-math';
import { AppError } from '../../shared/errors';
import type { FileStore } from './file-store';

export interface ExamMeta {
  title: string;
  courseCode?: string;
  subject?: string;
  className?: string;
  examDate?: string | null;
}

export interface StudentInput {
  displayId: string;
  name?: string;
  rollNo?: string;
  section?: string;
}

export interface StudentBundle {
  student: StudentFile;
  extraction: ExtractionFile | null;
  evaluation: EvaluationFile | null;
  final: FinalFile | null;
  jobs: JobsFile | null;
}

export class ExamRepo {
  constructor(
    private readonly store: FileStore,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  private iso(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- exams

  async listExams(): Promise<ExamFile[]> {
    const ids = await this.store.listDirs(P.DIRS.exams);
    const out: ExamFile[] = [];
    for (const id of ids) {
      if (!P.isSafeId(id)) continue;
      try {
        const e = await this.store.read('exam', P.examFile(id));
        if (e) out.push(e);
      } catch (err) {
        this.log(`listExams: skipping ${id}: ${(err as Error).message}`);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getExam(examId: string): Promise<ExamFile> {
    return this.store.readRequired('exam', P.examFile(examId));
  }

  private async uniqueId(base: string, exists: (id: string) => Promise<boolean>): Promise<string> {
    const safe = P.toSafeId(base);
    if (!(await exists(safe))) return safe;
    for (let i = 2; i < 1000; i++) {
      const candidate = P.toSafeId(`${safe.slice(0, 58)}-${i}`);
      if (!(await exists(candidate))) return candidate;
    }
    throw new AppError('ALREADY_EXISTS', base);
  }

  async createExam(meta: ExamMeta): Promise<ExamFile> {
    const title = meta.title.trim();
    if (!title) throw new AppError('VALIDATION', 'Enter an exam title.');
    const base = [meta.courseCode?.trim(), title, meta.examDate ?? ''].filter(Boolean).join('-');
    const id = await this.uniqueId(base, (c) => this.store.exists(P.examFile(c)));
    const now = this.iso();
    const exam: ExamFile = {
      schemaVersion: SCHEMA_VERSIONS.exam,
      id,
      title,
      courseCode: meta.courseCode?.trim() ?? '',
      subject: meta.subject?.trim() ?? '',
      className: meta.className?.trim() ?? '',
      examDate: meta.examDate ?? null,
      evaluatorNotes: '',
      sources: { questionPaper: null, modelAnswer: null },
      questions: [],
      choiceRules: [],
      totalMarks: 0,
      status: 'draft',
      gradingOverrides: {},
      createdAt: now,
      updatedAt: now,
    };
    await this.store.mkdir(P.studentsDir(id));
    return this.store.write('exam', P.examFile(id), exam);
  }

  /**
   * Saves an edited exam template. Question numbers and order are derived from labels and position.
   * Total and status are recomputed. Returns readiness problems and warnings for the UI.
   */
  async saveExam(input: ExamFile): Promise<{ exam: ExamFile; problems: string[]; warnings: string[] }> {
    const questions: Question[] = input.questions.map((q, i) => ({
      ...q,
      number: normalizeQuestionNumber(q.label),
      order: i,
      markingPoints: q.markingPoints.map((p, j) => ({ ...p, id: `p${j + 1}` })),
    }));
    const choiceRules = input.choiceRules.map((r) => ({
      ...r,
      questionNumbers: r.questionNumbers.map(normalizeQuestionNumber),
    }));
    const { problems, warnings } = examReadiness(questions, choiceRules);
    const exam = await this.store.update('exam', P.examFile(input.id), (cur) => {
      if (!cur) throw new AppError('NOT_FOUND', `Exam ${input.id}`);
      const next: ExamFile = {
        ...input,
        schemaVersion: SCHEMA_VERSIONS.exam,
        createdAt: cur.createdAt,
        questions,
        choiceRules,
        totalMarks: computeExamTotal(questions, choiceRules),
        status: input.status === 'archived' ? 'archived' : problems.length === 0 ? 'ready' : 'draft',
        updatedAt: this.iso(),
      };
      return ExamFile.parse(next);
    });
    return { exam: exam!, problems, warnings };
  }

  /** New exam with the same questions and sources (e.g. the same paper for another section). No students are copied. */
  async duplicateExam(examId: string, newTitle: string): Promise<ExamFile> {
    const src = await this.getExam(examId);
    const created = await this.createExam({ ...src, title: newTitle });
    if (await this.store.exists(P.examSourceDir(examId))) {
      await fs.cp(this.store.abs(P.examSourceDir(examId)), this.store.abs(P.examSourceDir(created.id)), { recursive: true });
    }
    const copy: ExamFile = {
      ...src,
      id: created.id,
      title: created.title,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
    return (await this.saveExam(copy)).exam;
  }

  // ---------------------------------------------------------------- students

  async createStudent(examId: string, input: StudentInput): Promise<StudentFile> {
    await this.getExam(examId); // must exist
    const displayId = input.displayId.trim();
    if (!displayId) throw new AppError('VALIDATION', 'Enter the student ID.');
    if (displayId.length > 64) throw new AppError('VALIDATION', 'Student ID is too long (64 characters max).');
    const existing = await this.listStudents(examId);
    if (existing.some((s) => s.displayId.toLowerCase() === displayId.toLowerCase())) {
      throw new AppError('ALREADY_EXISTS', `Student ${displayId} is already in this exam.`);
    }
    const id = await this.uniqueId(displayId, (c) => this.store.exists(P.studentFile(examId, c)));
    const now = this.iso();
    const student: StudentFile = {
      schemaVersion: SCHEMA_VERSIONS.student,
      id,
      displayId,
      name: input.name?.trim() ?? '',
      rollNo: input.rollNo?.trim() ?? '',
      section: input.section?.trim() ?? '',
      uploads: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.mkdir(P.pagesDir(examId, id));
    return this.store.write('student', P.studentFile(examId, id), student);
  }

  async getStudent(examId: string, studentId: string): Promise<StudentFile> {
    return this.store.readRequired('student', P.studentFile(examId, studentId));
  }

  async listStudents(examId: string): Promise<StudentFile[]> {
    const ids = await this.store.listDirs(P.studentsDir(examId));
    const out: StudentFile[] = [];
    for (const id of ids) {
      if (!P.isSafeId(id)) continue;
      try {
        const s = await this.store.read('student', P.studentFile(examId, id));
        if (s) out.push(s);
      } catch (err) {
        this.log(`listStudents ${examId}: skipping ${id}: ${(err as Error).message}`);
      }
    }
    return out.sort((a, b) => a.displayId.localeCompare(b.displayId, undefined, { numeric: true }));
  }

  async updateStudent(
    examId: string,
    studentId: string,
    patch: Partial<Pick<StudentFile, 'name' | 'rollNo' | 'section' | 'uploads' | 'status'>>,
  ): Promise<StudentFile> {
    const s = await this.store.update('student', P.studentFile(examId, studentId), (cur) => {
      if (!cur) throw new AppError('NOT_FOUND', `Student ${studentId}`);
      return { ...cur, ...patch, updatedAt: this.iso() };
    });
    return s!;
  }

  async setStudentStatus(examId: string, studentId: string, status: StudentStatus): Promise<void> {
    await this.store.update('student', P.studentFile(examId, studentId), (cur) =>
      cur && cur.status !== status ? { ...cur, status, updatedAt: this.iso() } : undefined,
    );
  }

  async getStudentBundle(examId: string, studentId: string): Promise<StudentBundle> {
    const [student, extraction, evaluation, final, jobs] = await Promise.all([
      this.getStudent(examId, studentId),
      this.store.read('extraction', P.extractionFile(examId, studentId)),
      this.store.read('evaluation', P.evaluationFile(examId, studentId)),
      this.store.read('final', P.finalFile(examId, studentId)),
      this.store.read('jobs', P.jobsFile(examId, studentId)),
    ]);
    return { student, extraction, evaluation, final, jobs };
  }
}
