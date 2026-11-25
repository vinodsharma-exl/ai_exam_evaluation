/**
 * IPC contract between the renderer and main. The preload script exposes exactly `window.api: AppApi`
 * through contextBridge. Every method is an ipcRenderer.invoke on the channel of the same name.
 * Events (main → renderer) go through `api.on(event, cb)`.
 *
 * API keys only ever travel renderer → main (saveApiKey). No method returns a key.
 */
import type { ConfigFile, ConnectionTestResult, ModelCapabilities } from './schemas/config';
import type { ProfileFile } from './schemas/profile';
import type { ChoiceRule, ExamFile, Question } from './schemas/exam';
import type { StudentFile } from './schemas/student';
import type { ExtractionFile, ExtractionPage, MergedAnswer } from './schemas/extraction';
import type { EvaluationFile } from './schemas/evaluation';
import type { FinalFile } from './schemas/final';
import type { JobsFile, JobState } from './schemas/jobs';
import type { StudentIndexEntry } from './schemas/index-file';
import type { ModelRef, ProviderId, Stage } from './schemas/common';
import type { ProviderInfo } from './providers/types';
import type { AppErrorData } from './errors';

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorData };

export interface ExtractionProposal {
  questions: Question[];
  choiceRules: ChoiceRule[];
  warnings: string[];
  requestsUsed: number;
  /** How the text was read: typed-PDF text layer (no vision), vision on page images, or pasted text. */
  route: 'text-layer' | 'vision' | 'pasted-text';
}

export interface UsageEstimate {
  requests: number;
  byStage: { ocr: number; evaluation: number };
  minutes: number;
  remainingToday: Record<string, number | null>; // limiterKey → remaining (null = no cap)
  fitsToday: boolean;
  cachedSkips: number;
}

export interface DashboardStats {
  exams: number;
  studentsEvaluated: number;
  inProgress: number;
  needsReview: number;
  finalized: number;
  requestsToday: number;
  recent: Array<{ examId: string; studentId: string; displayId: string; name: string; examTitle: string; status: StudentFile['status']; total: number | null; maxTotal: number; updatedAt: string }>;
}

export interface ClassSummary {
  examId: string;
  rows: Array<{
    studentId: string;
    displayId: string;
    name: string;
    status: StudentFile['status'];
    total: number | null;
    maxTotal: number;
    needsReview: number;
    /** Where the total comes from: professor's final, an edited draft, the AI recommendation, or nothing yet. */
    source: 'final' | 'final_draft' | 'ai' | 'none';
  }>;
  stats: { count: number; average: number | null; highest: number | null; lowest: number | null; distribution: Array<{ bucket: string; count: number }> };
  questionStats: Array<{ number: string; label: string; maxMarks: number; average: number | null; averagePercent: number | null; graded: number }>;
}

/** What the Edit Marks screens send. The server validates and computes everything else. */
export interface FinalInput {
  questions: Array<{ questionNumber: string; finalMarks: number; comment?: string; privateNote?: string; reason?: string }>;
  overallComment?: string;
}

export interface UploadedPagePreview {
  index: number;
  thumbDataUrl: string;
  rotation: 0 | 90 | 180 | 270;
  source: { uploadIndex: number; pageInUpload: number; originalName: string };
}

export interface ProviderStatus {
  info: ProviderInfo;
  hasKey: boolean;
  models: Array<{ id: string; capabilities: ModelCapabilities; userEdited: boolean; lastTest?: ConnectionTestResult }>;
}

/** Profile as the renderer sees it: never the PIN hash or salt. */
export type ProfilePublic = Omit<ProfileFile, 'pin'> & { hasPin: boolean };

export interface AppApi {
  // Bootstrap and profile
  getProfile(): Promise<Result<ProfilePublic | null>>;
  createProfile(p: { name: string; title?: string; department?: string; pin?: string }): Promise<Result<ProfilePublic>>;
  login(pin?: string): Promise<Result<ProfilePublic>>;
  updateProfile(p: { name?: string; title?: string; department?: string }): Promise<Result<ProfilePublic>>;
  changePin(currentPin: string | undefined, newPin: string | undefined): Promise<Result<void>>;

  // Settings
  getConfig(): Promise<Result<ConfigFile>>;
  updateConfig(patch: Partial<ConfigFile>): Promise<Result<ConfigFile>>;
  getProviders(): Promise<Result<ProviderStatus[]>>;
  saveApiKey(providerId: ProviderId, key: string): Promise<Result<{ hasKey: true }>>;
  deleteApiKey(providerId: ProviderId): Promise<Result<{ hasKey: false }>>;
  updateModelCapabilities(ref: ModelRef, caps: Partial<ModelCapabilities>): Promise<Result<ModelCapabilities>>;
  testConnection(ref: ModelRef): Promise<Result<{ text: boolean; vision: boolean | null; latencyMs: number; message: string }>>;
  setStageModel(stage: Stage, ref: ModelRef): Promise<Result<ConfigFile>>;
  acceptPrivacyNotice(): Promise<Result<void>>;
  /** Opens the provider's API-key page in the system browser (catalog URLs only). */
  openProviderKeyPage(providerId: ProviderId): Promise<Result<void>>;

  // Data folder
  getDataDir(): Promise<Result<string>>;
  changeDataDir(opts: { moveExisting: boolean }): Promise<Result<string>>; // shows a folder picker
  openDataDir(subPath?: string): Promise<Result<void>>;
  backupZip(): Promise<Result<string>>; // shows a save dialog, returns the path
  restoreZip(): Promise<Result<void>>; // shows an open dialog, validates, then restores

  // Exams
  listExams(): Promise<Result<ExamFile[]>>;
  listStudents(examId: string): Promise<Result<StudentFile[]>>;
  updateStudent(examId: string, studentId: string, patch: { name?: string; rollNo?: string; section?: string }): Promise<Result<StudentFile>>;
  getExam(examId: string): Promise<Result<ExamFile>>;
  createExam(meta: Pick<ExamFile, 'title' | 'courseCode' | 'subject' | 'className' | 'examDate'>): Promise<Result<ExamFile>>;
  saveExam(exam: ExamFile): Promise<Result<{ exam: ExamFile; problems: string[]; warnings: string[] }>>;
  duplicateExam(examId: string, newTitle: string): Promise<Result<ExamFile>>;
  /** No paths: shows a file picker. */
  attachExamSource(examId: string, doc: 'questionPaper' | 'modelAnswer', filePaths?: string[]): Promise<Result<ExamFile>>;
  /** Returns a PROPOSAL for the editable table. Nothing is saved until saveExam. */
  extractExamSource(examId: string, doc: 'questionPaper' | 'modelAnswer'): Promise<Result<ExtractionProposal>>;
  extractExamSourceFromText(examId: string, doc: 'questionPaper' | 'modelAnswer', text: string): Promise<Result<ExtractionProposal>>;
  getClassSummary(examId: string): Promise<Result<ClassSummary>>;

  // Students and uploads
  createStudent(examId: string, s: { displayId: string; name?: string; rollNo?: string; section?: string }): Promise<Result<StudentFile>>;
  addUploads(examId: string, studentId: string, filePaths?: string[]): Promise<Result<UploadedPagePreview[]>>; // no paths: file picker
  arrangePages(examId: string, studentId: string, order: Array<{ index: number; rotation: 0 | 90 | 180 | 270; deleted?: boolean }>): Promise<Result<UploadedPagePreview[]>>;
  /** Student ID (and optional name) from file names, e.g. "21CS045_Asha Kumar_p2.jpg". No paths: file picker. */
  bulkCreateFromFiles(examId: string, filePaths?: string[]): Promise<Result<StudentFile[]>>;
  /** Manual text for a page (no vision model, or a misread). Lines starting with "Q1", "2(a)" etc. begin answers. */
  setManualPageText(examId: string, studentId: string, pageIndex: number, text: string): Promise<Result<ExtractionPage>>;
  getStudentBundle(examId: string, studentId: string): Promise<Result<{ student: StudentFile; extraction: ExtractionFile | null; evaluation: EvaluationFile | null; final: FinalFile | null; jobs: JobsFile | null }>>;
  getPageImage(examId: string, studentId: string, pageIndex: number): Promise<Result<string>>; // data URL
  getPagePreviews(examId: string, studentId: string): Promise<Result<UploadedPagePreview[]>>;

  // Processing
  estimateUsage(targets: Array<{ examId: string; studentId: string }>): Promise<Result<UsageEstimate>>;
  startProcessing(examId: string, studentId: string): Promise<Result<JobsFile>>;
  enqueueAll(examId: string, studentIds?: string[]): Promise<Result<{ queued: number }>>;
  pause(examId?: string, studentId?: string): Promise<Result<void>>; // no args: pause the global queue
  resume(examId?: string, studentId?: string): Promise<Result<void>>;
  cancel(examId: string, studentId: string): Promise<Result<void>>;
  getQueueStatus(): Promise<Result<AppEvents['queue:update']>>;
  rerunOcrPage(examId: string, studentId: string, pageIndex: number): Promise<Result<void>>;
  /** One request per question; bypasses the cache. Several questions are queued together. */
  reevaluateQuestion(examId: string, studentId: string, questionNumber: string | string[]): Promise<Result<void>>;

  // Review and finalize
  saveAnswerText(examId: string, studentId: string, questionNumber: string, text: string): Promise<Result<MergedAnswer>>;
  /** Saved final marks, or a draft built from the AI recommendations (not saved). */
  getFinalDraft(examId: string, studentId: string): Promise<Result<FinalFile>>;
  saveFinal(examId: string, studentId: string, input: FinalInput, finalize: boolean): Promise<Result<FinalFile>>;

  // Reports
  /** Returns the data-folder-relative path of report.pdf. */
  generateStudentReport(examId: string, studentId: string): Promise<Result<string>>;
  /** Returns the data-folder-relative path of class_sheet.xlsx. */
  generateClassSheet(examId: string): Promise<Result<string>>;
  generateAllReports(examId: string): Promise<Result<{ count: number; skipped: string[] }>>;
  openPath(relativePath: string): Promise<Result<void>>;
  /** Shows the file in Explorer (selected). */
  showInFolder(relativePath: string): Promise<Result<void>>;
  /** "Save a copy…" dialog; returns the chosen path, or null if cancelled. */
  saveCopyAs(relativePath: string): Promise<Result<string | null>>;
  /** Logo for report headers: file picker (PNG/JPG), copied into the data folder. */
  chooseInstitutionLogo(): Promise<Result<ConfigFile>>;
  clearInstitutionLogo(): Promise<Result<ConfigFile>>;

  // Search and dashboard
  searchStudents(query: string): Promise<Result<StudentIndexEntry[]>>;
  getDashboard(): Promise<Result<DashboardStats>>;
  rebuildIndex(): Promise<Result<{ students: number }>>;

  listModels(providerId: ProviderId): Promise<Result<string[]>>;
  /** Today's usage for the two models currently chosen for OCR and evaluation. */
  getUsageSummary(): Promise<Result<{ ocr: AppEvents['usage:update']; evaluation: AppEvents['usage:update'] }>>;

  on<E extends keyof AppEvents>(event: E, cb: (payload: AppEvents[E]) => void): () => void;
  /** Preload-only (not IPC): absolute path of a dropped File, for drag and drop uploads. */
  pathForFile(file: File): string;
}

export interface AppEvents {
  'job:progress': {
    examId: string;
    studentId: string;
    state: JobState;
    done: number;
    total: number;
    currentTaskId: string | null;
    currentLabel: string; // "Reading pages 4-6", "Evaluating Q3, Q4"
    resumeAt: number | null; // countdown for waiting_rate_limit
    error: AppErrorData | null;
  };
  'usage:update': { key: string; usedToday: number; dailyLimit: number | null; rpm: number };
  'queue:update': { pending: number; running: { examId: string; studentId: string } | null; autoRun: boolean };
  'config:changed': ConfigFile;
}

export const IPC_CHANNELS = [
  'getProfile', 'createProfile', 'login', 'updateProfile', 'changePin',
  'getConfig', 'updateConfig', 'getProviders', 'saveApiKey', 'deleteApiKey', 'updateModelCapabilities',
  'testConnection', 'setStageModel', 'acceptPrivacyNotice', 'openProviderKeyPage',
  'getDataDir', 'changeDataDir', 'openDataDir', 'backupZip', 'restoreZip',
  'listExams', 'listStudents', 'updateStudent', 'getExam', 'createExam', 'saveExam', 'duplicateExam', 'attachExamSource', 'extractExamSource', 'extractExamSourceFromText', 'getClassSummary',
  'createStudent', 'addUploads', 'arrangePages', 'bulkCreateFromFiles', 'setManualPageText', 'getStudentBundle', 'getPageImage', 'getPagePreviews',
  'estimateUsage', 'startProcessing', 'enqueueAll', 'pause', 'resume', 'cancel', 'getQueueStatus', 'rerunOcrPage', 'reevaluateQuestion',
  'saveAnswerText', 'getFinalDraft', 'saveFinal',
  'generateStudentReport', 'generateClassSheet', 'generateAllReports', 'openPath', 'showInFolder', 'saveCopyAs',
  'chooseInstitutionLogo', 'clearInstitutionLogo',
  'searchStudents', 'getDashboard', 'rebuildIndex',
  'listModels', 'getUsageSummary',
] as const satisfies ReadonlyArray<Exclude<keyof AppApi, 'on' | 'pathForFile'>>;
