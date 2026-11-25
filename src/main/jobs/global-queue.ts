/**
 * "Process all (queued)": students run ONE AT A TIME through the shared rate limiter, in queue.json order.
 *
 * After each job:
 *   completed / failed / cancelled          → removed from the queue, continue with the next student
 *   paused: rate_limit_daily or app_closed  → stop, keep autoRun on (resumes on next launch or Resume)
 *   paused: user / auth / network / ...     → stop and switch autoRun off (needs the professor)
 */
import { EventEmitter } from 'node:events';
import type { GlobalQueueFile, JobsFile } from '../../shared/schemas/jobs';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { ROOT_FILES } from '../../shared/paths';
import type { FileStore } from '../store/file-store';
import type { JobRunner } from './job-runner';

export interface QueueStatus {
  pending: number;
  running: { examId: string; studentId: string } | null;
  autoRun: boolean;
}

export class GlobalQueue extends EventEmitter {
  private loopPromise: Promise<void> | null = null;
  private running: { examId: string; studentId: string } | null = null;
  private stopRequested = false;

  constructor(
    private readonly store: FileStore,
    private readonly runner: JobRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    super();
  }

  private empty(): GlobalQueueFile {
    return { schemaVersion: SCHEMA_VERSIONS.globalQueue, items: [], autoRun: false, updatedAt: this.now().toISOString() };
  }

  async load(): Promise<GlobalQueueFile> {
    try {
      return (await this.store.read('globalQueue', ROOT_FILES.globalQueue)) ?? this.empty();
    } catch {
      return this.empty(); // a corrupt queue is quarantined by the store; nothing is lost but the order
    }
  }

  private async mutate(fn: (q: GlobalQueueFile) => GlobalQueueFile): Promise<GlobalQueueFile> {
    const out = await this.store.update('globalQueue', ROOT_FILES.globalQueue, (cur) => ({
      ...fn(cur ?? this.empty()),
      updatedAt: this.now().toISOString(),
    }));
    await this.emitStatus(out!);
    return out!;
  }

  async status(): Promise<QueueStatus> {
    const q = await this.load();
    return { pending: q.items.length, running: this.running, autoRun: q.autoRun };
  }

  private async emitStatus(q?: GlobalQueueFile): Promise<void> {
    const file = q ?? (await this.load());
    this.emit('update', { pending: file.items.length, running: this.running, autoRun: file.autoRun } satisfies QueueStatus);
  }

  /** Adds students (skips ones already queued) and starts processing. */
  async enqueue(items: Array<{ examId: string; studentId: string }>, start = true): Promise<number> {
    let added = 0;
    await this.mutate((q) => {
      const have = new Set(q.items.map((i) => `${i.examId}/${i.studentId}`));
      const fresh = items
        .filter((i) => !have.has(`${i.examId}/${i.studentId}`))
        .map((i) => ({ ...i, addedAt: this.now().toISOString() }));
      added = fresh.length;
      return { ...q, items: [...q.items, ...fresh], autoRun: start ? true : q.autoRun };
    });
    if (start) this.start();
    return added;
  }

  async remove(examId: string, studentId: string): Promise<void> {
    await this.mutate((q) => ({ ...q, items: q.items.filter((i) => !(i.examId === examId && i.studentId === studentId)) }));
  }

  /** Pause all: stop after the current task of the current student, and switch autoRun off. */
  async pauseAll(): Promise<void> {
    this.stopRequested = true;
    await this.mutate((q) => ({ ...q, autoRun: false }));
    if (this.running) this.runner.requestPause(this.running.examId, this.running.studentId);
  }

  async resumeAll(): Promise<void> {
    await this.mutate((q) => ({ ...q, autoRun: true }));
    this.start();
  }

  /** Called at launch: continue only if the queue was left running (e.g. the app closed or the daily cap hit). */
  async startIfAutoRun(): Promise<void> {
    if ((await this.load()).autoRun) this.start();
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopRequested = false;
    this.loopPromise = this.loop()
      .catch((err) => this.log(`queue loop error: ${(err as Error).message}`))
      .finally(() => {
        this.loopPromise = null;
        this.running = null;
        void this.emitStatus();
      });
  }

  /** Resolves when the loop is idle (used by tests and on app quit). */
  async idle(): Promise<void> {
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    for (;;) {
      const q = await this.load();
      if (!q.autoRun || this.stopRequested) return;
      const item = q.items[0];
      if (!item) {
        await this.mutate((x) => ({ ...x, autoRun: false }));
        return;
      }
      this.running = { examId: item.examId, studentId: item.studentId };
      await this.emitStatus(q);
      let job: JobsFile;
      try {
        job = await this.runner.run(item.examId, item.studentId);
      } catch (err) {
        this.log(`queue: ${item.examId}/${item.studentId} crashed: ${(err as Error).message}`);
        await this.remove(item.examId, item.studentId);
        continue;
      }
      this.running = null;
      if (job.state === 'completed' || job.state === 'failed' || job.state === 'cancelled') {
        await this.remove(item.examId, item.studentId);
        continue;
      }
      if (job.state === 'paused') {
        const keepAuto = job.pauseReason === 'rate_limit_daily' || job.pauseReason === 'app_closed';
        if (!keepAuto) await this.mutate((x) => ({ ...x, autoRun: false }));
        return;
      }
      return; // any other state: stop rather than spin
    }
  }
}
