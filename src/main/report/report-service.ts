/**
 * Final marks (screen 9) and reports (screen 10): student PDF, class Excel sheet, all PDFs for an exam.
 * Files are written atomically into the data folder:
 *   exams/<exam>/students/<student>/report.pdf     exams/<exam>/class_sheet.xlsx
 */
import type { FinalFile } from '../../shared/schemas/final';
import type { FinalInput } from '../../shared/ipc';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from '../store/file-store';
import type { ExamRepo } from '../store/exam-repo';
import type { ConfigService } from '../store/config-service';
import type { ProfileService } from '../store/profile-service';
import type { StudentIndex } from '../store/student-index';
import { applyFinalInput, buildDraft } from './final-service';
import { buildStudentReport } from './student-report';
import { buildClassSheet } from './class-sheet';
import { marksFor, summarize, type StudentMarks } from './class-data';

export class ReportService {
  constructor(
    private readonly store: FileStore,
    private readonly exams: ExamRepo,
    private readonly config: ConfigService,
    private readonly profile: ProfileService,
    private readonly index: StudentIndex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async professorName(): Promise<string> {
    const p = await this.profile.get();
    return p ? [p.title, p.name].filter(Boolean).join(' ') : 'the examiner';
  }

  async getFinalDraft(examId: string, studentId: string): Promise<FinalFile> {
    const [exam, cfg, ev, existing] = await Promise.all([
      this.exams.getExam(examId),
      this.config.get(),
      this.store.read('evaluation', P.evaluationFile(examId, studentId)),
      this.store.read('final', P.finalFile(examId, studentId)),
    ]);
    const d = buildDraft(exam, cfg, ev, existing, this.now().toISOString());
    return { ...d, studentId };
  }

  async saveFinal(examId: string, studentId: string, input: FinalInput, finalize: boolean): Promise<FinalFile> {
    const [exam, cfg, by] = await Promise.all([this.exams.getExam(examId), this.config.get(), this.professorName()]);
    await this.exams.getStudent(examId, studentId); // must exist
    const saved = await this.store.update('final', P.finalFile(examId, studentId), async (existing) => {
      const ev = await this.store.read('evaluation', P.evaluationFile(examId, studentId));
      const draft = buildDraft(exam, cfg, ev, existing, this.now().toISOString());
      return applyFinalInput({ exam, cfg, draft, existing, input, finalize, by, nowIso: this.now().toISOString(), studentId });
    });
    const ev = await this.store.read('evaluation', P.evaluationFile(examId, studentId));
    const status = finalize
      ? 'finalized'
      : ev?.questions.some((q) => q.status === 'needs_review' || q.status === 'failed')
        ? 'needs_review'
        : ev
          ? 'evaluated'
          : 'draft';
    await this.exams.setStudentStatus(examId, studentId, status);
    await this.index.upsert(examId, studentId);
    return saved!;
  }

  private async logo(): Promise<{ bytes: Uint8Array; kind: 'png' | 'jpg' } | null> {
    const rel = (await this.config.get()).institution.logoFile;
    if (!rel) return null;
    try {
      const bytes = new Uint8Array(await this.store.readBytes(rel));
      return { bytes, kind: /\.png$/i.test(rel) ? 'png' : 'jpg' };
    } catch {
      return null;
    }
  }

  /** Writes report.pdf. Without saved final marks the AI recommendations are used, marked DRAFT. */
  async studentReport(examId: string, studentId: string): Promise<string> {
    const [exam, cfg, student, ev] = await Promise.all([
      this.exams.getExam(examId),
      this.config.get(),
      this.exams.getStudent(examId, studentId),
      this.store.read('evaluation', P.evaluationFile(examId, studentId)),
    ]);
    const final = await this.getFinalDraft(examId, studentId);
    if (!ev && !(await this.store.exists(P.finalFile(examId, studentId)))) {
      throw new AppError('VALIDATION', 'This student has no marks yet. Evaluate the answer sheet or enter marks first.');
    }
    const bytes = await buildStudentReport({
      exam,
      student,
      final,
      evaluation: ev,
      config: cfg,
      professor: await this.professorName(),
      generatedAt: this.now(),
      logo: await this.logo(),
    });
    const rel = P.reportPdf(examId, studentId);
    await this.store.writeBytes(rel, bytes);
    await this.store.update('final', P.finalFile(examId, studentId), (cur) => (cur ? { ...cur, reportGeneratedAt: this.now().toISOString() } : undefined));
    return rel;
  }

  async classData(examId: string) {
    const exam = await this.exams.getExam(examId);
    const rows: StudentMarks[] = [];
    for (const st of await this.exams.listStudents(examId)) {
      const [ev, final] = await Promise.all([
        this.store.read('evaluation', P.evaluationFile(examId, st.id)).catch(() => null),
        this.store.read('final', P.finalFile(examId, st.id)).catch(() => null),
      ]);
      rows.push(marksFor(st, ev, final));
    }
    return { exam, rows, summary: summarize(exam, rows) };
  }

  async classSheet(examId: string): Promise<string> {
    const { exam, rows, summary } = await this.classData(examId);
    const buf = await buildClassSheet({ exam, rows, summary, config: await this.config.get(), professor: await this.professorName(), generatedAt: this.now() });
    const rel = P.classSheetXlsx(examId);
    await this.store.writeBytes(rel, buf);
    return rel;
  }

  /** One PDF per student who has marks. Failures don't stop the batch. */
  async allStudentReports(examId: string): Promise<{ count: number; skipped: string[] }> {
    let count = 0;
    const skipped: string[] = [];
    for (const st of await this.exams.listStudents(examId)) {
      try {
        await this.studentReport(examId, st.id);
        count++;
      } catch {
        skipped.push(st.displayId);
      }
    }
    return { count, skipped };
  }
}
