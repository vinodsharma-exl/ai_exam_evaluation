/**
 * User-facing error catalogue. Every error the UI shows has a plain-language message AND a next action.
 * Messages must never contain an API key, and never the full request or response body.
 */

export const ERROR_CODES = [
  'INVALID_API_KEY',
  'MISSING_API_KEY',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'MODEL_NO_VISION',
  'MODEL_NOT_FOUND',
  'CONTEXT_TOO_LONG',
  'CONTENT_FILTERED',
  'NETWORK_OFFLINE',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'INVALID_AI_JSON',
  'UNREADABLE_SCAN',
  'BLANK_PAGE',
  'PDF_RENDER_FAILED',
  'UNSUPPORTED_FILE',
  'FILE_CORRUPT',
  'DATA_DIR_UNWRITABLE',
  'ENCRYPTION_UNAVAILABLE',
  'EXAM_NOT_READY',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'VALIDATION',
  'PIN_INCORRECT',
  'PIN_LOCKED',
  'NEWER_FILE_VERSION',
  'NOT_IMPLEMENTED',
  'NOT_SIGNED_IN',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** What the UI can offer as a button next to the message. */
export type NextAction =
  | 'open_settings_keys'
  | 'open_settings_models'
  | 'open_settings_limits'
  | 'wait_and_resume'
  | 'resume_tomorrow'
  | 'switch_ocr_model'
  | 'enter_text_manually'
  | 'rescan_page'
  | 'retry'
  | 'split_batch'
  | 'open_exam_setup'
  | 'choose_data_folder'
  | 'restore_backup'
  | 'none';

export interface ErrorInfo {
  title: string;
  message: string;
  actions: NextAction[];
  /** true means the job runner may retry by itself. false means the job pauses and waits for the professor. */
  autoRetry: boolean;
}

export const ERROR_INFO: Record<ErrorCode, ErrorInfo> = {
  INVALID_API_KEY: {
    title: 'API key not accepted',
    message: 'The provider rejected the key. Check it was copied completely (no spaces) and that it belongs to this provider.',
    actions: ['open_settings_keys'],
    autoRetry: false,
  },
  MISSING_API_KEY: {
    title: 'No API key',
    message: 'No key is saved for the provider chosen for this step. Add one in Settings → AI Providers.',
    actions: ['open_settings_keys'],
    autoRetry: false,
  },
  RATE_LIMITED: {
    title: 'Waiting for rate limit',
    message: 'The free limit allows only a few requests per minute. Work resumes automatically.',
    actions: ['wait_and_resume'],
    autoRetry: true,
  },
  QUOTA_EXHAUSTED: {
    title: "Today's free limit is used up",
    message: 'Progress is saved. Resume tomorrow, or pick another model or provider for this step in Settings. Finished pages are not processed again.',
    actions: ['resume_tomorrow', 'open_settings_models'],
    autoRetry: false,
  },
  MODEL_NO_VISION: {
    title: 'This model cannot read images',
    message: 'The OCR step needs a vision model (for example Gemini Flash). Choose one for OCR in Settings, or type the answer text for this page.',
    actions: ['switch_ocr_model', 'enter_text_manually'],
    autoRetry: false,
  },
  MODEL_NOT_FOUND: {
    title: 'Model not found',
    message: 'The provider does not offer this model name (free models are renamed often). Pick another model in Settings.',
    actions: ['open_settings_models'],
    autoRetry: false,
  },
  CONTEXT_TOO_LONG: {
    title: 'Too much text for this model',
    message: 'The questions are being sent one at a time instead.',
    actions: ['split_batch'],
    autoRetry: true,
  },
  CONTENT_FILTERED: {
    title: 'Provider refused the content',
    message: "The provider's safety filter blocked this page. Enter the text manually or try another provider.",
    actions: ['enter_text_manually', 'open_settings_models'],
    autoRetry: false,
  },
  NETWORK_OFFLINE: {
    title: 'No internet connection',
    message: 'AI steps need the internet. Your progress is saved. Resume when you are back online.',
    actions: ['retry'],
    autoRetry: false,
  },
  PROVIDER_UNAVAILABLE: {
    title: 'AI service temporarily unavailable',
    message: 'The provider is overloaded or down. Retrying with increasing waits.',
    actions: ['wait_and_resume'],
    autoRetry: true,
  },
  TIMEOUT: {
    title: 'The AI took too long',
    message: 'The request timed out and will be retried.',
    actions: ['retry'],
    autoRetry: true,
  },
  INVALID_AI_JSON: {
    title: 'Unreadable AI response',
    message: 'The model did not return valid data, even after one repair attempt. Retry, or choose a stronger model.',
    actions: ['retry', 'open_settings_models'],
    autoRetry: false,
  },
  UNREADABLE_SCAN: {
    title: 'Page could not be read',
    message: 'Most of the page came back as [illegible]. Rescan at higher quality, or type the text manually.',
    actions: ['rescan_page', 'enter_text_manually'],
    autoRetry: false,
  },
  BLANK_PAGE: {
    title: 'Blank page skipped',
    message: 'This page looks empty, so no request was sent for it.',
    actions: ['none'],
    autoRetry: false,
  },
  PDF_RENDER_FAILED: {
    title: 'Could not open the PDF',
    message: 'The file may be damaged or password-protected. Export it again, or upload photos of the pages.',
    actions: ['rescan_page'],
    autoRetry: false,
  },
  UNSUPPORTED_FILE: {
    title: 'File type not supported',
    message: 'Upload PDF, JPG or PNG files.',
    actions: ['none'],
    autoRetry: false,
  },
  FILE_CORRUPT: {
    title: 'A data file is damaged',
    message: 'The damaged file was set aside (renamed .corrupt) and not deleted. Restore from a backup, or redo this step.',
    actions: ['restore_backup', 'retry'],
    autoRetry: false,
  },
  DATA_DIR_UNWRITABLE: {
    title: 'Cannot save to the data folder',
    message: 'Choose a folder you can write to (for example in Documents) in Settings → Data.',
    actions: ['choose_data_folder'],
    autoRetry: false,
  },
  ENCRYPTION_UNAVAILABLE: {
    title: 'Secure key storage unavailable',
    message: 'Windows could not encrypt the API key, so it was not saved. Sign in to Windows normally (not a temporary profile) and try again.',
    actions: ['open_settings_keys'],
    autoRetry: false,
  },
  EXAM_NOT_READY: {
    title: 'Exam setup incomplete',
    message: 'Every question needs max marks and at least a model answer or marking points before grading.',
    actions: ['open_exam_setup'],
    autoRetry: false,
  },
  NOT_FOUND: {
    title: 'Not found',
    message: 'This item no longer exists. It may have been deleted or the data folder changed.',
    actions: ['none'],
    autoRetry: false,
  },
  ALREADY_EXISTS: {
    title: 'Already exists',
    message: 'An item with this ID already exists. Open the existing one or use a different ID.',
    actions: ['none'],
    autoRetry: false,
  },
  VALIDATION: {
    title: 'Please check the values',
    message: 'Some values are missing or not allowed. See the details.',
    actions: ['none'],
    autoRetry: false,
  },
  PIN_INCORRECT: {
    title: 'Incorrect PIN',
    message: 'The PIN does not match. Try again.',
    actions: ['retry'],
    autoRetry: false,
  },
  PIN_LOCKED: {
    title: 'Too many attempts',
    message: 'Wait 30 seconds before trying the PIN again.',
    actions: ['none'],
    autoRetry: false,
  },
  NEWER_FILE_VERSION: {
    title: 'Made by a newer version',
    message: 'This data was saved by a newer version of AnswerEval AI. Update the app to open it. The file was not changed.',
    actions: ['none'],
    autoRetry: false,
  },
  NOT_IMPLEMENTED: {
    title: 'Not available yet',
    message: 'This feature is not available in this build.',
    actions: ['none'],
    autoRetry: false,
  },
  NOT_SIGNED_IN: {
    title: 'Please sign in',
    message: 'Sign in to your local profile to continue.',
    actions: ['none'],
    autoRetry: false,
  },
  CANCELLED: {
    title: 'Cancelled',
    message: 'Processing was stopped. Completed work is kept. Press Resume to continue.',
    actions: ['retry'],
    autoRetry: false,
  },
  UNKNOWN: {
    title: 'Something went wrong',
    message: 'An unexpected error occurred. Progress is saved. Try Resume.',
    actions: ['retry'],
    autoRetry: false,
  },
};

/** Serializable error passed over IPC and stored in jobs.json. */
export interface AppErrorData {
  code: ErrorCode;
  /** Short technical detail for the "Details" expander. Must already be redacted. */
  detail?: string;
  /** For RATE_LIMITED: epoch ms when work resumes. */
  resumeAt?: number;
  at: string;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly detail?: string,
    public readonly resumeAt?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AppError';
  }
  toData(): AppErrorData {
    return {
      code: this.code,
      detail: this.detail ? redactSecrets(this.detail) : undefined,
      resumeAt: this.resumeAt,
      at: new Date().toISOString(),
    };
  }
}

/** Removes anything that looks like an API key or a bearer token from text before it is logged or stored. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[redacted]')
    .replace(/([?&]key=)[^&\s"]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_\-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_\-]{20,}|sk-ant-[A-Za-z0-9_\-]{8,}|sk-or-[A-Za-z0-9_\-]{8,})/g, '[redacted]')
    .replace(/("?(x-goog-api-key|x-api-key|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]');
}
