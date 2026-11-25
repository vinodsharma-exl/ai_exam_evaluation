import { z } from 'zod';
import { SCHEMA_VERSIONS, LOW_CONFIDENCE_THRESHOLD_DEFAULT } from '../constants';
import { ImageQualityEnum, IsoDateTime, ModelRef, ProviderId, Strictness } from './common';

/**
 * Capability flags for one provider+model. Defaults come from providers/catalog.ts and every value
 * can be edited in Settings, because free-tier limits change without notice.
 */
export const ModelCapabilities = z.object({
  supportsVision: z.boolean(),
  maxImagesPerRequest: z.number().int().min(0).max(100),
  requestsPerMinute: z.number().positive().max(10_000),
  /** null means no known daily cap. */
  dailyLimit: z.number().int().positive().nullable(),
  /** In tokens. */
  contextWindow: z.number().int().min(1024),
  maxOutputTokens: z.number().int().min(256),
  /** The provider can force JSON output (response_format, responseMimeType or similar). */
  supportsJsonMode: z.boolean(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const ConnectionTestResult = z.object({
  at: IsoDateTime,
  ok: z.boolean(),
  /** null means vision was not tested, because text failed first. */
  vision: z.boolean().nullable(),
  latencyMs: z.number().nonnegative().optional(),
  errorCode: z.string().optional(),
  message: z.string().max(500).optional(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

export const ModelSettings = z.object({
  capabilities: ModelCapabilities,
  /** true once the user has changed any value, so catalog updates no longer overwrite it. */
  userEdited: z.boolean().default(false),
  lastTest: ConnectionTestResult.optional(),
});

export const ProviderSettings = z.object({
  enabled: z.boolean().default(true),
  /** Required for 'custom'. Optional override for the others, e.g. a proxy. */
  baseUrl: z.url().optional(),
  /** Keyed by model id. The key itself is in secrets.bin. config.json only says that one exists. */
  models: z.record(z.string(), ModelSettings).default({}),
  /** Requests sent at the same time to this provider. Free tiers work best with 1. */
  maxConcurrent: z.number().int().min(1).max(8).default(1),
  /** Extra headers that are not secret, e.g. OpenRouter's HTTP-Referer/X-Title. */
  extraHeaders: z.record(z.string(), z.string()).default({}),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

export const GradingSettings = z.object({
  strictness: Strictness.default('standard'),
  allowHalfMarks: z.boolean().default(true),
  /** E.g. "Cursive English; students often write 'f' like 's'". */
  handwritingHint: z.string().max(300).default(''),
  /** E.g. "English with some Hindi terms", "Answers may be in Tamil". */
  languageHint: z.string().max(200).default(''),
  lowConfidenceThreshold: z.number().min(0).max(1).default(LOW_CONFIDENCE_THRESHOLD_DEFAULT),
  /** Pack several questions into one evaluation call when they fit. */
  batchQuestions: z.boolean().default(true),
  /** Upper bound on questions per batch, even when more would fit. */
  maxQuestionsPerBatch: z.number().int().min(1).max(30).default(8),
});
export type GradingSettings = z.infer<typeof GradingSettings>;

export const ConfigFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.config),
  /** Set when the privacy notice is acknowledged. The notice is shown on first run while this is null. */
  privacyNoticeAcceptedAt: IsoDateTime.nullable().default(null),
  stages: z.object({
    ocr: ModelRef,
    evaluation: ModelRef,
  }),
  providers: z.partialRecord(ProviderId, ProviderSettings).default({}),
  grading: GradingSettings,
  imageQuality: ImageQualityEnum.default('medium'),
  ui: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).default('system'),
      /** Show the usage estimate dialog before starting a job. */
      confirmBeforeProcessing: z.boolean().default(true),
      lastOpenedExamId: z.string().nullable().default(null),
    })
    .default({ theme: 'system', confirmBeforeProcessing: true, lastOpenedExamId: null }),
  institution: z
    .object({
      name: z.string().max(200).default(''),
      department: z.string().max(200).default(''),
      /** Optional PNG/JPG copied into the data dir, used on report headers. */
      logoFile: z.string().nullable().default(null),
    })
    .default({ name: '', department: '', logoFile: null }),
  /** Grade bands for reports. Must be sorted by minPercent, highest first. */
  gradeBands: z
    .array(z.object({ minPercent: z.number().min(0).max(100), label: z.string().max(10) }))
    .default([
      { minPercent: 90, label: 'A+' },
      { minPercent: 80, label: 'A' },
      { minPercent: 70, label: 'B' },
      { minPercent: 60, label: 'C' },
      { minPercent: 50, label: 'D' },
      { minPercent: 40, label: 'E' },
      { minPercent: 0, label: 'F' },
    ]),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

/**
 * Decrypted content of secrets.bin. It only exists in main-process memory.
 * secrets.bin = safeStorage.encryptString(JSON.stringify(SecretsPayload)).
 */
export const SecretsPayload = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.secrets),
  apiKeys: z.partialRecord(ProviderId, z.string().min(1).max(500)).default({}),
});
export type SecretsPayload = z.infer<typeof SecretsPayload>;

/** Stored OUTSIDE the data dir (in Electron userData), so the app can find the data dir. */
export const BootstrapFile = z.object({
  dataDir: z.string().min(1),
});
