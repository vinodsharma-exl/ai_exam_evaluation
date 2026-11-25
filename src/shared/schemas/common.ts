import { z } from 'zod';
import { isSafeId } from '../paths';

export const IsoDateTime = z.iso.datetime({ offset: true }).describe('ISO-8601 timestamp');
export const IsoDate = z.iso.date().describe('YYYY-MM-DD');

export const SafeId = z
  .string()
  .refine(isSafeId, 'Must be 1-64 chars of A-Z a-z 0-9 . _ - and not a Windows reserved name')
  .describe('Folder-safe identifier');

/** Question numbers as printed: "1", "2a", "3(b)(ii)", "Q4". Normalised by normalizeQuestionNumber. */
export const QuestionNumber = z.string().min(1).max(24);

export const Marks = z.number().min(0).max(1000);
export const Confidence = z.number().min(0).max(1);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const ProviderId = z.enum([
  'gemini',
  'groq',
  'openrouter',
  'mistral',
  'openai',
  'anthropic',
  'custom',
  'mock',
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const Stage = z.enum(['ocr', 'evaluation']);
export type Stage = z.infer<typeof Stage>;

export const QuestionType = z.enum(['theory', 'numerical', 'mixed']);
export type QuestionType = z.infer<typeof QuestionType>;

export const Strictness = z.enum(['lenient', 'standard', 'strict']);
export type Strictness = z.infer<typeof Strictness>;

export const ImageQualityEnum = z.enum(['low', 'medium', 'high']);

export const ModelRef = z.object({
  providerId: ProviderId,
  model: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const AppErrorDataSchema = z.object({
  code: z.string(),
  detail: z.string().optional(),
  resumeAt: z.number().optional(),
  at: IsoDateTime,
});

/** Who produced a piece of text or a mark. Shown in the UI as a badge. */
export const Origin = z.enum(['ai', 'manual', 'ai_edited']);
export type Origin = z.infer<typeof Origin>;

/**
 * Canonical form used for matching: "Q.3 (b)(ii)" becomes "3b.ii", "Question 2-A" becomes "2a".
 * The original label is kept separately for display.
 */
export function normalizeQuestionNumber(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/^(question|ques|qn|answer|ans|q)\s*\.?\s*(no\.?\s*)?/i, '');
  // Split into number/letter tokens; spaces, brackets, dots and dashes all act as separators,
  // so "3 b ii", "3(b)(ii)" and "3.b.ii" all become [3, b, ii].
  const parts = s.match(/[0-9]+|[a-z]+/g) ?? [];
  if (parts.length === 0) return raw.trim();
  // Roman numerals after a letter are sub-sub-parts: 3 b ii → "3b.ii".
  const [head, ...rest] = parts;
  let out = head!;
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i]!;
    const isRoman = /^(i{1,3}|iv|v|vi{0,3}|ix|x)$/.test(p) && i > 0;
    out += isRoman ? `.${p}` : p;
  }
  return out;
}
