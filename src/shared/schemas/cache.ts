import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDateTime, ModelRef, Sha256 } from './common';

/**
 * cache/<ab>/<sha256>.json. The key is
 * sha256(providerId ‖ model ‖ PROMPT_VERSION ‖ system ‖ user ‖ imageSha256s.join(',')).
 * Only responses that passed validation are cached, so a broken response is never replayed.
 */
export const CacheEntry = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.cacheEntry),
  key: Sha256,
  by: ModelRef,
  promptKind: z.enum(['question_paper', 'model_answer', 'answer_ocr', 'evaluation', 'repair']),
  /** The validated, parsed JSON. Not the raw text. */
  output: z.unknown(),
  usage: z
    .object({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0) })
    .partial()
    .default({}),
  createdAt: IsoDateTime,
});
export type CacheEntry = z.infer<typeof CacheEntry>;
