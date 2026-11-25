/**
 * Screen 9 backend: the professor's final marks.
 *
 *   draft()  → the current final.json, or a draft built from the AI recommendations (not saved)
 *   save()   → validates every mark (0..max, half-mark rule), recomputes totals with "answer any N"
 *              rules, grade and percentage, and appends an audit entry for every change
 *
 * The AI marks are kept next to the final marks forever (aiMarks), so the report and the audit
 * show exactly where the professor overrode a recommendation.
 */
import type { ExamFile } from '../../shared/schemas/exam';
import type { EvaluationFile } from '../../shared/schemas/evaluation';
import type { AuditEntry, FinalFile, FinalQuestion } from '../../shared/schemas/final';
import type { ConfigFile } from '../../shared/schemas/config';
import type { FinalInput } from '../../shared/ipc';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { computeStudentTotal, gradeFor, percentage, validateManualMark } from '../../shared/grading-math';
import { AppError } from '../../shared/errors';

export function halfMarksAllowed(exam: ExamFile, cfg: ConfigFile): boolean {
  return exam.gradingOverrides.allowHalfMarks ?? cfg.grading.allowHalfMarks;
}

function totals(exam: ExamFile, cfg: ConfigFile, questions: FinalQuestion[]) {
  const { total, dropped } = computeStudentTotal(questions.map((q) => ({ number: q.questionNumber, marks: q.finalMarks })), exam.choiceRules);
  const pct = percentage(total, exam.totalMarks);
  return {
    questions: questions.map((q) => ({ ...q, dropped: dropped.includes(q.questionNumber) })),
    total,
    maxTotal: exam.totalMarks,
    percentage: pct,
    grade: gradeFor(pct, cfg.gradeBands),
  };
}

/** The saved final marks, refreshed with the latest AI recommendations, or a fresh draft from them. */
export function buildDraft(exam: ExamFile, cfg: ConfigFile, ev: EvaluationFile | null, existing: FinalFile | null, nowIso: string): FinalFile {
  const evByQ = new Map((ev?.questions ?? []).map((q) => [q.questionNumber, q]));
  const prevByQ = new Map((existing?.questions ?? []).map((q) => [q.questionNumber, q]));
  const questions: FinalQuestion[] = exam.questions.map((q) => {
    const e = evByQ.get(q.number);
    const p = prevByQ.get(q.number);
    const aiMarks = e?.recommendedMarks ?? null;
    if (p) {
      // Keep the professor's mark; just refresh what the AI currently recommends.
      return { ...p, maxMarks: q.maxMarks, aiMarks, overridden: aiMarks === null || p.finalMarks !== aiMarks };
    }
    return {
      questionNumber: q.number,
      maxMarks: q.maxMarks,
      aiMarks,
      finalMarks: aiMarks ?? 0,
      overridden: aiMarks === null,
      comment: e?.feedback ?? '',
      privateNote: '',
      dropped: false,
    };
  });
  return {
    schemaVersion: SCHEMA_VERSIONS.final,
    examId: exam.id,
    studentId: existing?.studentId ?? ev?.studentId ?? '',
    status: existing?.status ?? 'draft',
    ...totals(exam, cfg, questions),
    overallComment: existing?.overallComment ?? '',
    finalizedAt: existing?.finalizedAt ?? null,
    finalizedBy: existing?.finalizedBy ?? null,
    audit: existing?.audit ?? [],
    reportGeneratedAt: existing?.reportGeneratedAt ?? null,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: existing?.updatedAt ?? nowIso,
  };
}

/** Applies the professor's input to the draft: validation, totals, audit trail, finalize state. */
export function applyFinalInput(args: {
  exam: ExamFile;
  cfg: ConfigFile;
  draft: FinalFile;
  existing: FinalFile | null;
  input: FinalInput;
  finalize: boolean;
  by: string;
  nowIso: string;
  studentId: string;
}): FinalFile {
  const { exam, cfg, draft, existing, input, by, nowIso } = args;
  const half = halfMarksAllowed(exam, cfg);
  const inputByQ = new Map(input.questions.map((q) => [q.questionNumber, q]));
  const errors: string[] = [];
  const audit: AuditEntry[] = [...draft.audit];
  const entry = (e: Omit<AuditEntry, 'at' | 'by' | 'reason'> & { reason?: string }) => audit.push({ at: nowIso, by, reason: '', ...e });

  if (!existing) entry({ action: 'create', questionNumber: null, from: null, to: null });

  const questions = draft.questions.map((q) => {
    const inp = inputByQ.get(q.questionNumber);
    if (!inp) return q;
    const label = exam.questions.find((x) => x.number === q.questionNumber)?.label ?? q.questionNumber;
    const err = validateManualMark(inp.finalMarks, q.maxMarks, half);
    if (err) errors.push(`Q${label}: ${err}`);
    const before = existing?.questions.find((x) => x.questionNumber === q.questionNumber);
    const fromMarks = before ? before.finalMarks : q.aiMarks;
    if (fromMarks !== inp.finalMarks) {
      entry({
        action: inp.finalMarks === q.aiMarks ? 'accept_ai' : 'edit_marks',
        questionNumber: q.questionNumber,
        from: fromMarks,
        to: inp.finalMarks,
        reason: (inp.reason ?? '').slice(0, 500),
      });
    }
    const comment = (inp.comment ?? q.comment).slice(0, 2000);
    if ((before?.comment ?? q.comment) !== comment) {
      entry({ action: 'edit_comment', questionNumber: q.questionNumber, from: before?.comment ?? q.comment, to: comment });
    }
    return {
      ...q,
      finalMarks: inp.finalMarks,
      overridden: q.aiMarks === null || inp.finalMarks !== q.aiMarks,
      comment,
      privateNote: (inp.privateNote ?? q.privateNote).slice(0, 2000),
    };
  });
  if (errors.length) throw new AppError('VALIDATION', errors.join(' '));

  const wasFinal = existing?.status === 'finalized';
  if (args.finalize && !wasFinal) entry({ action: 'finalize', questionNumber: null, from: null, to: null });
  if (!args.finalize && wasFinal) entry({ action: 'unfinalize', questionNumber: null, from: null, to: null });

  return {
    ...draft,
    studentId: args.studentId,
    ...totals(exam, cfg, questions),
    status: args.finalize ? 'finalized' : 'draft',
    overallComment: (input.overallComment ?? draft.overallComment).slice(0, 4000),
    finalizedAt: args.finalize ? (wasFinal ? draft.finalizedAt : nowIso) : null,
    finalizedBy: args.finalize ? (wasFinal ? draft.finalizedBy : by) : null,
    audit,
    updatedAt: nowIso,
  };
}
