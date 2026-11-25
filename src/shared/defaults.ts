import { SCHEMA_VERSIONS } from './constants';
import type { ConfigFile, ModelCapabilities } from './schemas/config';
import type { ModelRef } from './schemas/common';
import { findPreset } from './providers/catalog';
import { UNKNOWN_MODEL_CAPABILITIES } from './providers/types';

/** First-run config. One free Gemini key covers both stages, and each model has its own quota. */
export function defaultConfig(): ConfigFile {
  return {
    schemaVersion: SCHEMA_VERSIONS.config,
    privacyNoticeAcceptedAt: null,
    stages: {
      ocr: { providerId: 'gemini', model: 'gemini-2.5-flash' },
      evaluation: { providerId: 'gemini', model: 'gemini-2.5-flash-lite' },
    },
    providers: {},
    grading: {
      strictness: 'standard',
      allowHalfMarks: true,
      handwritingHint: '',
      languageHint: '',
      lowConfidenceThreshold: 0.6,
      batchQuestions: true,
      maxQuestionsPerBatch: 8,
    },
    imageQuality: 'medium',
    ui: { theme: 'system', confirmBeforeProcessing: true, lastOpenedExamId: null },
    institution: { name: '', department: '', logoFile: null },
    gradeBands: [
      { minPercent: 90, label: 'A+' },
      { minPercent: 80, label: 'A' },
      { minPercent: 70, label: 'B' },
      { minPercent: 60, label: 'C' },
      { minPercent: 50, label: 'D' },
      { minPercent: 40, label: 'E' },
      { minPercent: 0, label: 'F' },
    ],
  };
}

/** Effective capabilities: user-edited values, then catalog preset, then conservative unknown defaults. */
export function resolveCapabilities(config: ConfigFile, ref: ModelRef): ModelCapabilities {
  const userEntry = config.providers[ref.providerId]?.models[ref.model];
  if (userEntry) return userEntry.capabilities;
  return findPreset(ref.providerId, ref.model)?.capabilities ?? UNKNOWN_MODEL_CAPABILITIES;
}

/** Rate-limiter bucket key. Free quotas are per model, so the bucket is too. */
export const limiterKey = (ref: ModelRef) => `${ref.providerId}:${ref.model}`;
