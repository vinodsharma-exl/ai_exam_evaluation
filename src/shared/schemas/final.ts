import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDateTime, Marks, QuestionNumber, SafeId } from './common';

export const FinalQuestion = z.object({
  questionNumber: QuestionNumber,
  maxMarks: Marks,
  /** AI recommendation at the time the professor last saved. null if not evaluated or not attempted. */
  aiMarks: Marks.nullable(),
  /** The professor's mark. Validated to [0, maxMarks] and the half-mark step. */
  finalMarks: Marks,
  /** true when finalMarks differs from aiMarks or was entered without an AI mark. */
  overridden: z.boolean(),
  /** Comment for the student report. Defaults to the AI feedback and the professor can edit it. */
  comment: z.string().max(2000).default(''),
  /** Private note, never printed. */
  privateNote: z.string().max(2000).default(''),
  /** Excluded from the total by an "answer any N" rule. */
  dropped: z.boolean().default(false),
});
export type FinalQuestion = z.infer<typeof FinalQuestion>;

/** Append-only. Every change to a final mark or comment adds one entry. */
export const AuditEntry = z.object({
  at: IsoDateTime,
  by: z.string().max(120), // profile name
  action: z.enum(['create', 'edit_marks', 'edit_comment', 'accept_ai', 'finalize', 'unfinalize', 'reevaluate_applied']),
  questionNumber: QuestionNumber.nullable(),
  from: z.union([z.number(), z.string(), z.null()]),
  to: z.union([z.number(), z.string(), z.null()]),
  reason: z.string().max(500).default(''),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const FinalFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.final),
  examId: SafeId,
  studentId: SafeId,
  status: z.enum(['draft', 'finalized']),
  questions: z.array(FinalQuestion),
  total: Marks,
  maxTotal: Marks,
  percentage: z.number().min(0).max(100),
  grade: z.string().max(10).default(''),
  overallComment: z.string().max(4000).default(''),
  finalizedAt: IsoDateTime.nullable().default(null),
  finalizedBy: z.string().max(120).nullable().default(null),
  audit: z.array(AuditEntry).default([]),
  reportGeneratedAt: IsoDateTime.nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FinalFile = z.infer<typeof FinalFile>;
