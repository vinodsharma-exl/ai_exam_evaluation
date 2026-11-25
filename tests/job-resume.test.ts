/**
 * Resume logic: completed work is never redone, interrupted work continues exactly where it stopped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/main/store/file-store';
import { JobStore } from '../src/main/jobs/job-store';
import { JobRunner, type TaskHandlers, type TaskOutcome } from '../src/main/jobs/job-runner';
import { GlobalQueue } from '../src/main/jobs/global-queue';
import { newTask, planEvaluationBatches, planOcrTasks, splitEvaluationTask, ocrGroupSize } from '../src/main/jobs/job-planner';
import { recoverJob, addRerunTasks } from '../src/main/jobs/job-logic';
import { AppError } from '../src/shared/errors';
import { ensureLayout } from '../src/main/store/data-dir';
import * as P from '../src/shared/paths';
import type { Task } from '../src/shared/schemas/jobs';
import { tempDir } from './helpers';

const M = { providerId: 'mock' as const, model: 'mock-vision' };
let t: ReturnType<typeof tempDir>;
let store: FileStore;
let jobs: JobStore;

beforeEach(async () => {
  t = tempDir();
  await ensureLayout(t.dir);
  store = new FileStore(t.dir);
  jobs = new JobStore(store);
  await store.mkdir(P.studentDir('E1', 'S1'));
  await store.mkdir(P.studentDir('E1', 'S2'));
});
afterEach(() => t.cleanup());

/** Handlers that mimic the real pipeline shape: render adds 5 OCR pages (groups of 2), merge adds 3 eval batches. */
function fakePipeline(opts: { failOn?: Record<string, () => never>; calls: string[] }): TaskHandlers {
  const run = (task: Task, out: TaskOutcome = {}): Promise<TaskOutcome> => {
    opts.calls.push(task.id);
    const f = opts.failOn?.[task.id];
    if (f) f();
    return Promise.resolve({ requestsUsed: task.kind === 'ocr_pages' || task.kind === 'evaluate_questions' ? 1 : 0, ...out });
  };
  return {
    render_pages: (task) => run(task, { addTasks: planOcrTasks([0, 1, 2, 3, 4], 2, M) }),
    ocr_pages: (task) => run(task),
    merge_answers: (task) =>
      run(task, { addTasks: [['1', '2'], ['3'], ['4']].map((q, i) => newTask({ id: `eval:b${i + 1}`, kind: 'evaluate_questions', questions: q, model: M })) }),
    evaluate_questions: (task) => run(task),
    finalize_totals: (task) => run(task),
  };
}

const FULL_ORDER = ['render', 'ocr:1-2', 'ocr:3-4', 'ocr:5-5', 'merge', 'eval:b1', 'eval:b2', 'eval:b3', 'finalize'];

describe('JobRunner', () => {
  it('runs the plan as it grows, in order, exactly once', async () => {
    const calls: string[] = [];
    const runner = new JobRunner(jobs, fakePipeline({ calls }));
    const job = await runner.run('E1', 'S1');
    expect(job.state).toBe('completed');
    expect(calls).toEqual(FULL_ORDER);
    expect(job.tasks.every((x) => x.status === 'done')).toBe(true);
    expect(job.tasks.reduce((a, x) => a + x.requestsUsed, 0)).toBe(6);
    // Running a completed job does nothing.
    await runner.run('E1', 'S1');
    expect(calls).toHaveLength(FULL_ORDER.length);
  });

  it('pauses on daily quota and resumes at the same task without redoing finished ones', async () => {
    const calls: string[] = [];
    let quotaGone = true;
    const failOn = { 'ocr:3-4': () => { if (quotaGone) throw new AppError('QUOTA_EXHAUSTED'); return undefined as never; } };
    const runner = new JobRunner(jobs, fakePipeline({ calls, failOn: failOn as Record<string, () => never> }));
    const paused = await runner.run('E1', 'S1');
    expect(paused.state).toBe('paused');
    expect(paused.pauseReason).toBe('rate_limit_daily');
    expect(calls).toEqual(['render', 'ocr:1-2', 'ocr:3-4']);

    quotaGone = false; // next day
    calls.length = 0;
    const done = await runner.run('E1', 'S1');
    expect(done.state).toBe('completed');
    expect(calls).toEqual(['ocr:3-4', 'ocr:5-5', 'merge', 'eval:b1', 'eval:b2', 'eval:b3', 'finalize']);
  });

  it('recovers after a crash: running tasks go back to pending, done tasks stay done', async () => {
    const calls: string[] = [];
    // First run stops in the middle of ocr:3-4, simulating the app being killed.
    const crashRunner = new JobRunner(jobs, {
      ...fakePipeline({ calls }),
      ocr_pages: async (task) => {
        calls.push(task.id);
        if (task.id === 'ocr:3-4') return new Promise<TaskOutcome>(() => undefined); // never settles
        return {};
      },
    });
    void crashRunner.run('E1', 'S1');
    await waitFor(async () => (await jobs.get('E1', 'S1'))?.tasks.some((x) => x.id === 'ocr:3-4' && x.status === 'running'));

    // "Restart": a new runner on the same files.
    const recovered = await jobs.recoverAll();
    expect(recovered).toEqual([{ examId: 'E1', studentId: 'S1' }]);
    const after = await jobs.require('E1', 'S1');
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('app_closed');
    expect(after.tasks.find((x) => x.id === 'ocr:3-4')?.status).toBe('pending');

    calls.length = 0;
    const runner = new JobRunner(jobs, fakePipeline({ calls }));
    const done = await runner.run('E1', 'S1');
    expect(done.state).toBe('completed');
    expect(calls[0]).toBe('ocr:3-4');
    expect(calls).not.toContain('render');
    expect(calls).not.toContain('ocr:1-2');
  });

  it('task-scoped failures do not stop the job', async () => {
    const calls: string[] = [];
    const runner = new JobRunner(jobs, fakePipeline({ calls, failOn: { 'ocr:5-5': () => { throw new AppError('UNREADABLE_SCAN'); } } }));
    const job = await runner.run('E1', 'S1');
    expect(job.state).toBe('completed');
    expect(job.tasks.find((x) => x.id === 'ocr:5-5')?.status).toBe('failed');
    expect(job.tasks.find((x) => x.id === 'ocr:5-5')?.lastError?.code).toBe('UNREADABLE_SCAN');
    expect(calls).toContain('finalize');
  });

  it('auth errors pause; resume retries the failed task (bounded attempts)', async () => {
    const calls: string[] = [];
    let bad = true;
    const runner = new JobRunner(jobs, fakePipeline({ calls, failOn: { render: () => { if (bad) throw new AppError('INVALID_API_KEY'); return undefined as never; } } as never }));
    const j1 = await runner.run('E1', 'S1');
    expect(j1.pauseReason).toBe('auth');
    bad = false;
    const j2 = await runner.run('E1', 'S1');
    expect(j2.state).toBe('completed');
    expect(j2.tasks.find((x) => x.id === 'render')?.attempts).toBe(2);
  });

  it('cancel aborts the current task and keeps it pending; stopAll (quit) pauses as app_closed', async () => {
    const calls: string[] = [];
    const slow: TaskHandlers = {
      ...fakePipeline({ calls }),
      ocr_pages: (task, ctx) =>
        new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new AppError('CANCELLED')))),
    };
    const runner = new JobRunner(jobs, slow);
    const p = runner.run('E1', 'S1');
    await waitFor(async () => (await jobs.get('E1', 'S1'))?.tasks.some((x) => x.kind === 'ocr_pages' && x.status === 'running'));
    runner.cancel('E1', 'S1');
    const j = await p;
    expect(j.state).toBe('cancelled');
    expect(j.tasks.find((x) => x.id === 'ocr:1-2')?.status).toBe('pending');

    const p2 = runner.run('E1', 'S1');
    await waitFor(async () => (await jobs.get('E1', 'S1'))?.tasks.some((x) => x.kind === 'ocr_pages' && x.status === 'running'));
    await runner.stopAll();
    const j2 = await p2;
    expect(j2.state).toBe('paused');
    expect(j2.pauseReason).toBe('app_closed');
  });

  it('pause waits for the current task to finish, then stops', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner = new JobRunner(jobs, {
      ...fakePipeline({ calls }),
      render_pages: async (task) => {
        calls.push(task.id);
        await gate;
        return { addTasks: planOcrTasks([0, 1], 2, M) };
      },
    });
    const p = runner.run('E1', 'S1');
    await waitFor(async () => calls.includes('render'));
    runner.requestPause('E1', 'S1');
    release();
    const j = await p;
    expect(j.state).toBe('paused');
    expect(j.pauseReason).toBe('user');
    expect(j.tasks.find((x) => x.id === 'render')?.status).toBe('done'); // the paid-for work is kept
    expect(calls).toEqual(['render']);
  });

  it('splits a failing batch into single questions (superseded, never re-run)', async () => {
    const calls: string[] = [];
    const base = fakePipeline({ calls });
    const runner = new JobRunner(jobs, {
      ...base,
      evaluate_questions: async (task) => {
        calls.push(task.id);
        if (task.questions.length > 1) return { requestsUsed: 1, replaceWith: splitEvaluationTask(task) };
        return { requestsUsed: 1 };
      },
    });
    const j = await runner.run('E1', 'S1');
    expect(j.state).toBe('completed');
    expect(j.tasks.find((x) => x.id === 'eval:b1')?.status).toBe('superseded');
    expect(calls.filter((c) => c.startsWith('eval:b1'))).toEqual(['eval:b1', 'eval:b1/1', 'eval:b1/2']);
    // Superseded tasks don't count towards progress, and a resume ignores them.
    calls.length = 0;
    await runner.run('E1', 'S1');
    expect(calls).toEqual([]);
  });

  it('re-evaluate adds a task and re-opens totals on a completed job', async () => {
    const calls: string[] = [];
    const runner = new JobRunner(jobs, fakePipeline({ calls }));
    await runner.run('E1', 'S1');
    calls.length = 0;
    await jobs.mutate('E1', 'S1', (j) => addRerunTasks(j, [newTask({ id: 'eval:3#reeval', kind: 'evaluate_questions', questions: ['3'], reason: 'reevaluate', bypassCache: true })], new Date().toISOString()));
    await runner.run('E1', 'S1');
    expect(calls).toEqual(['eval:3#reeval', 'finalize']);
  });
});

describe('recoverJob (pure)', () => {
  it('returns null when nothing needs recovering', async () => {
    const j = await jobs.create('E1', 'S1');
    expect(recoverJob(j, new Date().toISOString())).toBeNull();
  });
});

describe('planner', () => {
  it('groups consecutive pages and never bridges gaps', () => {
    expect(planOcrTasks([0, 1, 2, 4, 5], 2, M).map((x) => x.pages)).toEqual([[0, 1], [2], [4, 5]]);
  });

  it('caps the OCR group size by model and preset', () => {
    const caps = { supportsVision: true, maxImagesPerRequest: 5, requestsPerMinute: 10, dailyLimit: 100, contextWindow: 32000, maxOutputTokens: 4096, supportsJsonMode: true };
    expect(ocrGroupSize(caps, 3)).toBe(3);
    expect(ocrGroupSize({ ...caps, maxImagesPerRequest: 0 }, 3)).toBe(1);
  });

  it('packs evaluation batches by context, output budget and max per batch', () => {
    const caps = { supportsVision: false, maxImagesPerRequest: 0, requestsPerMinute: 10, dailyLimit: 100, contextWindow: 8192, maxOutputTokens: 2048, supportsJsonMode: true };
    const items = Array.from({ length: 10 }, (_, i) => ({ number: String(i + 1), tokens: 600 }));
    const batches = planEvaluationBatches(items, caps, { batchQuestions: true, maxQuestionsPerBatch: 8 });
    // Output budget: floor((2048-200)/450) = 4 per batch; input budget 8192*0.6-2048-450 = 2417 → 4×600=2400 fits.
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2]);
    expect(planEvaluationBatches(items, caps, { batchQuestions: false, maxQuestionsPerBatch: 8 })).toHaveLength(10);
  });
});

describe('GlobalQueue', () => {
  it('processes students one at a time and stops (keeping autoRun) on daily quota', async () => {
    const calls: string[] = [];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const handlers = fakePipeline({ calls });
    const tracked: TaskHandlers = {
      ...handlers,
      render_pages: async (task, ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(ctx.studentId);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return handlers.render_pages(task, ctx);
      },
    };
    const runner = new JobRunner(jobs, tracked);
    const queue = new GlobalQueue(store, runner);
    await queue.enqueue([{ examId: 'E1', studentId: 'S1' }, { examId: 'E1', studentId: 'S2' }]);
    await queue.idle();
    expect(order).toEqual(['S1', 'S2']);
    expect(maxActive).toBe(1);
    expect((await queue.status()).pending).toBe(0);

    // Now a quota failure on the next student.
    const quotaRunner = new JobRunner(jobs, { ...handlers, render_pages: async () => { throw new AppError('QUOTA_EXHAUSTED'); } });
    await store.mkdir(P.studentDir('E1', 'S3'));
    const q2 = new GlobalQueue(store, quotaRunner);
    await q2.enqueue([{ examId: 'E1', studentId: 'S3' }]);
    await q2.idle();
    const st = await q2.status();
    expect(st.pending).toBe(1);
    expect(st.autoRun).toBe(true); // resumes next launch / tomorrow
  });
});

async function waitFor(cond: () => Promise<boolean | undefined> | boolean | undefined, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}
