/**
 * Pure state rules for jobs.json. No I/O here, so the resume guarantees can be unit-tested:
 *
 *  1. A task marked 'done' is never run again (only 'pending' tasks are picked).
 *  2. After a crash, 'running' tasks go back to 'pending'. Their results were never committed, because
 *     a task is marked done only after its output files are written. The response cache then makes the
 *     repeated call free.
 *  3. Resume gives failed tasks another chance, up to MAX_TASK_ATTEMPTS in total.
 *  4. New tasks (OCR groups, evaluation batches, splits, re-runs) are inserted right after the task that
 *     created them. Old tasks are never rewritten, only marked 'superseded'.
 */
import type { JobsFile, Task, JobState } from '../../shared/schemas/jobs';
import type { AppErrorData, ErrorCode } from '../../shared/errors';

export const MAX_TASK_ATTEMPTS = 3;

/** These failures affect one task only. The job carries on with the next task. */
export const TASK_SCOPED_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'UNREADABLE_SCAN',
  'CONTENT_FILTERED',
  'INVALID_AI_JSON',
  'PDF_RENDER_FAILED',
  'BLANK_PAGE',
  'CONTEXT_TOO_LONG',
]);

/** These pause the whole job until the professor acts (or the quota resets). */
export function pauseReasonFor(code: ErrorCode): NonNullable<JobsFile['pauseReason']> {
  switch (code) {
    case 'QUOTA_EXHAUSTED':
      return 'rate_limit_daily';
    case 'INVALID_API_KEY':
    case 'MISSING_API_KEY':
    case 'ENCRYPTION_UNAVAILABLE':
      return 'auth';
    case 'NETWORK_OFFLINE':
      return 'network';
    case 'MODEL_NO_VISION':
      return 'no_vision_model';
    case 'CANCELLED':
      return 'user';
    default:
      return 'error';
  }
}

const ACTIVE_STATES: ReadonlySet<JobState> = new Set<JobState>(['running', 'waiting_rate_limit']);

/** Applied to every jobs.json at app start. Returns null if nothing changed. */
export function recoverJob(job: JobsFile, nowIso: string): JobsFile | null {
  const hasRunningTask = job.tasks.some((t) => t.status === 'running');
  if (!ACTIVE_STATES.has(job.state) && !hasRunningTask) return null;
  return {
    ...job,
    state: ACTIVE_STATES.has(job.state) ? 'paused' : job.state,
    pauseReason: ACTIVE_STATES.has(job.state) ? 'app_closed' : job.pauseReason,
    resumeAt: null,
    tasks: job.tasks.map((t) => (t.status === 'running' ? { ...t, status: 'pending', startedAt: null } : t)),
    updatedAt: nowIso,
  };
}

/** Called when the professor presses Resume or Start on an existing job. */
export function prepareResume(job: JobsFile, nowIso: string): JobsFile {
  return {
    ...job,
    state: 'running',
    pauseReason: null,
    resumeAt: null,
    tasks: job.tasks.map((t) => {
      if (t.status === 'running') return { ...t, status: 'pending', startedAt: null };
      if (t.status === 'failed' && t.attempts < MAX_TASK_ATTEMPTS) return { ...t, status: 'pending' };
      return t;
    }),
    updatedAt: nowIso,
  };
}

export function nextRunnableTask(job: JobsFile): Task | undefined {
  return job.tasks.find((t) => t.status === 'pending');
}

export function updateTask(job: JobsFile, id: string, patch: Partial<Task>, nowIso: string): JobsFile {
  let found = false;
  const tasks = job.tasks.map((t) => {
    if (t.id !== id) return t;
    found = true;
    return { ...t, ...patch };
  });
  if (!found) throw new Error(`Task ${id} not found`);
  return { ...job, tasks, updatedAt: nowIso };
}

/**
 * Inserts tasks right after `afterId`. Tasks whose id already exists are skipped, so a handler that
 * runs twice (e.g. after a crash between writing outputs and marking done) can't duplicate work.
 */
export function insertTasksAfter(job: JobsFile, afterId: string, newTasks: Task[], nowIso: string): JobsFile {
  const existing = new Set(job.tasks.map((t) => t.id));
  const toAdd = newTasks.filter((t) => !existing.has(t.id));
  if (toAdd.length === 0) return job;
  const idx = job.tasks.findIndex((t) => t.id === afterId);
  const at = idx === -1 ? job.tasks.length : idx + 1;
  const tasks = [...job.tasks.slice(0, at), ...toAdd, ...job.tasks.slice(at)];
  return { ...job, tasks, updatedAt: nowIso };
}

/** Marks a task superseded by replacements (e.g. a batch split into single questions) and inserts them after it. */
export function supersedeTask(job: JobsFile, id: string, replacements: Task[], nowIso: string): JobsFile {
  const marked = updateTask(
    job,
    id,
    { status: 'superseded', supersededBy: replacements.map((r) => r.id), finishedAt: nowIso },
    nowIso,
  );
  return insertTasksAfter(marked, id, replacements, nowIso);
}

/** Adds a re-run task (e.g. "Re-evaluate Q4") before finalize_totals, and re-opens finalize so totals update. */
export function addRerunTasks(job: JobsFile, tasks: Task[], nowIso: string): JobsFile {
  const finalizeIdx = job.tasks.findIndex((t) => t.kind === 'finalize_totals');
  const afterId = finalizeIdx > 0 ? job.tasks[finalizeIdx - 1]!.id : job.tasks[job.tasks.length - 1]?.id ?? '';
  let next = insertTasksAfter(job, afterId, tasks, nowIso);
  next = {
    ...next,
    tasks: next.tasks.map((t) => (t.kind === 'finalize_totals' ? { ...t, status: 'pending', finishedAt: null } : t)),
  };
  if (next.state === 'completed' || next.state === 'cancelled' || next.state === 'failed') next = { ...next, state: 'idle' };
  return next;
}

export function progressOf(job: JobsFile): { done: number; total: number } {
  const counted = job.tasks.filter((t) => t.status !== 'superseded');
  return {
    done: counted.filter((t) => t.status === 'done' || t.status === 'skipped' || t.status === 'failed').length,
    total: counted.length,
  };
}

export function taskLabel(t: Task): string {
  switch (t.kind) {
    case 'render_pages':
      return 'Preparing page images';
    case 'ocr_pages': {
      const a = (t.pages[0] ?? 0) + 1;
      const b = (t.pages[t.pages.length - 1] ?? 0) + 1;
      return a === b ? `Reading page ${a}` : `Reading pages ${a}-${b}`;
    }
    case 'merge_answers':
      return 'Matching answers to questions';
    case 'evaluate_questions':
      return `Evaluating ${t.questions.map((q) => `Q${q}`).join(', ')}`;
    case 'finalize_totals':
      return 'Calculating totals';
  }
}

export function errorData(code: ErrorCode, detail: string | undefined, nowIso: string): AppErrorData {
  return { code, detail, at: nowIso };
}
