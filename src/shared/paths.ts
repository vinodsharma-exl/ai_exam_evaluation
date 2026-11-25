/**
 * The data folder layout as code. All functions return paths RELATIVE to the data dir, using '/'.
 * The main process joins them with the absolute data dir (path.join converts separators).
 * Nothing else in the codebase should build these strings by hand.
 */
import { ID_PATTERN, WINDOWS_RESERVED_NAMES } from './constants';

export const ROOT_FILES = {
  config: 'config.json',
  secrets: 'secrets.bin',
  profile: 'profile.json',
  usage: 'usage.json',
  globalQueue: 'queue.json',
  studentIndex: 'index/students.json',
} as const;

export const DIRS = {
  exams: 'exams',
  cache: 'cache',
  index: 'index',
  backups: 'backups',
} as const;

export const cacheEntryPath = (hash: string) => `${DIRS.cache}/${hash.slice(0, 2)}/${hash}.json`;

export const examDir = (examId: string) => `${DIRS.exams}/${assertId(examId)}`;
export const examFile = (examId: string) => `${examDir(examId)}/exam.json`;
export const examSourceDir = (examId: string) => `${examDir(examId)}/source`;
export const questionPaperPdf = (examId: string) => `${examSourceDir(examId)}/question_paper.pdf`;
export const modelAnswerPdf = (examId: string) => `${examSourceDir(examId)}/model_answer.pdf`;
export const sourceExtractionFile = (examId: string) => `${examSourceDir(examId)}/extraction.json`;
export const sourcePageImage = (examId: string, doc: 'qp' | 'ma', pageIndex: number) =>
  `${examSourceDir(examId)}/pages/${doc}_p${pad3(pageIndex + 1)}.jpg`;

export const studentsDir = (examId: string) => `${examDir(examId)}/students`;
export const studentDir = (examId: string, studentId: string) => `${studentsDir(examId)}/${assertId(studentId)}`;
export const studentFile = (e: string, s: string) => `${studentDir(e, s)}/student.json`;
export const submissionPdf = (e: string, s: string) => `${studentDir(e, s)}/submission.pdf`;
export const pagesDir = (e: string, s: string) => `${studentDir(e, s)}/pages`;
/** pageIndex is 0-based. The file name is 1-based (p001.jpg). */
export const pageImage = (e: string, s: string, pageIndex: number) => `${pagesDir(e, s)}/p${pad3(pageIndex + 1)}.jpg`;
export const pageThumb = (e: string, s: string, pageIndex: number) => `${pagesDir(e, s)}/thumbs/p${pad3(pageIndex + 1)}.jpg`;
/** Original uploaded files, kept so pages can be re-rendered (rotation, quality). uploadIndex is 0-based. */
export const uploadFile = (e: string, s: string, uploadIndex: number, ext: string) =>
  `${studentDir(e, s)}/uploads/u${pad3(uploadIndex + 1)}.${ext}`;
export const sourceUploadFile = (examId: string, doc: 'qp' | 'ma', uploadIndex: number, ext: string) =>
  `${examSourceDir(examId)}/uploads/${doc}_u${pad3(uploadIndex + 1)}.${ext}`;
export const extractionFile = (e: string, s: string) => `${studentDir(e, s)}/extraction.json`;
export const evaluationFile = (e: string, s: string) => `${studentDir(e, s)}/evaluation.json`;
export const finalFile = (e: string, s: string) => `${studentDir(e, s)}/final.json`;
export const reportPdf = (e: string, s: string) => `${studentDir(e, s)}/report.pdf`;
export const jobsFile = (e: string, s: string) => `${studentDir(e, s)}/jobs.json`;
export const classSheetXlsx = (examId: string) => `${examDir(examId)}/class_sheet.xlsx`;

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

export function isSafeId(id: string): boolean {
  if (!ID_PATTERN.test(id)) return false;
  if (id === '.' || id === '..' || id.endsWith('.')) return false;
  const stem = id.split('.')[0]!.toUpperCase();
  return !WINDOWS_RESERVED_NAMES.has(stem);
}

function assertId(id: string): string {
  if (!isSafeId(id)) throw new Error(`Unsafe id for a folder name: ${JSON.stringify(id)}`);
  return id;
}

/**
 * Turns any student ID or exam title into a safe folder ID, e.g. "21/CS/045" becomes "21-CS-045".
 * Keep the original text as displayId. Collisions are resolved by the caller with a numeric suffix.
 */
export function toSafeId(raw: string): string {
  let id = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  if (!id) id = 'id';
  if (!isSafeId(id)) id = `_${id}`.slice(0, 64);
  return id;
}
