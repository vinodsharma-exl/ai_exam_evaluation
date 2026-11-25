/**
 * Provider adapter contract.
 *
 * An adapter ONLY translates a CompletionRequest into one HTTP call and maps the response or error.
 * It does NOT retry, rate-limit, cache or validate JSON. The RequestQueue (main/ai/request-queue.ts)
 * does all of that the same way for every provider. Adapters run in the main process only.
 */
import type { ModelCapabilities } from '../schemas/config';
import type { ProviderId } from '../schemas/common';

export interface ImageInput {
  mime: 'image/jpeg' | 'image/png';
  /** Base64 without the data: prefix. */
  base64: string;
  /** Caption placed just before the image in the user content, e.g. "Page 3". Helps models keep page order. */
  label?: string;
}

export interface CompletionRequest {
  model: string;
  system: string;
  user: string;
  images?: ImageInput[];
  /** Ask for JSON-only output when the provider supports it. Prompts still say "JSON only" either way. */
  json: boolean;
  /**
   * Optional JSON Schema for providers with schema-constrained output (Gemini responseSchema,
   * OpenAI json_schema). Adapters may ignore it. Output is always validated with zod afterwards.
   */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens: number;
  /** Low for OCR and grading, so results are repeatable. */
  temperature: number;
}

export interface CompletionResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Rate-limit headers, when the provider sends them (Groq, OpenAI, OpenRouter). */
  rateLimit?: {
    remainingRequests?: number;
    remainingRequestsDay?: number;
    resetRequestsMs?: number;
  };
}

export type ProviderErrorKind =
  | 'auth' // 401/403, bad or revoked key
  | 'rate_limit' // 429 per-minute, retryable
  | 'quota_exhausted' // 429 daily or monthly quota, NOT retryable until reset
  | 'no_vision' // model rejected image input
  | 'model_not_found' // 404 / unknown model
  | 'context_too_long' // 400/413 because the input is too large
  | 'content_filtered' // safety block
  | 'bad_request' // other 400
  | 'server' // 5xx / overloaded (529)
  | 'network' // DNS, offline, connection reset
  | 'timeout'
  | 'cancelled';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    /** From the Retry-After header, Gemini RetryInfo, or the x-ratelimit-reset-* headers. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'server' || this.kind === 'network' || this.kind === 'timeout';
  }
}

export interface CallContext {
  apiKey: string;
  baseUrl?: string;
  extraHeaders?: Record<string, string>;
  signal: AbortSignal;
  /** Per-request timeout in ms. Vision calls get longer. */
  timeoutMs: number;
}

export interface ModelPreset {
  id: string;
  label: string;
  /** Shown in the model picker: "Free tier", "Paid", "Vision". */
  tags: Array<'free' | 'paid' | 'vision' | 'text' | 'recommended-ocr' | 'recommended-eval'>;
  capabilities: ModelCapabilities;
  note?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  defaultBaseUrl: string | null;
  /** Where to get a key. Opened in the system browser. */
  keyUrl: string | null;
  /** Shown under the key field. */
  keyHint: string;
  /** true if the provider has a usable free tier. */
  hasFreeTier: boolean;
  /** Free tier terms may allow the provider to train on submitted data. Shown in the privacy notice. */
  freeTierMayTrainOnData: boolean;
  /** The user can type a model id that is not in the preset list (true for all except mock). */
  allowsCustomModel: boolean;
  presets: ModelPreset[];
}

export interface ProviderAdapter {
  readonly info: ProviderInfo;
  complete(req: CompletionRequest, ctx: CallContext): Promise<CompletionResponse>;
  /**
   * Optional: list the models the key can see (GET /models). Used to refresh the picker,
   * because free model names change often.
   */
  listModels?(ctx: CallContext): Promise<string[]>;
}

/** Fallback capabilities for a model id the user typed that is not in the catalog. Conservative. */
export const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsVision: false,
  maxImagesPerRequest: 0,
  requestsPerMinute: 5,
  dailyLimit: 100,
  contextWindow: 8_192,
  maxOutputTokens: 2_048,
  supportsJsonMode: false,
};
