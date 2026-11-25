/**
 * Composition root: builds every main-process service. It has no Electron imports (the render host
 * is passed in), so integration tests build the same graph with a fake encryptor, a fake renderer,
 * the mock AI provider and a temp folder.
 */
import type { StudentStatus } from '../shared/schemas/student';
import type { JobsFile } from '../shared/schemas/jobs';
import { AppError } from '../shared/errors';
import { FileStore } from './store/file-store';
import { ConfigService } from './store/config-service';
import { SecretStore, type Encryptor } from './store/secret-store';
import { ProfileService } from './store/profile-service';
import { ExamRepo } from './store/exam-repo';
import { StudentIndex } from './store/student-index';
import { ensureLayout } from './store/data-dir';
import { cleanupTempFiles } from './store/atomic-write';
import { JobStore } from './jobs/job-store';
import { JobRunner, type TaskHandlers } from './jobs/job-runner';
import { GlobalQueue } from './jobs/global-queue';
import { AiClient } from './ai/ai-client';
import { UsageLedger } from './ai/usage-ledger';
import { ResponseCache } from './ai/response-cache';
import { createAdapters, type AdapterRegistry } from './ai/providers/index';
import type { Clock } from './ai/rate-limiter';
import { createPipeline } from './ai/pipeline';
import { ExamSourceService } from './ai/exam-source';
import { PageService } from './pages/page-service';
import type { RenderHost } from './pdf/render-host';
import { ReportService } from './report/report-service';

export interface Services {
  store: FileStore;
  config: ConfigService;
  secrets: SecretStore;
  profile: ProfileService;
  exams: ExamRepo;
  index: StudentIndex;
  jobs: JobStore;
  runner: JobRunner;
  queue: GlobalQueue;
  ledger: UsageLedger;
  ai: AiClient;
  pages: PageService;
  sources: ExamSourceService;
  reports: ReportService;
  log: (msg: string) => void;
  /** Re-points every service at a new data folder (after "Change folder" or "Restore"). */
  switchDataDir(dir: string): Promise<void>;
}

/** Student status shown in tables, derived from job state. 'completed' is set by finalize_totals itself. */
export function studentStatusForJob(job: JobsFile): StudentStatus | null {
  switch (job.state) {
    case 'running':
    case 'waiting_rate_limit':
    case 'queued':
      return 'processing';
    case 'paused':
    case 'cancelled':
      return 'paused';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

export async function createServices(opts: {
  dataDir: string;
  encryptor: Encryptor;
  render: RenderHost;
  log?: (msg: string) => void;
  adapters?: AdapterRegistry;
  clock?: Clock;
  /** Tests may replace the pipeline. */
  handlers?: TaskHandlers;
}): Promise<Services> {
  const log = opts.log ?? (() => undefined);
  await ensureLayout(opts.dataDir);
  const removed = await cleanupTempFiles(opts.dataDir);
  if (removed) log(`startup: removed ${removed} stale temp files`);

  const store = new FileStore(opts.dataDir);
  if (!(await store.checkWritable())) throw new AppError('DATA_DIR_UNWRITABLE', opts.dataDir);

  const config = new ConfigService(store);
  const secrets = new SecretStore(store, opts.encryptor);
  const profile = new ProfileService(store);
  const exams = new ExamRepo(store, undefined, log);
  const index = new StudentIndex(store, log);
  const jobs = new JobStore(store, undefined, log);
  const ledger = new UsageLedger(store, opts.clock ? () => opts.clock!.now() : undefined);
  const cache = new ResponseCache(store);
  const ai = new AiClient({ config, secrets, adapters: opts.adapters ?? createAdapters(), ledger, cache, clock: opts.clock, log });
  const runner = new JobRunner(jobs, opts.handlers ?? createPipeline({ store, exams, config, index, jobs, ai }), log);
  const queue = new GlobalQueue(store, runner, undefined, log);
  const pages = new PageService(store, exams, config, jobs, opts.render);
  const sources = new ExamSourceService(store, exams, config, opts.render, ai);
  const reports = new ReportService(store, exams, config, profile, index);

  // Keep student.json status and the search index in step with job state.
  runner.on('state', (job: JobsFile) => {
    const status = studentStatusForJob(job);
    void (async () => {
      try {
        if (status) await exams.setStudentStatus(job.examId, job.studentId, status);
        await index.upsert(job.examId, job.studentId);
      } catch (err) {
        log(`status sync failed: ${(err as Error).message}`);
      }
    })();
  });

  // Order matters: settle crashed jobs before anything can start new work.
  const recovered = await jobs.recoverAll();
  if (recovered.length) log(`startup: ${recovered.length} interrupted job(s) marked paused`);
  await config.get();
  await index.load();

  return {
    store,
    config,
    secrets,
    profile,
    exams,
    index,
    jobs,
    runner,
    queue,
    ledger,
    ai,
    pages,
    sources,
    reports,
    log,
    async switchDataDir(dir: string) {
      await queue.pauseAll();
      await runner.stopAll();
      await ensureLayout(dir);
      store.setRoot(dir);
      config.invalidate();
      secrets.invalidate();
      await jobs.recoverAll();
      await config.get();
      await index.rebuild();
    },
  };
}
