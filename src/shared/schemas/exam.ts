import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { Confidence, IsoDate, IsoDateTime, Marks, ModelRef, Origin, QuestionNumber, QuestionType, SafeId } from './common';

export const MarkingPoint = z.object({
  /** Stable within a question: "p1", "p2", ... Evaluation output refers to these ids. */
  id: z.string().regex(/^p[0-9]{1,3}$/),
  description: z.string().min(1).max(1000),
  marks: Marks,
});
export type MarkingPoint = z.infer<typeof MarkingPoint>;

export const Question = z.object({
  /** Printed label, e.g. "3(b)(ii)". */
  label: QuestionNumber,
  /** normalizeQuestionNumber(label). Unique within the exam and used as the key everywhere else. */
  number: QuestionNumber,
  /** Order in the paper (0-based). */
  order: z.number().int().min(0),
  text: z.string().max(8000),
  maxMarks: Marks.positive(),
  type: QuestionType,
  /** The reference answer. It may be empty when marking points are complete. */
  modelAnswer: z.string().max(20000).default(''),
  /**
   * Their marks should add up to maxMarks. The UI warns when they don't, and grading scales
   * proportionally. When empty, grading uses one implicit criterion "overall" = maxMarks.
   */
  markingPoints: z.array(MarkingPoint).max(50).default([]),
  /** For numerical questions: the expected final answer, including units. */
  finalAnswer: z.string().max(500).default(''),
  /** Diagram the model answer expects ("labelled diagram of a neuron"). */
  expectsDiagram: z.boolean().default(false),
  origin: Origin.default('manual'),
  /** Extraction confidence, if the question came from AI. */
  extractionConfidence: Confidence.optional(),
});
export type Question = z.infer<typeof Question>;

/** "Answer any 3 of Q5 to Q9": only the best N attempted answers count towards the total. */
export const ChoiceRule = z.object({
  id: z.string().min(1).max(20),
  questionNumbers: z.array(QuestionNumber).min(2),
  countBest: z.number().int().min(1),
  description: z.string().max(200).default(''),
});
export type ChoiceRule = z.infer<typeof ChoiceRule>;

export const SourceDoc = z.object({
  kind: z.enum(['pdf', 'images', 'manual']),
  /** Relative path inside the exam folder, e.g. "source/question_paper.pdf". */
  file: z.string().nullable(),
  originalFileNames: z.array(z.string()).default([]),
  pageCount: z.number().int().min(0),
  extractedWith: ModelRef.nullable().default(null),
  extractedAt: IsoDateTime.nullable().default(null),
});

export const ExamFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.exam),
  id: SafeId,
  title: z.string().min(1).max(200),
  courseCode: z.string().max(40).default(''),
  subject: z.string().max(120).default(''),
  className: z.string().max(120).default(''), // e.g. "B.Sc. CS, Sem 3, Sec A"
  examDate: IsoDate.nullable().default(null),
  /** Free-form instructions for the evaluator AI ("Ignore spelling mistakes", "Units are mandatory"). */
  evaluatorNotes: z.string().max(1000).default(''),
  sources: z.object({
    questionPaper: SourceDoc.nullable(),
    modelAnswer: SourceDoc.nullable(),
  }),
  questions: z.array(Question).max(200),
  choiceRules: z.array(ChoiceRule).default([]),
  /**
   * Sum of maxMarks after choice rules are applied. Cached here for listings and
   * recomputed on every save.
   */
  totalMarks: Marks,
  /** 'ready' means every question has max marks and a model answer or marking points. */
  status: z.enum(['draft', 'ready', 'archived']),
  /** Overrides the global grading settings for this exam when set. */
  gradingOverrides: z
    .object({
      strictness: z.enum(['lenient', 'standard', 'strict']).optional(),
      allowHalfMarks: z.boolean().optional(),
    })
    .default({}),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExamFile = z.infer<typeof ExamFile>;

/** Raw OCR of the question paper and model answer pages, kept so re-extraction is not billed again. */
const SourceDocExtraction = z.object({
  pages: z.array(
    z.object({
      index: z.number().int().min(0),
      file: z.string(),
      sha256: z.string(),
      /** Text layer of a typed PDF page ('' for scans and photos). Lets typed papers skip vision entirely. */
      text: z.string().default(''),
    }),
  ),
  /** Validated AI outputs (one per request) before the professor edits anything. */
  rawOutput: z.unknown().nullable(),
  cacheKeys: z.array(z.string()).default([]),
});

export const SourceExtractionFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.sourceExtraction),
  examId: SafeId,
  documents: z.object({
    questionPaper: SourceDocExtraction.nullable(),
    modelAnswer: SourceDocExtraction.nullable(),
  }),
  updatedAt: IsoDateTime,
});
export type SourceExtractionFile = z.infer<typeof SourceExtractionFile>;
