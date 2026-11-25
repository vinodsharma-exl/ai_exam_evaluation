/**
 * Turns the AI's per-criterion scores into a safe recommendation. Pure. The code, not the model, decides:
 *   - every criterion is clamped to [0, its marks] and rounded to the half or whole step
 *   - if the marking points don't add up to max marks, the sum is scaled to max marks
 *   - the question total is clamped and rounded again; it can never exceed max marks
 *   - flags decide 'needs_review' (low confidence, clamping, illegible text, the model's own doubt, ...)
 */
import type { ExamFile, Question } from '../../shared/schemas/exam';
import type { MergedAnswer } from '../../shared/schemas/extraction';
import type { CriterionResult, EvaluationFile, QuestionEvaluation, ReviewFlag } from '../../shared/schemas/evaluation';
import type { EvaluationOutput } from '../../shared/schemas/ai-output';
import type { ModelRef } from '../../shared/schemas/common';
import { normalizeQuestionNumber } from '../../shared/schemas/common';
import { normalizeMarks, round2, computeStudentTotal } from '../../shared/grading-math';
import { evaluationCriteria, type EvaluationItem } from '../../shared/prompts/templates';

export function toEvaluationItem(q: Question, a: MergedAnswer | undefined): EvaluationItem {
  const diagram = a?.diagramDescription?.trim() ? `\n[Diagram: ${a.diagramDescription.trim()}]` : '';
  return {
    label: q.number,
    maxMarks: q.maxMarks,
    type: q.type,
    questionText: q.text,
    modelAnswer: q.modelAnswer,
    finalAnswer: q.finalAnswer,
    markingPoints: q.markingPoints,
    studentAnswer: (a?.text ?? '') + diagram,
  };
}

type AiResult = EvaluationOutput['results'][number];

export function scoreQuestion(args: {
  question: Question;
  answer: MergedAnswer | undefined;
  result: AiResult;
  allowHalfMarks: boolean;
  lowConfidenceThreshold: number;
  by: ModelRef;
  cacheKey: string;
  nowIso: string;
  previous?: QuestionEvaluation;
}): QuestionEvaluation {
  const { question: q, result: r } = args;
  const criteriaDefs = evaluationCriteria({ ...toEvaluationItem(q, args.answer) });
  const flags = new Set<ReviewFlag>();
  const byId = new Map(r.criteria.map((c) => [c.id.trim().toLowerCase(), c]));

  const criteria: CriterionResult[] = criteriaDefs.map((def) => {
    const got = byId.get(def.id.toLowerCase());
    if (!got) flags.add('low_confidence'); // the model skipped a criterion
    const { value, clamped } = normalizeMarks(got?.awarded ?? 0, def.marks, args.allowHalfMarks);
    if (clamped && got) flags.add('marks_clamped');
    return { id: def.id, description: def.description, maxMarks: def.marks, awarded: value, comment: got?.comment ?? '' };
  });

  const pointsTotal = criteriaDefs.reduce((s, c) => s + c.marks, 0);
  let raw = criteria.reduce((s, c) => s + c.awarded, 0);
  if (pointsTotal > 0 && Math.abs(pointsTotal - q.maxMarks) > 1e-6) raw = (raw * q.maxMarks) / pointsTotal;
  const total = normalizeMarks(raw, q.maxMarks, args.allowHalfMarks);
  if (total.clamped) flags.add('marks_clamped');

  const confidence = Math.max(0, Math.min(1, r.confidence));
  if (confidence < args.lowConfidenceThreshold) flags.add('low_confidence');
  if (r.review) flags.add('model_flagged');
  if ((args.answer?.illegibleCount ?? 0) > 0) flags.add('illegible_text');
  if (q.expectsDiagram && !args.answer?.hasDiagram) flags.add('diagram_not_assessed');
  if (args.answer && args.answer.origin !== 'ai') flags.add('manual_text');
  if ((args.answer?.confidence ?? 1) < args.lowConfidenceThreshold) flags.add('low_confidence');

  const reviewFlags = [...flags].filter((f) => f !== 'manual_text');
  const history = args.previous && args.previous.evaluatedAt
    ? [
        {
          recommendedMarks: args.previous.recommendedMarks,
          confidence: args.previous.confidence,
          by: args.previous.by,
          evaluatedAt: args.previous.evaluatedAt,
          feedback: args.previous.feedback,
        },
        ...args.previous.history,
      ].slice(0, 5)
    : args.previous?.history ?? [];

  return {
    questionNumber: q.number,
    maxMarks: q.maxMarks,
    status: reviewFlags.length > 0 ? 'needs_review' : 'recommended',
    recommendedMarks: total.value,
    criteria,
    correct: r.correct.slice(0, 10),
    missing: r.missing.slice(0, 10),
    feedback: r.feedback.slice(0, 2000),
    reviewNote: r.review ? r.reviewReason.slice(0, 500) : '',
    confidence: round2(confidence),
    flags: [...flags],
    by: args.by,
    cacheKey: args.cacheKey,
    answerTextHash: args.answer?.textHash ?? null,
    evaluatedAt: args.nowIso,
    error: null,
    history,
  };
}

/**
 * Finds the AI result for a question even if the model echoed the label differently ("Q1 (a)" vs "1a").
 * Only for single-question calls is a lone result accepted whatever its label.
 */
export function findResult(results: AiResult[], questionNumber: string, singleQuestionCall: boolean): AiResult | undefined {
  return (
    results.find((r) => normalizeQuestionNumber(r.q) === questionNumber) ??
    (singleQuestionCall && results.length === 1 ? results[0] : undefined)
  );
}

export function notAttemptedEvaluation(q: Question, nowIso: string): QuestionEvaluation {
  return {
    questionNumber: q.number,
    maxMarks: q.maxMarks,
    status: 'not_attempted',
    recommendedMarks: 0,
    criteria: [],
    correct: [],
    missing: [],
    feedback: 'Not attempted.',
    reviewNote: '',
    confidence: 1,
    flags: [],
    by: null,
    cacheKey: null,
    answerTextHash: null,
    evaluatedAt: nowIso,
    error: null,
    history: [],
  };
}

export function pendingEvaluation(q: Question): QuestionEvaluation {
  return {
    questionNumber: q.number,
    maxMarks: q.maxMarks,
    status: 'pending',
    recommendedMarks: null,
    criteria: [],
    correct: [],
    missing: [],
    feedback: '',
    reviewNote: '',
    confidence: null,
    flags: [],
    by: null,
    cacheKey: null,
    answerTextHash: null,
    evaluatedAt: null,
    error: null,
    history: [],
  };
}

export function recomputeTotals(exam: ExamFile, ev: EvaluationFile): EvaluationFile['totals'] {
  const { total, dropped } = computeStudentTotal(
    ev.questions.map((q) => ({ number: q.questionNumber, marks: q.recommendedMarks })),
    exam.choiceRules,
  );
  return { recommended: total, max: exam.totalMarks, droppedByChoiceRules: dropped };
}
