import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { AppErrorDataSchema, IsoDateTime, ModelRef, QuestionNumber, SafeId } from './common';

export const TaskKind = z.enum([
  'render_pages', // local: PDF/photos → normalised JPEGs. No AI.
  'ocr_pages', // Stage A: one request for a group of pages
  'merge_answers', // local: fragments → one answer per question
  'evaluate_questions', // Stage B: one request for a batch of questions
  'finalize_totals', // local: clamp, round, choice rules, flags, update index
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const TaskStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped', 'superseded']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const Task = z.object({
  /** Unique within the job. Stable, so logs and the UI can refer to it: "ocr:0-2", "eval:b1", "eval:3a#2". */
  id: z.string().min(1).max(80),
  kind: TaskKind,
  /** Page indexes (ocr_pages) or question numbers (evaluate_questions). */
  pages: z.array(z.number().int().min(0)).default([]),
  questions: z.array(QuestionNumber).default([]),
  status: TaskStatus,
  /** Model chosen when the task was planned. If Settings change before it runs, it is re-resolved. */
  model: ModelRef.nullable().default(null),
  attempts: z.number().int().min(0).default(0),
  /** AI requests this task actually sent (excluding cache hits). Retries and the repair call count. */
  requestsUsed: z.number().int().min(0).default(0),
  cacheHit: z.boolean().default(false),
  /** Set when an evaluate batch is split into single-question tasks after context or JSON failure. */
  supersededBy: z.array(z.string()).default([]),
  /** Why this task was added after the initial plan, e.g. "reevaluate", "rerun_ocr_page". */
  reason: z.string().max(60).default('plan'),
  /** Set on manual reruns. Skips the response cache. */
  bypassCache: z.boolean().default(false),
  lastError: AppErrorDataSchema.nullable().default(null),
  startedAt: IsoDateTime.nullable().default(null),
  finishedAt: IsoDateTime.nullable().default(null),
});
export type Task = z.infer<typeof Task>;

export const JobState = z.enum([
  'idle', // planned, not started
  'queued', // waiting in the global queue behind other students
  'running',
  'waiting_rate_limit', // short wait (RPM). Resumes on its own.
  'paused', // needs the user, or a long wait (daily cap, offline, app closed)
  'completed',
  'failed',
  'cancelled',
]);
export type JobState = z.infer<typeof JobState>;

export const PauseReason = z.enum([
  'user',
  'rate_limit_daily',
  'network',
  'auth',
  'app_closed',
  'no_vision_model',
  'error',
]);

export const JobsFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.jobs),
  examId: SafeId,
  studentId: SafeId,
  state: JobState,
  pauseReason: PauseReason.nullable().default(null),
  /** For waiting_rate_limit: epoch ms. The UI shows a countdown. */
  resumeAt: z.number().nullable().default(null),
  tasks: z.array(Task),
  /** Estimate shown to the user before starting. */
  estimate: z
    .object({
      requests: z.number().int().min(0),
      minutes: z.number().min(0),
      byStage: z.object({ ocr: z.number().int().min(0), evaluation: z.number().int().min(0) }),
    })
    .nullable()
    .default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type JobsFile = z.infer<typeof JobsFile>;

/** queue.json: order of students for "Process all (queued)". One student runs at a time. */
export const GlobalQueueFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.globalQueue),
  items: z.array(
    z.object({
      examId: SafeId,
      studentId: SafeId,
      addedAt: IsoDateTime,
    }),
  ),
  /** false after the user presses Pause all. Kept across restarts. Nothing auto-starts on launch unless true. */
  autoRun: z.boolean().default(false),
  updatedAt: IsoDateTime,
});
export type GlobalQueueFile = z.infer<typeof GlobalQueueFile>;
