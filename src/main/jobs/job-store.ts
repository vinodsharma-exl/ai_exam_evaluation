/**
 * jobs.json persistence for each student. All changes go through FileStore.update (per-file mutex + atomic write).
 */
import type { JobsFile, Task } from '../../shared/schemas/jobs';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from '../store/file-store';
import { recoverJob } from './job-logic';
import { planInitialTasks } from './job-planner';

export class JobStore {
  constructor(
    private readonly store: FileStore,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  iso(): string {
    return this.now().toISOString();
  }

  get(examId: string, studentId: string): Promise<JobsFile | null> {
    return this.store.read('jobs', P.jobsFile(examId, studentId));
  }

  async require(examId: string, studentId: string): Promise<JobsFile> {
    const j = await this.get(examId, studentId);
    if (!j) throw new AppError('NOT_FOUND', `No job for ${examId}/${studentId}`);
    return j;
  }

  /** Applies a pure transform under the file lock. Returns the saved job. */
  async mutate(examId: string, studentId: string, fn: (job: JobsFile) => JobsFile): Promise<JobsFile> {
    const out = await this.store.update('jobs', P.jobsFile(examId, studentId), (cur) => {
      if (!cur) throw new AppError('NOT_FOUND', `No job for ${examId}/${studentId}`);
      return fn(cur);
    });
    return out!;
  }

  /** Creates a fresh plan. Any existing job is replaced, so call this only for a new or reset submission. */
  async create(examId: string, studentId: string, tasks: Task[] = planInitialTasks()): Promise<JobsFile> {
    const now = this.iso();
    const job: JobsFile = {
      schemaVersion: SCHEMA_VERSIONS.jobs,
      examId,
      studentId,
      state: 'idle',
      pauseReason: null,
      resumeAt: null,
      tasks,
      estimate: null,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.write('jobs', P.jobsFile(examId, studentId), job);
  }

  /** Returns the existing job, or creates the initial plan. */
  async getOrCreate(examId: string, studentId: string): Promise<JobsFile> {
    return (await this.get(examId, studentId)) ?? this.create(examId, studentId);
  }

  /**
   * Run once at app start, before anything else touches jobs: jobs that were running when the app closed
   * become paused('app_closed') and their running tasks become pending again.
   */
  async recoverAll(): Promise<Array<{ examId: string; studentId: string }>> {
    const recovered: Array<{ examId: string; studentId: string }> = [];
    for (const examId of await this.store.listDirs(P.DIRS.exams)) {
      if (!P.isSafeId(examId)) continue;
      for (const studentId of await this.store.listDirs(P.studentsDir(examId))) {
        if (!P.isSafeId(studentId)) continue;
        try {
          const rel = P.jobsFile(examId, studentId);
          let changed = false;
          await this.store.update('jobs', rel, (cur) => {
            if (!cur) return undefined;
            const r = recoverJob(cur, this.iso());
            changed = r !== null;
            return r ?? undefined;
          });
          if (changed) recovered.push({ examId, studentId });
        } catch (err) {
          this.log(`recoverAll: ${examId}/${studentId}: ${(err as Error).message}`);
        }
      }
    }
    return recovered;
  }
}
