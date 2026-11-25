import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { AppErrorDataSchema, Confidence, IsoDateTime, ModelRef, Origin, QuestionNumber, SafeId, Sha256 } from './common';

/** One piece of an answer found on one page. A page may hold several fragments, and an answer may span pages. */
export const PageFragment = z.object({
  /** Normalised question number, or null if the page does not say which question this is. */
  questionNumber: QuestionNumber.nullable(),
  /** true when the text continues the answer from the previous page or fragment (no new question label). */
  continued: z.boolean(),
  /** Text in reading order. Crossed-out text is left out. Unreadable words become [illegible]. Tables use markdown and maths uses plain inline notation (x^2, sqrt(), a/b). */
  text: z.string().max(20000),
  hasDiagram: z.boolean().default(false),
  diagramDescription: z.string().max(2000).default(''),
  illegibleCount: z.number().int().min(0).default(0),
  confidence: Confidence,
});
export type PageFragment = z.infer<typeof PageFragment>;

export const PageOcrStatus = z.enum(['pending', 'done', 'failed', 'manual', 'blank', 'skipped']);

export const ExtractionPage = z.object({
  /** 0-based position in the submission after the professor reordered pages. */
  index: z.number().int().min(0),
  /** Relative to the student folder, e.g. "pages/p001.jpg". */
  file: z.string(),
  source: z.object({
    uploadIndex: z.number().int().min(0),
    pageInUpload: z.number().int().min(0),
  }),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Hash of the JPEG bytes actually sent to the AI. Part of the cache key. */
  sha256: Sha256,
  ocr: z.object({
    status: PageOcrStatus,
    by: ModelRef.nullable().default(null),
    cacheKey: z.string().nullable().default(null),
    at: IsoDateTime.nullable().default(null),
    error: AppErrorDataSchema.nullable().default(null),
  }),
  fragments: z.array(PageFragment).default([]),
  /** Notes from the OCR model about the whole page ("bottom third smudged"). */
  pageNote: z.string().max(500).default(''),
});
export type ExtractionPage = z.infer<typeof ExtractionPage>;

/** One answer after merge_answers has stitched the fragments together. This is what Stage B grades. */
export const MergedAnswer = z.object({
  questionNumber: QuestionNumber,
  /** Pages (0-based indexes) this answer appears on, in order. Used by Question Detail for the image panel. */
  pages: z.array(z.number().int().min(0)),
  text: z.string().max(40000),
  hasDiagram: z.boolean(),
  diagramDescription: z.string().max(4000).default(''),
  illegibleCount: z.number().int().min(0),
  /** Minimum confidence of the contributing fragments. */
  confidence: Confidence,
  origin: Origin,
  editedAt: IsoDateTime.nullable().default(null),
  /** Hash of `text`, so the evaluation can detect that the answer changed after it was graded. */
  textHash: Sha256,
});
export type MergedAnswer = z.infer<typeof MergedAnswer>;

export const ExtractionFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.extraction),
  examId: SafeId,
  studentId: SafeId,
  pages: z.array(ExtractionPage),
  answers: z.array(MergedAnswer).default([]),
  /** Exam questions with no answer found. Graded as 0 / not attempted unless the professor adds text. */
  notAttempted: z.array(QuestionNumber).default([]),
  /** Text that could not be tied to any question (e.g. rough work). Shown so the professor can assign it. */
  unassigned: z
    .array(z.object({ page: z.number().int().min(0), text: z.string().max(20000) }))
    .default([]),
  /** Question numbers the student wrote that are not in the exam (e.g. a typo "Q11"). */
  unknownQuestionNumbers: z.array(z.string()).default([]),
  mergedAt: IsoDateTime.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExtractionFile = z.infer<typeof ExtractionFile>;
