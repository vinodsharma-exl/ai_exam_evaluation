/** App-wide constants shared by main and renderer. Pure data, no Node imports. */

export const APP_NAME = 'AnswerEval AI';
export const DEFAULT_DATA_DIR_NAME = 'AnswerEvalAI';

/** Bump a file's version when its shape changes, and add a migration in main/store/migrations.ts. */
export const SCHEMA_VERSIONS = {
  config: 1,
  secrets: 1,
  profile: 1,
  usage: 1,
  globalQueue: 1,
  cacheEntry: 1,
  studentIndex: 1,
  exam: 1,
  sourceExtraction: 1,
  student: 1,
  extraction: 1,
  evaluation: 1,
  final: 1,
  jobs: 1,
} as const;

/** Part of every cache key. Bump it when any prompt template changes. */
export const PROMPT_VERSION = 'p1.0';

export const LOW_CONFIDENCE_THRESHOLD_DEFAULT = 0.6;

export const IMAGE_QUALITY_PRESETS = {
  low: { dpi: 110, maxLongEdge: 1200, jpegQuality: 0.6, grayscale: true, pagesPerOcrRequest: 4 },
  medium: { dpi: 130, maxLongEdge: 1400, jpegQuality: 0.7, grayscale: true, pagesPerOcrRequest: 3 },
  high: { dpi: 150, maxLongEdge: 1600, jpegQuality: 0.8, grayscale: true, pagesPerOcrRequest: 2 },
} as const;
export type ImageQuality = keyof typeof IMAGE_QUALITY_PRESETS;

export const BACKOFF = {
  baseMs: 2_000,
  maxMs: 60_000,
  maxAttempts: 6,
  jitterMin: 0.5,
  jitterMax: 1.5,
} as const;

/** Pessimistic token estimate used for batching. Real tokenizers usually give fewer tokens. */
export const CHARS_PER_TOKEN_ESTIMATE = 3.5;
/** Share of the context window that batching may fill. The rest covers the system prompt, output and error. */
export const CONTEXT_FILL_RATIO = 0.6;

export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
