/**
 * Default provider and model catalog.
 *
 * IMPORTANT: free-tier limits and free model names change often and without notice. These values are
 * deliberately conservative starting points, written as of late 2026. Every number can be edited in
 * Settings.
 *
 * Gemini: Google no longer publishes fixed free-tier numbers; each project's limits are shown in AI Studio
 * (aistudio.google.com → Usage & limits / Rate limits) and are per PROJECT, not per key. Reports from late 2026
 * range from ~5 requests/minute and 20/day per Flash model up to much more, so defaults sit at the low end.
 * A too-low default only makes the app pace itself; a too-high one causes surprise quota pauses. "Test connection" plus the provider's own 429 / Retry-After responses are what the app
 * actually relies on. When a provider sends rate-limit headers (Groq, OpenRouter, OpenAI), the request
 * queue tightens the limiter from them as well.
 *
 * Tip shown in Settings: Gemini quotas are per MODEL. Using gemini-2.5-flash for OCR and
 * gemini-2.5-flash-lite for grading roughly doubles the work one free key can do per day.
 */
import type { ModelCapabilities } from '../schemas/config';
import type { ProviderId } from '../schemas/common';
import type { ModelPreset, ProviderInfo } from './types';

const caps = (c: ModelCapabilities): ModelCapabilities => c;

export const PROVIDER_CATALOG: Record<ProviderId, ProviderInfo> = {
  gemini: {
    id: 'gemini',
    displayName: 'Google Gemini (AI Studio)',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Starts with "AIza". Free from Google AI Studio and no card needed.',
    hasFreeTier: true,
    freeTierMayTrainOnData: true,
    allowsCustomModel: true,
    presets: [
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        tags: ['free', 'vision', 'recommended-ocr'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 4,
          requestsPerMinute: 5,
          dailyLimit: 20,
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
        note: 'Strong free handwriting reader. Check your daily limit in AI Studio and enter it here.',
      },
      {
        id: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash-Lite',
        tags: ['free', 'vision', 'recommended-eval'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 4,
          requestsPerMinute: 10,
          dailyLimit: 20,
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
        note: 'Good for grading. Its quota is separate from Flash, so using both doubles your daily capacity.',
      },
      {
        id: 'gemini-flash-latest',
        label: 'Gemini Flash (latest alias)',
        tags: ['free', 'vision'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 4,
          requestsPerMinute: 5,
          dailyLimit: 20,
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
        note: 'Always points to the newest Flash. Use it if a fixed version is retired.',
      },
    ],
  },

  groq: {
    id: 'groq',
    displayName: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'Starts with "gsk_". Free tier, very fast.',
    hasFreeTier: true,
    freeTierMayTrainOnData: false,
    allowsCustomModel: true,
    presets: [
      {
        id: 'llama-3.3-70b-versatile',
        label: 'Llama 3.3 70B (text)',
        tags: ['free', 'text', 'recommended-eval'],
        capabilities: caps({
          supportsVision: false,
          maxImagesPerRequest: 0,
          requestsPerMinute: 25,
          dailyLimit: 900,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
        note: 'Strong free grader. Also limited by tokens per minute, so batches stay modest.',
      },
      {
        id: 'openai/gpt-oss-120b',
        label: 'GPT-OSS 120B (text)',
        tags: ['free', 'text'],
        capabilities: caps({
          supportsVision: false,
          maxImagesPerRequest: 0,
          requestsPerMinute: 25,
          dailyLimit: 900,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
      },
      {
        id: 'meta-llama/llama-4-scout-17b-16e-instruct',
        label: 'Llama 4 Scout (vision)',
        tags: ['free', 'vision'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 5,
          requestsPerMinute: 25,
          dailyLimit: 900,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
        note: 'Handwriting accuracy is lower than Gemini. Use it as an OCR fallback.',
      },
    ],
  },

  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter (free models)',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'Starts with "sk-or-". Use models ending in ":free". Free daily limit is low without credits.',
    hasFreeTier: true,
    freeTierMayTrainOnData: true,
    allowsCustomModel: true,
    presets: [
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        label: 'Llama 3.3 70B :free (text)',
        tags: ['free', 'text'],
        capabilities: caps({
          supportsVision: false,
          maxImagesPerRequest: 0,
          requestsPerMinute: 16,
          dailyLimit: 45,
          contextWindow: 64_000,
          maxOutputTokens: 4_096,
          supportsJsonMode: false,
        }),
      },
      {
        id: 'google/gemma-3-27b-it:free',
        label: 'Gemma 3 27B :free (vision)',
        tags: ['free', 'vision'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 2,
          requestsPerMinute: 16,
          dailyLimit: 45,
          contextWindow: 32_000,
          maxOutputTokens: 4_096,
          supportsJsonMode: false,
        }),
      },
    ],
  },

  mistral: {
    id: 'mistral',
    displayName: 'Mistral AI',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyHint: 'Free "Experiment" plan. Phone verification required.',
    hasFreeTier: true,
    freeTierMayTrainOnData: true,
    allowsCustomModel: true,
    presets: [
      {
        id: 'mistral-small-latest',
        label: 'Mistral Small (vision)',
        tags: ['free', 'vision', 'text'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 4,
          requestsPerMinute: 20,
          dailyLimit: null,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
      },
      {
        id: 'mistral-large-latest',
        label: 'Mistral Large (text)',
        tags: ['free', 'text'],
        capabilities: caps({
          supportsVision: false,
          maxImagesPerRequest: 0,
          requestsPerMinute: 20,
          dailyLimit: null,
          contextWindow: 128_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: true,
        }),
      },
    ],
  },

  openai: {
    id: 'openai',
    displayName: 'OpenAI (paid)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Starts with "sk-". Needs billing.',
    hasFreeTier: false,
    freeTierMayTrainOnData: false,
    allowsCustomModel: true,
    presets: [
      {
        id: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini',
        tags: ['paid', 'vision', 'text'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 10,
          requestsPerMinute: 60,
          dailyLimit: null,
          contextWindow: 1_000_000,
          maxOutputTokens: 16_384,
          supportsJsonMode: true,
        }),
      },
    ],
  },

  anthropic: {
    id: 'anthropic',
    displayName: 'Anthropic Claude (paid)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Starts with "sk-ant-". Needs billing.',
    hasFreeTier: false,
    freeTierMayTrainOnData: false,
    allowsCustomModel: true,
    presets: [
      {
        id: 'claude-haiku-5-5',
        label: 'Claude Haiku 5.5',
        tags: ['paid', 'vision', 'text'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 10,
          requestsPerMinute: 45,
          dailyLimit: null,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: false,
        }),
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        tags: ['paid', 'vision', 'text'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 10,
          requestsPerMinute: 45,
          dailyLimit: null,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
          supportsJsonMode: false,
        }),
      },
    ],
  },

  custom: {
    id: 'custom',
    displayName: 'Custom (OpenAI-compatible)',
    defaultBaseUrl: null,
    keyUrl: null,
    keyHint: 'Any server with a /chat/completions endpoint (e.g. LM Studio, vLLM, a university proxy).',
    hasFreeTier: false,
    freeTierMayTrainOnData: false,
    allowsCustomModel: true,
    presets: [],
  },

  mock: {
    id: 'mock',
    displayName: 'Demo mode (offline mock)',
    defaultBaseUrl: null,
    keyUrl: null,
    keyHint: 'No key needed. Returns sample results so you can try the app without internet.',
    hasFreeTier: true,
    freeTierMayTrainOnData: false,
    allowsCustomModel: false,
    presets: [
      {
        id: 'mock-vision',
        label: 'Mock (vision + grading)',
        tags: ['free', 'vision', 'text'],
        capabilities: caps({
          supportsVision: true,
          maxImagesPerRequest: 4,
          requestsPerMinute: 120,
          dailyLimit: null,
          contextWindow: 32_000,
          maxOutputTokens: 4_096,
          supportsJsonMode: true,
        }),
      },
    ],
  },
};

export function findPreset(providerId: ProviderId, modelId: string): ModelPreset | undefined {
  return PROVIDER_CATALOG[providerId].presets.find((p) => p.id === modelId);
}
