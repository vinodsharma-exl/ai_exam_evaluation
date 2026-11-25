/**
 * Runs one student's job task by task. Handlers (Phase 3 pipeline) do the actual work. The runner owns:
 *   - state transitions written to jobs.json before and after every task
 *   - pause (after the current task), cancel (abort now), resume
 *   - error classification: task-scoped failures continue, job-scoped failures pause
 *   - progress events for the Processing screen
 *
 * Handler contract: write all outputs (extraction.json, evaluation.json, cache, ...) BEFORE returning.
 * The runner marks the task done only after the handler resolves, so a crash in between just re-runs
 * the task, and the response cache makes that free.
 */
import { EventEmitter } from 'node:events';
import type { JobsFile, Task, TaskKind } from '../../shared/schemas/jobs';
import { AppError, type ErrorCode, redactSecrets } from '../../shared/errors';
import type { AppEvents } from '../../shared/ipc';
import type { JobStore } from './job-store';
import {
  TASK_SCOPED_ERRORS,
  errorData,
  insertTasksAfter,
  nextRunnableTask,
  pauseReasonFor,
  prepareResume,
  progressOf,
  supersedeTask,
  taskLabel,
  updateTask,
} from './job-logic';

export interface TaskContext {
  examId: string;
  studentId: string;
  signal: AbortSignal;
  /** Called by the request queue while it waits for a rate-limit slot (null when it continues). */
  setWaiting(resumeAt: number | null): void;
}

export interface TaskOutcome {
  /** Default 'done'. 'skipped' e.g. for an OCR group whose pages all became manual. */
  status?: 'done' | 'skipped';
  requestsUsed?: number;
  cacheHit?: boolean;
  /** Inserted right after this task (e.g. render_pages → OCR groups, merge → evaluation batches). */
  addTasks?: Task[];
  /** This task is replaced by these (batch split). It is marked 'superseded', not 'done'. */
  replaceWith?: Task[];
}

export type TaskHandler = (task: Task, ctx: TaskContext) => Promise<TaskOutcome>;
export type TaskHandlers = Record<TaskKind, TaskHandler>;

export type JobProgress = AppEvents['job:progress'];

interface Active {
  controller: AbortController;
  pauseRequested: boolean;
  /** 'quit' means the app is closing: the job becomes paused('app_closed') instead of cancelled. */
  abortReason: 'user' | 'quit';
  promise: Promise<JobsFile>;
}

const key = (e: string, s: string) => `${e}/${s}`;

export class JobRunner extends EventEmitter {
  private active = new Map<string, Active>();

  constructor(
    private readonly jobs: JobStore,
    private handlers: TaskHandlers,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    super();
  }

  /** Lets main wire the real pipeline handlers in after construction (Phase 3). */
  setHandlers(h: TaskHandlers): void {
    this.handlers = h;
  }

  isRunning(examId: string, studentId: string): boolean {
    return this.active.has(key(examId, studentId));
  }

  /** Starts or resumes. If already running, returns the running promise (no double runs). */
  run(examId: string, studentId: string): Promise<JobsFile> {
    const k = key(examId, studentId);
    const existing = this.active.get(k);
    if (existing) return existing.promise;
    const a: Active = { controller: new AbortController(), pauseRequested: false, abortReason: 'user', promise: Promise.resolve(null as never) };
    a.promise = this.loop(examId, studentId, a).finally(() => this.active.delete(k));
    this.active.set(k, a);
    return a.promise;
  }

  /** Stops after the current task finishes, so a request already sent is not wasted. */
  requestPause(examId: string, studentId: string): boolean {
    const a = this.active.get(key(examId, studentId));
    if (!a) return false;
    a.pauseRequested = true;
    return true;
  }

  /** Aborts the current request immediately. Completed tasks are kept. */
  cancel(examId: string, studentId: string): boolean {
    const a = this.active.get(key(examId, studentId));
    if (!a) return false;
    a.controller.abort();
    return true;
  }

  /** Pause all running jobs (app quitting). Resolves when they have stopped. */
  async stopAll(): Promise<void> {
    const all = [...this.active.values()];
    for (const a of all) {
      a.abortReason = 'quit';
      a.controller.abort();
    }
    await Promise.allSettled(all.map((a) => a.promise));
  }

  private emitProgress(job: JobsFile, current: Task | null, error: JobProgress['error'] = null): void {
    const { done, total } = progressOf(job);
    const payload: JobProgress = {
      examId: job.examId,
      studentId: job.studentId,
      state: job.state,
      done,
      total,
      currentTaskId: current?.id ?? null,
      currentLabel: current ? taskLabel(current) : '',
      resumeAt: job.resumeAt,
      error,
    };
    this.emit('progress', payload);
  }

  private async loop(examId: string, studentId: string, a: Active): Promise<JobsFile> {
    const iso = () => this.jobs.iso();
    let job = await this.jobs.getOrCreate(examId, studentId);
    if (job.state === 'completed' && !nextRunnableTask(job)) {
      this.emitProgress(job, null);
      return job;
    }
    job = await this.jobs.mutate(examId, studentId, (j) => prepareResume(j, iso()));
    this.emit('state', job);
    this.emitProgress(job, null);

    for (;;) {
      if (a.pauseRequested) {
        job = await this.jobs.mutate(examId, studentId, (j) => ({ ...j, state: 'paused', pauseReason: 'user', resumeAt: null, updatedAt: iso() }));
        this.emit('state', job);
        this.emitProgress(job, null);
        return job;
      }
      const task = nextRunnableTask(job);
      if (!task) {
        job = await this.jobs.mutate(examId, studentId, (j) => ({ ...j, state: 'completed', pauseReason: null, resumeAt: null, updatedAt: iso() }));
        this.emit('state', job);
        this.emitProgress(job, null);
        return job;
      }

      job = await this.jobs.mutate(examId, studentId, (j) =>
        updateTask(j, task.id, { status: 'running', startedAt: iso(), attempts: task.attempts + 1 }, iso()),
      );
      this.emitProgress(job, task);

      const ctx: TaskContext = {
        examId,
        studentId,
        signal: a.controller.signal,
        setWaiting: (resumeAt) => {
          // In memory only; jobs.json gets the state on the next write. The UI gets it right away.
          job = { ...job, state: resumeAt ? 'waiting_rate_limit' : 'running', resumeAt };
          this.emitProgress(job, task);
        },
      };

      try {
        if (a.controller.signal.aborted) throw new AppError('CANCELLED');
        const handler = this.handlers[task.kind];
        if (!handler) throw new AppError('NOT_IMPLEMENTED', `No handler for ${task.kind}`);
        const out = await handler(task, ctx);
        job = await this.jobs.mutate(examId, studentId, (j) => {
          const now = iso();
          const cur = j.tasks.find((t) => t.id === task.id)!;
          const stats = {
            requestsUsed: cur.requestsUsed + (out.requestsUsed ?? 0),
            cacheHit: out.cacheHit ?? false,
            lastError: null,
            finishedAt: now,
          };
          let next: JobsFile;
          if (out.replaceWith && out.replaceWith.length > 0) {
            next = supersedeTask(updateTask(j, task.id, stats, now), task.id, out.replaceWith, now);
          } else {
            next = updateTask(j, task.id, { ...stats, status: out.status ?? 'done' }, now);
          }
          if (out.addTasks?.length) next = insertTasksAfter(next, task.id, out.addTasks, now);
          return { ...next, state: 'running', resumeAt: null };
        });
        this.emitProgress(job, null);
      } catch (err) {
        const { code, detail } = classify(err, a.controller.signal.aborted);
        const data = errorData(code, detail, iso());
        if (code === 'CANCELLED') {
          const quitting = a.abortReason === 'quit';
          job = await this.jobs.mutate(examId, studentId, (j) => ({
            ...updateTask(j, task.id, { status: 'pending', startedAt: null }, iso()),
            state: quitting ? 'paused' : 'cancelled',
            pauseReason: quitting ? 'app_closed' : 'user',
            resumeAt: null,
          }));
          this.emit('state', job);
          this.emitProgress(job, null, data);
          return job;
        }
        this.log(`task ${examId}/${studentId}/${task.id} failed: ${code} ${detail ?? ''}`);
        if (TASK_SCOPED_ERRORS.has(code)) {
          job = await this.jobs.mutate(examId, studentId, (j) =>
            updateTask(j, task.id, { status: 'failed', lastError: data, finishedAt: iso() }, iso()),
          );
          this.emitProgress(job, null, data);
          continue;
        }
        job = await this.jobs.mutate(examId, studentId, (j) => ({
          ...updateTask(j, task.id, { status: 'failed', lastError: data, finishedAt: iso() }, iso()),
          state: 'paused',
          pauseReason: pauseReasonFor(code),
          resumeAt: err instanceof AppError && err.resumeAt ? err.resumeAt : null,
        }));
        this.emit('state', job);
        this.emitProgress(job, null, data);
        return job;
      }
    }
  }
}

function classify(err: unknown, aborted: boolean): { code: ErrorCode; detail?: string } {
  if (err instanceof AppError) return { code: err.code, detail: err.toData().detail };
  if (aborted || (err as Error)?.name === 'AbortError') return { code: 'CANCELLED' };
  return { code: 'UNKNOWN', detail: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 500) };
}
