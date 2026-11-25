/**
 * IPC handlers. Every handler:
 *   - checks the sender is our own window (no other frame can call in)
 *   - requires login except for the profile/bootstrap channels
 *   - returns Result<T> and never throws across IPC; errors are AppErrorData with keys redacted
 *
 * Methods that belong to later phases return NOT_IMPLEMENTED until then.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { IPC_CHANNELS, type AppApi, type ClassSummary, type DashboardStats, type ProviderStatus, type Result } from '../shared/ipc';
import { AppError, redactSecrets } from '../shared/errors';
import { ProviderId, type ModelRef, Stage } from '../shared/schemas/common';
import type { ConfigFile } from '../shared/schemas/config';
import { PROVIDER_CATALOG } from '../shared/providers/catalog';
import { resolveCapabilities } from '../shared/defaults';
import * as P from '../shared/paths';
import type { Services } from './services';
import { ProfileService } from './store/profile-service';
import { switchDataDir as switchDir, type DataDirPaths } from './store/data-dir';
import { createBackup, restoreBackup } from './store/backup';
import { estimateUsage } from './ai/estimator';
import { quotaDay } from './ai/usage-ledger';
import { groupFilesByStudent } from './pages/page-service';
import { addRerunTasks } from './jobs/job-logic';
import { newTask } from './jobs/job-planner';
import { promises as fs } from 'node:fs';

type Impl = { [K in Exclude<keyof AppApi, 'on' | 'pathForFile'>]: (...args: Parameters<AppApi[K]>) => Promise<unknown> };

const PUBLIC: ReadonlySet<string> = new Set(['getProfile', 'createProfile', 'login']);

export interface IpcDeps {
  services: Services;
  paths: DataDirPaths;
  getWindow: () => BrowserWindow | null;
  isTrustedUrl: (url: string) => boolean;
}

function assertProvider(id: unknown): ProviderId {
  const r = ProviderId.safeParse(id);
  if (!r.success) throw new AppError('VALIDATION', 'Unknown provider');
  return r.data;
}
function assertModelRef(ref: unknown): ModelRef {
  const r = ref as ModelRef;
  assertProvider(r?.providerId);
  if (typeof r.model !== 'string' || !r.model.trim() || r.model.length > 200) throw new AppError('VALIDATION', 'Invalid model id');
  return { providerId: r.providerId, model: r.model.trim() };
}
function assertIds(...ids: unknown[]): void {
  for (const id of ids) if (typeof id !== 'string' || !P.isSafeId(id)) throw new AppError('VALIDATION', 'Invalid id');
}
function assertDoc(doc: unknown): 'questionPaper' | 'modelAnswer' {
  if (doc !== 'questionPaper' && doc !== 'modelAnswer') throw new AppError('VALIDATION', 'Unknown document');
  return doc;
}
const UPLOAD_EXT = /\.(pdf|jpe?g|png|heic|heif)$/i;
/** Paths from drag and drop: must be existing files with a supported extension. */
async function checkFiles(paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > 500) throw new AppError('VALIDATION', 'Invalid file list');
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !UPLOAD_EXT.test(p)) throw new AppError('UNSUPPORTED_FILE', typeof p === 'string' ? p : '');
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isFile()) throw new AppError('NOT_FOUND', p);
    out.push(p);
  }
  return out;
}
async function pickFiles(win: BrowserWindow | undefined, title: string, multi: boolean): Promise<string[]> {
  const opts: Electron.OpenDialogOptions = {
    title,
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'PDF or photos', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled ? [] : res.filePaths;
}

export function buildImpl(deps: IpcDeps): Impl {
  const { services: s, paths } = deps;
  const win = () => deps.getWindow() ?? undefined;
  const assertNotRunning = (e: string, st: string) => {
    if (s.runner.isRunning(e, st)) throw new AppError('VALIDATION', 'This student is being processed. Pause first, then make changes.');
  };

  const impl: Impl = {
    // ------------------------------------------------------------ profile
    getProfile: async () => {
      const p = await s.profile.get();
      return p ? ProfileService.publicView(p) : null;
    },
    createProfile: async (p) => ProfileService.publicView(await s.profile.create(p)),
    login: async (pin) => ProfileService.publicView(await s.profile.login(pin)),
    updateProfile: async (p) => ProfileService.publicView(await s.profile.update(p)),
    changePin: async (cur, next) => s.profile.changePin(cur, next),

    // ------------------------------------------------------------ settings
    getConfig: () => s.config.get(),
    updateConfig: (patch) => s.config.update(patch),
    getProviders: async (): Promise<ProviderStatus[]> => {
      const cfg = await s.config.get();
      const withKeys = new Set(await s.secrets.listProvidersWithKeys());
      return Object.values(PROVIDER_CATALOG).map((info) => {
        const userModels = cfg.providers[info.id]?.models ?? {};
        const ids = [...new Set([...info.presets.map((p) => p.id), ...Object.keys(userModels)])];
        return {
          info,
          hasKey: info.id === 'mock' || withKeys.has(info.id),
          models: ids.map((id) => ({
            id,
            capabilities: resolveCapabilities(cfg, { providerId: info.id, model: id }),
            userEdited: userModels[id]?.userEdited ?? false,
            lastTest: userModels[id]?.lastTest,
          })),
        };
      });
    },
    saveApiKey: async (providerId, key) => {
      const id = assertProvider(providerId);
      if (typeof key !== 'string') throw new AppError('VALIDATION', 'Key must be text');
      await s.secrets.setKey(id, key);
      s.log(`api key saved for ${id}`); // never the key itself
      return { hasKey: true as const };
    },
    deleteApiKey: async (providerId) => {
      const id = assertProvider(providerId);
      await s.secrets.deleteKey(id);
      s.log(`api key removed for ${id}`);
      return { hasKey: false as const };
    },
    updateModelCapabilities: async (ref, caps) => s.config.updateModelCapabilities(assertModelRef(ref), caps),
    testConnection: async (ref) => s.ai.testConnection(assertModelRef(ref), new AbortController().signal),
    listModels: async (providerId) => s.ai.listModels(assertProvider(providerId), new AbortController().signal),
    getUsageSummary: async () => {
      const cfg = await s.config.get();
      const [ocr, evaluation] = await Promise.all([s.ai.usageSnapshot(cfg.stages.ocr), s.ai.usageSnapshot(cfg.stages.evaluation)]);
      return { ocr, evaluation };
    },
    setStageModel: async (stage, ref) => {
      const st = Stage.parse(stage);
      return s.config.setStageModel(st, assertModelRef(ref));
    },
    acceptPrivacyNotice: async () => {
      await s.config.update({ privacyNoticeAcceptedAt: new Date().toISOString() } satisfies Partial<ConfigFile>);
    },
    openProviderKeyPage: async (providerId) => {
      const url = PROVIDER_CATALOG[assertProvider(providerId)].keyUrl;
      if (url) await shell.openExternal(url);
    },

    // ------------------------------------------------------------ data folder
    getDataDir: async () => s.store.dataDir,
    changeDataDir: async ({ moveExisting }) => {
      const res = await dialog.showOpenDialog(win()!, {
        title: 'Choose a folder for AnswerEval AI data',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths[0]) return s.store.dataDir;
      const from = s.store.dataDir;
      await s.queue.pauseAll();
      await s.runner.stopAll();
      const to = await switchDir(paths, from, res.filePaths[0], moveExisting);
      await s.switchDataDir(to);
      return to;
    },
    openDataDir: async (sub) => {
      const target = sub ? s.store.abs(sub) : s.store.dataDir;
      const err = await shell.openPath(target);
      if (err) throw new AppError('NOT_FOUND', err);
    },
    backupZip: async () => {
      const stamp = new Date().toISOString().slice(0, 10);
      const res = await dialog.showSaveDialog(win()!, {
        title: 'Save backup',
        defaultPath: join(s.store.abs(P.DIRS.backups), `AnswerEvalAI-backup-${stamp}.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (res.canceled || !res.filePath) throw new AppError('CANCELLED');
      await createBackup(s.store.dataDir, res.filePath, app.getVersion());
      return res.filePath;
    },
    restoreZip: async () => {
      const res = await dialog.showOpenDialog(win()!, {
        title: 'Restore from backup',
        properties: ['openFile'],
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (res.canceled || !res.filePaths[0]) throw new AppError('CANCELLED');
      await s.queue.pauseAll();
      await s.runner.stopAll();
      const { previousCopy } = await restoreBackup(res.filePaths[0], s.store.dataDir);
      s.log(`restored backup; previous data kept at ${previousCopy}`);
      await s.switchDataDir(s.store.dataDir);
    },

    // ------------------------------------------------------------ exams and students
    listExams: () => s.exams.listExams(),
    listStudents: async (examId) => {
      assertIds(examId);
      return s.exams.listStudents(examId);
    },
    updateStudent: async (examId, studentId, patch) => {
      assertIds(examId, studentId);
      const st = await s.exams.updateStudent(examId, studentId, {
        name: patch.name,
        rollNo: patch.rollNo,
        section: patch.section,
      });
      await s.index.upsert(examId, studentId);
      return st;
    },
    getExam: async (examId) => {
      assertIds(examId);
      return s.exams.getExam(examId);
    },
    createExam: (meta) => s.exams.createExam(meta),
    saveExam: async (exam) => {
      assertIds(exam?.id);
      const out = await s.exams.saveExam(exam);
      // Exam title or total changes show up in the search index.
      for (const st of await s.exams.listStudents(exam.id)) await s.index.upsert(exam.id, st.id);
      return out;
    },
    duplicateExam: async (examId, title) => {
      assertIds(examId);
      return s.exams.duplicateExam(examId, title);
    },
    attachExamSource: async (examId, doc, filePaths) => {
      assertIds(examId);
      const d = assertDoc(doc);
      const paths = filePaths?.length ? await checkFiles(filePaths) : await pickFiles(win(), 'Choose the question paper or model answer', true);
      if (paths.length === 0) throw new AppError('CANCELLED');
      return s.sources.attach(examId, d, paths);
    },
    extractExamSource: async (examId, doc) => {
      assertIds(examId);
      return s.sources.extract(examId, assertDoc(doc), { signal: new AbortController().signal });
    },
    extractExamSourceFromText: async (examId, doc, text) => {
      assertIds(examId);
      if (typeof text !== 'string' || !text.trim()) throw new AppError('VALIDATION', 'Paste or type the text first.');
      return s.sources.extract(examId, assertDoc(doc), { signal: new AbortController().signal, pastedText: text.slice(0, 200_000) });
    },
    getClassSummary: async (examId): Promise<ClassSummary> => {
      assertIds(examId);
      // Same rules as the Excel sheet: professor's marks when present, else the AI recommendation.
      return (await s.reports.classData(examId)).summary;
    },
    createStudent: async (examId, input) => {
      assertIds(examId);
      const st = await s.exams.createStudent(examId, input);
      await s.index.upsert(examId, st.id);
      return st;
    },
    addUploads: async (examId, studentId, filePaths) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      const paths = filePaths?.length ? await checkFiles(filePaths) : await pickFiles(win(), 'Add answer sheet pages', true);
      if (paths.length === 0) return s.pages.previews(examId, studentId);
      const out = await s.pages.addUploads(examId, studentId, paths);
      await s.index.upsert(examId, studentId);
      return out;
    },
    arrangePages: async (examId, studentId, order) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      if (!Array.isArray(order)) throw new AppError('VALIDATION', 'Invalid page order');
      for (const o of order) if (![0, 90, 180, 270].includes(o.rotation) || !Number.isInteger(o.index)) throw new AppError('VALIDATION', 'Invalid page order');
      return s.pages.arrangePages(examId, studentId, order);
    },
    bulkCreateFromFiles: async (examId, filePaths) => {
      assertIds(examId);
      const paths = filePaths?.length ? await checkFiles(filePaths) : await pickFiles(win(), 'Choose answer sheets for many students', true);
      const created = [];
      for (const g of groupFilesByStudent(paths)) {
        const existing = (await s.exams.listStudents(examId)).find((x) => x.displayId.toLowerCase() === g.displayId.toLowerCase());
        const st = existing ?? (await s.exams.createStudent(examId, { displayId: g.displayId, name: g.name }));
        if (s.runner.isRunning(examId, st.id)) continue;
        await s.pages.addUploads(examId, st.id, g.files);
        await s.index.upsert(examId, st.id);
        created.push(await s.exams.getStudent(examId, st.id));
      }
      return created;
    },
    setManualPageText: async (examId, studentId, pageIndex, text) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      if (!Number.isInteger(pageIndex) || typeof text !== 'string') throw new AppError('VALIDATION', 'Invalid input');
      return s.pages.setManualPageText(examId, studentId, pageIndex, text.slice(0, 40_000));
    },
    getStudentBundle: async (examId, studentId) => {
      assertIds(examId, studentId);
      return s.exams.getStudentBundle(examId, studentId);
    },
    getPagePreviews: async (examId, studentId) => {
      assertIds(examId, studentId);
      return s.pages.previews(examId, studentId);
    },
    getPageImage: async (examId, studentId, pageIndex) => {
      assertIds(examId, studentId);
      if (!Number.isInteger(pageIndex) || pageIndex < 0) throw new AppError('VALIDATION', 'Invalid page');
      const buf = await s.store.readBytes(P.pageImage(examId, studentId, pageIndex)).catch(() => {
        throw new AppError('NOT_FOUND', `Page ${pageIndex + 1}`);
      });
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    },

    // ------------------------------------------------------------ processing
    estimateUsage: async (targets) => {
      if (!Array.isArray(targets)) throw new AppError('VALIDATION', 'Invalid targets');
      for (const t of targets) assertIds(t.examId, t.studentId);
      return estimateUsage({ store: s.store, exams: s.exams, config: s.config, ledger: s.ledger }, targets);
    },
    startProcessing: async (examId, studentId) => {
      assertIds(examId, studentId);
      const exam = await s.exams.getExam(examId);
      if (exam.status !== 'ready') throw new AppError('EXAM_NOT_READY');
      await s.jobs.getOrCreate(examId, studentId);
      void s.runner.run(examId, studentId); // progress arrives through events
      return s.jobs.require(examId, studentId);
    },
    enqueueAll: async (examId, studentIds) => {
      assertIds(examId);
      const exam = await s.exams.getExam(examId);
      if (exam.status !== 'ready') throw new AppError('EXAM_NOT_READY');
      const students = await s.exams.listStudents(examId);
      const targets = students
        .filter((st) => st.uploads.length > 0 && (studentIds ? studentIds.includes(st.id) : st.status !== 'finalized'))
        .map((st) => ({ examId, studentId: st.id }));
      for (const t of targets) await s.jobs.getOrCreate(t.examId, t.studentId);
      return { queued: await s.queue.enqueue(targets) };
    },
    pause: async (examId, studentId) => {
      if (examId && studentId) {
        assertIds(examId, studentId);
        s.runner.requestPause(examId, studentId);
      } else await s.queue.pauseAll();
    },
    resume: async (examId, studentId) => {
      if (examId && studentId) {
        assertIds(examId, studentId);
        void s.runner.run(examId, studentId);
      } else await s.queue.resumeAll();
    },
    cancel: async (examId, studentId) => {
      assertIds(examId, studentId);
      s.runner.cancel(examId, studentId);
      await s.queue.remove(examId, studentId);
    },
    getQueueStatus: () => s.queue.status(),
    rerunOcrPage: async (examId, studentId, pageIndex) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      const stamp = Date.now().toString(36);
      await s.store.update('extraction', P.extractionFile(examId, studentId), (cur) => {
        if (!cur?.pages[pageIndex]) throw new AppError('NOT_FOUND', `Page ${pageIndex + 1}`);
        return {
          ...cur,
          pages: cur.pages.map((p) => (p.index === pageIndex ? { ...p, fragments: [], pageNote: '', ocr: { ...p.ocr, status: 'pending' as const, error: null } } : p)),
          updatedAt: new Date().toISOString(),
        };
      });
      const cfg = await s.config.get();
      await s.jobs.getOrCreate(examId, studentId);
      await s.jobs.mutate(examId, studentId, (j) =>
        addRerunTasks(
          j,
          [
            newTask({ id: `ocr:${pageIndex + 1}#rerun-${stamp}`, kind: 'ocr_pages', pages: [pageIndex], model: cfg.stages.ocr, reason: 'rerun', bypassCache: true }),
            newTask({ id: `merge#rerun-${stamp}`, kind: 'merge_answers', reason: 'rerun' }),
          ],
          new Date().toISOString(),
        ),
      );
      void s.runner.run(examId, studentId);
    },
    reevaluateQuestion: async (examId, studentId, questionNumber) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      const exam = await s.exams.getExam(examId);
      const numbers = Array.isArray(questionNumber) ? questionNumber : [questionNumber];
      for (const n of numbers) if (!exam.questions.some((q) => q.number === n)) throw new AppError('NOT_FOUND', `Question ${n}`);
      const cfg = await s.config.get();
      const stamp = Date.now().toString(36);
      await s.jobs.getOrCreate(examId, studentId);
      await s.jobs.mutate(examId, studentId, (j) =>
        addRerunTasks(
          j,
          numbers.map((n) => newTask({ id: `eval:${n}#reeval-${stamp}`, kind: 'evaluate_questions', questions: [n], model: cfg.stages.evaluation, reason: 'reevaluate', bypassCache: true })),
          new Date().toISOString(),
        ),
      );
      void s.runner.run(examId, studentId);
    },

    // ------------------------------------------------------------ review / reports (Phase 5)
    saveAnswerText: async (examId, studentId, questionNumber, text) => {
      assertIds(examId, studentId);
      assertNotRunning(examId, studentId);
      if (typeof text !== 'string') throw new AppError('VALIDATION', 'Invalid text');
      return s.pages.saveAnswerText(examId, studentId, questionNumber, text);
    },
    getFinalDraft: async (examId, studentId) => {
      assertIds(examId, studentId);
      return s.reports.getFinalDraft(examId, studentId);
    },
    saveFinal: async (examId, studentId, input, finalize) => {
      assertIds(examId, studentId);
      if (!input || !Array.isArray(input.questions)) throw new AppError('VALIDATION', 'Invalid marks');
      for (const q of input.questions) {
        if (typeof q.questionNumber !== 'string' || typeof q.finalMarks !== 'number') throw new AppError('VALIDATION', 'Invalid marks');
      }
      return s.reports.saveFinal(examId, studentId, input, finalize === true);
    },
    generateStudentReport: async (examId, studentId) => {
      assertIds(examId, studentId);
      return s.reports.studentReport(examId, studentId);
    },
    generateClassSheet: async (examId) => {
      assertIds(examId);
      return s.reports.classSheet(examId);
    },
    generateAllReports: async (examId) => {
      assertIds(examId);
      return s.reports.allStudentReports(examId);
    },
    openPath: async (rel) => {
      const err = await shell.openPath(s.store.abs(rel));
      if (err) throw new AppError('NOT_FOUND', err);
    },
    showInFolder: async (rel) => {
      const abs = s.store.abs(rel);
      if (!(await s.store.exists(rel))) throw new AppError('NOT_FOUND', rel);
      shell.showItemInFolder(abs);
    },
    saveCopyAs: async (rel) => {
      if (!(await s.store.exists(rel))) throw new AppError('NOT_FOUND', rel);
      const name = rel.split('/').pop()!;
      const ext = name.split('.').pop()!;
      const opts: Electron.SaveDialogOptions = {
        title: 'Save a copy',
        defaultPath: join(app.getPath('documents'), name),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      };
      const w = win();
      const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      await fs.copyFile(s.store.abs(rel), res.filePath);
      return res.filePath;
    },
    chooseInstitutionLogo: async () => {
      const w = win();
      const opts: Electron.OpenDialogOptions = { title: 'Choose a logo for reports', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] };
      const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths[0]) return s.config.get();
      const src = res.filePaths[0];
      const st = await fs.stat(src);
      if (st.size > 2 * 1024 * 1024) throw new AppError('VALIDATION', 'Please choose an image under 2 MB.');
      const ext = /\.png$/i.test(src) ? 'png' : 'jpg';
      const rel = `branding/logo.${ext}`;
      await s.store.importFile(src, rel);
      return s.config.update({ institution: { logoFile: rel } });
    },
    clearInstitutionLogo: async () => s.config.update({ institution: { logoFile: null } }),

    // ------------------------------------------------------------ search and dashboard
    searchStudents: async (q) => s.index.search(typeof q === 'string' ? q.slice(0, 100) : ''),
    getDashboard: async (): Promise<DashboardStats> => {
      const [idx, exams, usage] = await Promise.all([
        s.index.load(),
        s.exams.listExams(),
        s.store.read('usage', P.ROOT_FILES.usage).catch(() => null),
      ]);
      const refs = idx.students.flatMap((e) => e.exams.map((x) => ({ e, x })));
      // Each provider's "today" is its own quota day (Gemini resets at midnight Pacific).
      const requestsToday = usage
        ? Object.entries(usage.byModel).reduce((sum, [key, days]) => {
            const pid = ProviderId.safeParse(key.split(':')[0]);
            return sum + (pid.success ? (days[quotaDay(pid.data)]?.requests ?? 0) : 0);
          }, 0)
        : 0;
      return {
        exams: exams.length,
        studentsEvaluated: refs.filter(({ x }) => ['evaluated', 'needs_review', 'finalized'].includes(x.status)).length,
        inProgress: refs.filter(({ x }) => x.status === 'processing' || x.status === 'paused').length,
        needsReview: refs.filter(({ x }) => x.status === 'needs_review').length,
        finalized: refs.filter(({ x }) => x.status === 'finalized').length,
        requestsToday,
        recent: refs
          .sort((a, b) => b.x.updatedAt.localeCompare(a.x.updatedAt))
          .slice(0, 8)
          .map(({ e, x }) => ({
            examId: x.examId,
            studentId: x.studentId,
            displayId: e.displayId,
            name: e.name,
            examTitle: x.examTitle,
            status: x.status,
            total: x.total,
            maxTotal: x.maxTotal,
            updatedAt: x.updatedAt,
          })),
      };
    },
    rebuildIndex: async () => ({ students: (await s.index.rebuild()).students.length }),
  };
  return impl;
}

function toResult(err: unknown): Result<never> {
  if (err instanceof AppError) return { ok: false, error: err.toData() };
  return {
    ok: false,
    error: { code: 'UNKNOWN', detail: redactSecrets(String((err as Error)?.message ?? err)).slice(0, 500), at: new Date().toISOString() },
  };
}

export function registerIpc(deps: IpcDeps): void {
  const impl = buildImpl(deps);
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const url = event.senderFrame?.url ?? '';
        if (!deps.isTrustedUrl(url)) throw new AppError('VALIDATION', 'Untrusted sender');
        if (!PUBLIC.has(channel) && !deps.services.profile.isLoggedIn) throw new AppError('NOT_SIGNED_IN');
        const fn = impl[channel] as (...a: unknown[]) => Promise<unknown>;
        const data = await fn(...args);
        return { ok: true, data } satisfies Result<unknown>;
      } catch (err) {
        if (!(err instanceof AppError && ['CANCELLED', 'PIN_INCORRECT', 'NOT_SIGNED_IN'].includes(err.code))) {
          deps.services.log(`ipc ${channel} failed: ${(err as Error)?.message ?? err}`);
        }
        return toResult(err);
      }
    });
  }

  // Forward main-process events to the window.
  const send = (event: string, payload: unknown) => deps.getWindow()?.webContents.send('app-event', event, payload);
  deps.services.runner.on('progress', (p) => send('job:progress', p));
  deps.services.queue.on('update', (q) => send('queue:update', q));
  deps.services.config.on('changed', (c) => send('config:changed', c));
  deps.services.ai.on('usage', (u) => send('usage:update', u));
}
