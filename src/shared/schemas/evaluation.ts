import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { AppErrorDataSchema, Confidence, IsoDateTime, Marks, ModelRef, QuestionNumber, SafeId, Sha256, Strictness } from './common';

export const CriterionResult = z.object({
  /** Marking point id ("p1"), or "overall" when the question has no marking points. */
  id: z.string(),
  description: z.string(),
  maxMarks: Marks,
  /** Already clamped to [0, maxMarks] and rounded to the allowed step. */
  awarded: Marks,
  comment: z.string().max(1000).default(''),
});
export type CriterionResult = z.infer<typeof CriterionResult>;

export const QuestionEvaluationStatus = z.enum([
  'pending',
  'recommended', // AI result, confidence OK
  'needs_review', // low confidence, illegible text, partial batch failure, clamped marks, etc.
  'not_attempted', // no answer found. 0 marks, no request spent.
  'failed',
]);

/** Why a question was flagged. Shown as chips in Results and AI Feedback. */
export const ReviewFlag = z.enum([
  'low_confidence',
  'illegible_text',
  'diagram_not_assessed',
  'marks_clamped', // the AI tried to award more than allowed
  'answer_changed_since_evaluation',
  'possible_wrong_question_number',
  'manual_text',
  'model_flagged', // the AI itself asked for human review
]);
export type ReviewFlag = z.infer<typeof ReviewFlag>;

export const QuestionEvaluation = z.object({
  questionNumber: QuestionNumber,
  maxMarks: Marks,
  status: QuestionEvaluationStatus,
  /** Sum of criteria, clamped to maxMarks and rounded. Always labelled "Recommended" in the UI. */
  recommendedMarks: Marks.nullable(),
  criteria: z.array(CriterionResult).default([]),
  correct: z.array(z.string().max(500)).default([]),
  missing: z.array(z.string().max(500)).default([]),
  /** Short feedback addressed to the student (shown on the report). */
  feedback: z.string().max(2000).default(''),
  /** Why the AI asked for human review. For the professor only, never printed on the report. */
  reviewNote: z.string().max(500).default(''),
  confidence: Confidence.nullable(),
  flags: z.array(ReviewFlag).default([]),
  by: ModelRef.nullable(),
  cacheKey: z.string().nullable().default(null),
  /** textHash of the MergedAnswer that was graded. */
  answerTextHash: Sha256.nullable().default(null),
  evaluatedAt: IsoDateTime.nullable(),
  error: AppErrorDataSchema.nullable().default(null),
  /** Earlier results this one replaced through "Re-evaluate". Newest first, at most 5. */
  history: z
    .array(
      z.object({
        recommendedMarks: Marks.nullable(),
        confidence: Confidence.nullable(),
        by: ModelRef.nullable(),
        evaluatedAt: IsoDateTime.nullable(),
        feedback: z.string().default(''),
      }),
    )
    .max(5)
    .default([]),
});
export type QuestionEvaluation = z.infer<typeof QuestionEvaluation>;

export const EvaluationFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.evaluation),
  examId: SafeId,
  studentId: SafeId,
  /** Settings at the time of grading, shown on the report and used to detect stale results. */
  settings: z.object({
    strictness: Strictness,
    allowHalfMarks: z.boolean(),
    promptVersion: z.string(),
  }),
  questions: z.array(QuestionEvaluation),
  totals: z.object({
    recommended: Marks,
    max: Marks,
    /** Questions excluded by "answer any N" rules (lowest scores dropped). */
    droppedByChoiceRules: z.array(QuestionNumber).default([]),
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EvaluationFile = z.infer<typeof EvaluationFile>;
