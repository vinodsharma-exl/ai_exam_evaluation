/**
 * Getting valid JSON out of free models that sometimes ignore "JSON only":
 *   1. extractJson(): take the JSON from prose or code fences, or from the first balanced {…} / […].
 *   2. lightRepair(): fix the common syntax slips locally (trailing commas, smart quotes, single-quoted
 *      keys, NaN, // comments) without spending a request.
 *   3. validate with zod. If that fails, the caller makes ONE repair request (prompts/templates.ts (e)).
 */
import type { z } from 'zod';

/** Finds the first balanced JSON object or array, respecting strings. Returns null if none. */
export function findBalancedJson(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') continue;
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        const top = stack.pop();
        if ((c === '}' && top !== '{') || (c === ']' && top !== '[')) break; // mismatched: try next start
        if (stack.length === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Applies `fn` only to the parts of `s` that are OUTSIDE double-quoted strings, so the student's text
 * inside values is never altered.
 */
function mapOutsideStrings(s: string, fn: (segment: string) => string): string {
  let out = '';
  let seg = '';
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      out += fn(seg) + c;
      seg = '';
      inStr = true;
    } else seg += c;
  }
  return out + fn(seg);
}

/** Local fixes for common model slips, applied to JSON structure only and only when JSON.parse fails. */
export function lightRepair(s: string): string {
  // Unescaped newlines inside strings are a common slip, so escape them first.
  let fixed = '';
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      else if (c === '\n') {
        fixed += '\\n';
        continue;
      } else if (c === '\r') continue;
    } else if (c === '"') inStr = true;
    fixed += c;
  }
  // Trailing commas may sit next to a string ("x",}), so remove them across segment boundaries too.
  return mapOutsideStrings(fixed, (seg) =>
    seg
      .replace(/\/\/[^\n]*/g, '') // // comments
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":') // unquoted keys
      .replace(/:\s*(NaN|undefined)\b/g, ': null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null'),
  ).replace(/,(\s*[}\]])/g, (m, tail: string, offset: number, all: string) => (isOutsideString(all, offset) ? tail : m));
}

function isOutsideString(s: string, index: number): boolean {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < index; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
  }
  return !inStr;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

export function extractJson(text: string): ParseResult {
  const trimmed = text.trim().replace(/^﻿/, '');
  const candidates: string[] = [];
  // ```json ... ``` fences first.
  for (const m of trimmed.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  candidates.push(trimmed);
  const balanced = findBalancedJson(trimmed);
  if (balanced) candidates.push(balanced);

  let lastErr = 'No JSON found in the response';
  for (const c of candidates) {
    for (const attempt of [c, lightRepair(c)]) {
      try {
        return { ok: true, value: JSON.parse(attempt) };
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    const inner = findBalancedJson(c);
    if (inner && inner !== c) {
      try {
        return { ok: true, value: JSON.parse(lightRepair(inner)) };
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
  }
  return { ok: false, error: lastErr };
}

/**
 * Some models wrap the answer ({"data": {...}}) or return a bare array for a {"results":[...]} schema.
 * Try those shapes too before giving up.
 */
function unwrapCandidates(value: unknown, arrayKey?: string): unknown[] {
  const out = [value];
  if (Array.isArray(value) && arrayKey) out.push({ [arrayKey]: value });
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const vals = Object.values(value as Record<string, unknown>);
    if (vals.length === 1 && vals[0] && typeof vals[0] === 'object') out.push(vals[0]);
  }
  return out;
}

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parseAndValidate<T>(text: string, schema: z.ZodType<T>, arrayKey?: string): ValidateResult<T> {
  const parsed = extractJson(text);
  if (!parsed.ok) return { ok: false, errors: [`Invalid JSON: ${parsed.error}`] };
  let firstErrors: string[] | null = null;
  for (const cand of unwrapCandidates(parsed.value, arrayKey)) {
    const r = schema.safeParse(cand);
    if (r.success) return { ok: true, value: r.data };
    firstErrors ??= r.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  }
  return { ok: false, errors: firstErrors ?? ['Unknown validation error'] };
}

/** The main array key of each AI output schema, for bare-array responses. */
export const ARRAY_KEYS = {
  question_paper: 'questions',
  model_answer: 'answers',
  answer_ocr: 'pages',
  evaluation: 'results',
} as const;
