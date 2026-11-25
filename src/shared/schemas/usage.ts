import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDate, IsoDateTime } from './common';

/**
 * usage.json: request counters per "provider:model" per day. Persisted, so daily caps survive restarts.
 * Free-tier daily quotas usually reset at midnight Pacific time (Gemini) or on a rolling window. To be
 * safe we count per LOCAL date and also record when the provider last refused us for quota.
 */
export const UsageDay = z.object({
  requests: z.number().int().min(0),
  cacheHits: z.number().int().min(0).default(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  errors429: z.number().int().min(0).default(0),
});

export const UsageFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.usage),
  /** key "gemini:gemini-2.5-flash" → date → counters. Days older than 31 are pruned on write. */
  byModel: z.record(z.string(), z.record(IsoDate, UsageDay)),
  /** Set when a provider returns a daily-quota error, so we stop calling it before it resets. */
  quotaExhaustedUntil: z.record(z.string(), IsoDateTime).default({}),
  updatedAt: IsoDateTime,
});
export type UsageFile = z.infer<typeof UsageFile>;
