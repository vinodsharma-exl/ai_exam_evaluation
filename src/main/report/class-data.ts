/**
 * One place that decides which marks count for a student, used by the class table, the charts and the
 * Excel sheet: the professor's marks if a final.json exists (draft or finalized), otherwise the AI
 * recommendation.
 */
import type { ExamFile } from '../../shared/schemas/exam';
import type { StudentFile } from '../../shared/schemas/student';
import type { EvaluationFile } from '../../shared/schemas/evaluation';
import type { FinalFile } from '../../shared/schemas/final';
import type { ClassSummary } from '../../shared/ipc';
import { percentage, round2 } from '../../shared/grading-math';

export interface StudentMarks {
  student: StudentFile;
  source: 'final' | 'final_draft' | 'ai' | 'none';
  perQuestion: Map<string, number | null>;
  total: number | null;
  needsReview: number;
  grade: string;
}

export function marksFor(student: StudentFile, ev: EvaluationFile | null, final: FinalFile | null): StudentMarks {
  const perQuestion = new Map<string, number | null>();
  if (final) {
    for (const q of final.questions) perQuestion.set(q.questionNumber, q.dropped ? null : q.finalMarks);
    return { student, source: final.status === 'finalized' ? 'final' : 'final_draft', perQuestion, total: final.total, needsReview: 0, grade: final.grade };
  }
  if (ev) {
    for (const q of ev.questions) perQuestion.set(q.questionNumber, ev.totals.droppedByChoiceRules.includes(q.questionNumber) ? null : q.recommendedMarks);
    const graded = ev.questions.some((q) => q.recommendedMarks !== null);
    return {
      student,
      source: graded ? 'ai' : 'none',
      perQuestion,
      total: graded ? ev.totals.recommended : null,
      needsReview: ev.questions.filter((q) => q.status === 'needs_review').length,
      grade: '',
    };
  }
  return { student, source: 'none', perQuestion, total: null, needsReview: 0, grade: '' };
}

export function summarize(exam: ExamFile, rows: StudentMarks[]): ClassSummary {
  const totals = rows.map((r) => r.total).filter((t): t is number => t !== null);
  const distribution = Array.from({ length: 10 }, (_, i) => ({ bucket: `${i * 10}–${i === 9 ? 100 : i * 10 + 9}%`, count: 0 }));
  for (const t of totals) distribution[Math.min(9, Math.floor(percentage(t, exam.totalMarks) / 10))]!.count++;
  const questionStats = exam.questions.map((q) => {
    const vals = rows.map((r) => r.perQuestion.get(q.number)).filter((v): v is number => typeof v === 'number');
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    return {
      number: q.number,
      label: q.label,
      maxMarks: q.maxMarks,
      average: avg === null ? null : round2(avg),
      averagePercent: avg === null ? null : round2((avg / q.maxMarks) * 100),
      graded: vals.length,
    };
  });
  return {
    examId: exam.id,
    rows: rows.map((r) => ({
      studentId: r.student.id,
      displayId: r.student.displayId,
      name: r.student.name,
      status: r.student.status,
      total: r.total,
      maxTotal: exam.totalMarks,
      needsReview: r.needsReview,
      source: r.source,
    })),
    stats: {
      count: rows.length,
      average: totals.length ? round2(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
      highest: totals.length ? Math.max(...totals) : null,
      lowest: totals.length ? Math.min(...totals) : null,
      distribution,
    },
    questionStats,
  };
}
