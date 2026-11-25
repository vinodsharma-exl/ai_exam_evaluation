/**
 * Pure planning: which tasks a student's job needs and how work is grouped into requests.
 *
 * The plan grows as the job learns more:
 *   initial:          render_pages → merge_answers → finalize_totals
 *   after render:     + ocr_pages tasks (inserted after render_pages)
 *   after merge:      + evaluate_questions tasks (inserted after merge_answers)
 * Planning OCR after render, and evaluation after merge, lets grouping use the real page count and
 * the real answer lengths.
 */
import type { Task } from '../../shared/schemas/jobs';
import type { ModelCapabilities } from '../../shared/schemas/config';
import type { ModelRef } from '../../shared/schemas/common';
import { CHARS_PER_TOKEN_ESTIMATE, CONTEXT_FILL_RATIO } from '../../shared/constants';

export function newTask(partial: Pick<Task, 'id' | 'kind'> & Partial<Task>): Task {
  return {
    pages: [],
    questions: [],
    status: 'pending',
    model: null,
    attempts: 0,
    requestsUsed: 0,
    cacheHit: false,
    supersededBy: [],
    reason: 'plan',
    bypassCache: false,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    ...partial,
  };
}

export function planInitialTasks(): Task[] {
  return [
    newTask({ id: 'render', kind: 'render_pages' }),
    newTask({ id: 'merge', kind: 'merge_answers' }),
    newTask({ id: 'finalize', kind: 'finalize_totals' }),
  ];
}

/** Pages per OCR request: limited by the model's image cap and the quality preset. Always at least 1. */
export function ocrGroupSize(caps: ModelCapabilities, presetPagesPerRequest: number): number {
  return Math.max(1, Math.min(caps.maxImagesPerRequest || 1, presetPagesPerRequest));
}

/**
 * Groups consecutive page indexes. Pages that are blank or manually entered are left out by the
 * caller. Groups never jump a gap, so "previous question" context stays correct.
 */
export function planOcrTasks(pageIndexes: number[], groupSize: number, model: ModelRef, reason = 'plan'): Task[] {
  const sorted = [...new Set(pageIndexes)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && g.length < groupSize && g[g.length - 1] === p - 1) g.push(p);
    else groups.push([p]);
  }
  return groups.map((g) =>
    newTask({
      id: `ocr:${g[0]! + 1}-${g[g.length - 1]! + 1}${reason === 'plan' ? '' : `#${reason}`}`,
      kind: 'ocr_pages',
      pages: g,
      model,
      reason,
    }),
  );
}

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);

/** Rough fixed cost of the evaluation system prompt and JSON overhead. */
export const EVAL_SYSTEM_TOKENS = 450;
export const EVAL_OUTPUT_TOKENS_PER_QUESTION = 450;

export interface EvalItemSize {
  number: string;
  /** Tokens for this question's rendered item (question + model answer + criteria + student text). */
  tokens: number;
}

/**
 * Greedy batching in exam order. A batch closes when the next item would go over the input budget,
 * the output budget, or maxQuestionsPerBatch. An item bigger than the whole budget gets its own batch,
 * which may fail with context_too_long; the runner then reports a clear error for that one question.
 */
export function planEvaluationBatches(
  items: EvalItemSize[],
  caps: ModelCapabilities,
  opts: { batchQuestions: boolean; maxQuestionsPerBatch: number },
): string[][] {
  if (items.length === 0) return [];
  const maxPerBatch = opts.batchQuestions ? Math.max(1, opts.maxQuestionsPerBatch) : 1;
  const inputBudget = Math.max(512, Math.floor(caps.contextWindow * CONTEXT_FILL_RATIO) - caps.maxOutputTokens - EVAL_SYSTEM_TOKENS);
  const outputCap = Math.max(1, Math.floor((caps.maxOutputTokens - 200) / EVAL_OUTPUT_TOKENS_PER_QUESTION));
  const limit = Math.min(maxPerBatch, outputCap);
  const batches: string[][] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const it of items) {
    if (cur.length > 0 && (cur.length >= limit || curTokens + it.tokens > inputBudget)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(it.number);
    curTokens += it.tokens;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export function planEvaluationTasks(batches: string[][], model: ModelRef, reason = 'plan', bypassCache = false): Task[] {
  return batches.map((b, i) =>
    newTask({
      id: reason === 'plan' ? `eval:b${i + 1}` : `eval:${b.join('+')}#${reason}-${Date.now().toString(36)}`,
      kind: 'evaluate_questions',
      questions: b,
      model,
      reason,
      bypassCache,
    }),
  );
}

/** Replacement tasks when a multi-question batch fails on context size or JSON: one question per task. */
export function splitEvaluationTask(task: Task): Task[] {
  return task.questions.map((q) =>
    newTask({
      id: `${task.id}/${q}`,
      kind: 'evaluate_questions',
      questions: [q],
      model: task.model,
      reason: 'split',
      bypassCache: task.bypassCache,
    }),
  );
}

/** Request counts for the usage estimate shown before starting. */
export function estimateRequests(args: {
  ocrPages: number;
  ocrGroupSize: number;
  questions: number;
  evalBatchSize: number;
}): { ocr: number; evaluation: number } {
  return {
    ocr: args.ocrPages > 0 ? Math.ceil(args.ocrPages / Math.max(1, args.ocrGroupSize)) : 0,
    evaluation: args.questions > 0 ? Math.ceil(args.questions / Math.max(1, args.evalBatchSize)) : 0,
  };
}
