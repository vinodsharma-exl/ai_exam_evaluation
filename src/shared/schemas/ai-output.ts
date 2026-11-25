/**
 * Shapes the AI must return for each prompt. These are validated with zod after JSON extraction.
 * They are lenient on purpose: optional fields have defaults, and numbers given as strings ("2.5")
 * are coerced. Hard rules (clamping, rounding, max marks) are enforced in code afterwards, never
 * trusted to the model.
 */
import { z } from 'zod';

const num = z.coerce.number();
const conf = z.coerce.number().min(0).max(1).catch(0.5);
const qType = z.enum(['theory', 'numerical', 'mixed']).catch('theory');

// (a) Question paper extraction
export const QuestionPaperOutput = z.object({
  questions: z
    .array(
      z.object({
        label: z.string().min(1),
        text: z.string().default(''),
        maxMarks: num.nonnegative().nullable().default(null),
        type: qType.default('theory'),
        confidence: conf.default(0.8),
      }),
    )
    .min(1),
  choiceRules: z
    .array(
      z.object({
        questions: z.array(z.string()).min(2),
        countBest: num.int().min(1),
        text: z.string().default(''),
      }),
    )
    .default([]),
  totalMarks: num.nullable().default(null),
  notes: z.string().default(''),
});
export type QuestionPaperOutput = z.infer<typeof QuestionPaperOutput>;

// (b) Model answer / marking scheme extraction
export const ModelAnswerOutput = z.object({
  answers: z
    .array(
      z.object({
        label: z.string().min(1),
        modelAnswer: z.string().default(''),
        finalAnswer: z.string().default(''),
        markingPoints: z
          .array(z.object({ description: z.string().min(1), marks: num.nonnegative() }))
          .default([]),
        expectsDiagram: z.boolean().catch(false).default(false),
        confidence: conf.default(0.8),
      }),
    )
    .min(1),
  notes: z.string().default(''),
});
export type ModelAnswerOutput = z.infer<typeof ModelAnswerOutput>;

// (c) Handwritten answer OCR, for one group of pages
export const AnswerOcrOutput = z.object({
  pages: z.array(
    z.object({
      /** 1-based page number as told in the prompt. */
      page: num.int().min(1),
      blank: z.boolean().catch(false).default(false),
      fragments: z
        .array(
          z.object({
            q: z.string().nullable().default(null),
            continued: z.boolean().catch(false).default(false),
            text: z.string().default(''),
            diagram: z.string().default(''),
            illegible: num.int().min(0).catch(0).default(0),
            confidence: conf.default(0.5),
          }),
        )
        .default([]),
      note: z.string().default(''),
    }),
  ),
});
export type AnswerOcrOutput = z.infer<typeof AnswerOcrOutput>;

// (d) Evaluation, for one batch of questions
export const EvaluationOutput = z.object({
  results: z
    .array(
      z.object({
        q: z.string().min(1),
        criteria: z
          .array(
            z.object({
              id: z.string().min(1),
              awarded: num.nonnegative().catch(0),
              comment: z.string().default(''),
            }),
          )
          .default([]),
        correct: z.array(z.string()).default([]),
        missing: z.array(z.string()).default([]),
        feedback: z.string().default(''),
        confidence: conf.default(0.5),
        /** The model asks for human review (ambiguous answer, possible wrong question number, ...). */
        review: z.boolean().catch(false).default(false),
        reviewReason: z.string().default(''),
      }),
    )
    .min(1),
});
export type EvaluationOutput = z.infer<typeof EvaluationOutput>;

export const AI_OUTPUT_SCHEMAS = {
  question_paper: QuestionPaperOutput,
  model_answer: ModelAnswerOutput,
  answer_ocr: AnswerOcrOutput,
  evaluation: EvaluationOutput,
} as const;
export type PromptKind = keyof typeof AI_OUTPUT_SCHEMAS;
