/**
 * Mark arithmetic. Pure functions, used by main (pipeline, totals) and renderer (live totals while editing).
 * The AI never decides totals, clamping or rounding. This module does.
 */
import type { ChoiceRule, Question } from './schemas/exam';

/** Floating-point-safe rounding to 0.5 or 1. Rounds half up (2.25 → 2.5 with step 0.5). */
export function roundToStep(value: number, allowHalfMarks: boolean): number {
  if (!Number.isFinite(value)) return 0;
  const step = allowHalfMarks ? 0.5 : 1;
  return Math.round((value + 1e-9) / step) * step;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp to [0, max], then round, then clamp again, because rounding 4.75 up with max 4.5 must not
 * exceed the max. Returns whether the raw value had to be clamped (for the 'marks_clamped' flag).
 */
export function normalizeMarks(raw: number, max: number, allowHalfMarks: boolean): { value: number; clamped: boolean } {
  const clamped = !Number.isFinite(raw) || raw < 0 || raw > max + 1e-9;
  let v = roundToStep(clamp(raw, 0, max), allowHalfMarks);
  if (v > max) v = allowHalfMarks ? Math.floor(max * 2) / 2 : Math.floor(max);
  return { value: Math.max(0, v), clamped };
}

/** Validates a mark the professor typed. Returns an error message or null. */
export function validateManualMark(value: number, max: number, allowHalfMarks: boolean): string | null {
  if (!Number.isFinite(value)) return 'Enter a number.';
  if (value < 0) return 'Marks cannot be negative.';
  if (value > max) return `Maximum is ${max}.`;
  if (!allowHalfMarks && !Number.isInteger(value)) return 'Half marks are turned off for this exam.';
  if (allowHalfMarks && !Number.isInteger(value * 2)) return 'Use whole or half marks (e.g. 3 or 3.5).';
  return null;
}

/** Questions whose number appears in some choice rule. */
function choiceMembers(rules: ChoiceRule[]): Set<string> {
  const s = new Set<string>();
  for (const r of rules) for (const q of r.questionNumbers) s.add(q);
  return s;
}

/** Exam maximum: fixed questions plus, for each choice rule, the countBest largest maxMarks in that group. */
export function computeExamTotal(questions: Pick<Question, 'number' | 'maxMarks'>[], rules: ChoiceRule[]): number {
  const members = choiceMembers(rules);
  let total = 0;
  for (const q of questions) if (!members.has(q.number)) total += q.maxMarks;
  for (const r of rules) {
    const maxes = questions
      .filter((q) => r.questionNumbers.includes(q.number))
      .map((q) => q.maxMarks)
      .sort((a, b) => b - a);
    total += maxes.slice(0, r.countBest).reduce((a, b) => a + b, 0);
  }
  return round2(total);
}

/**
 * Student total under choice rules: in each rule group only the best `countBest` scores count.
 * Returns the total and the questions dropped. Ties keep the earlier question.
 */
export function computeStudentTotal(
  marks: Array<{ number: string; marks: number | null }>,
  rules: ChoiceRule[],
): { total: number; dropped: string[] } {
  const members = choiceMembers(rules);
  let total = 0;
  const dropped: string[] = [];
  for (const m of marks) if (!members.has(m.number)) total += m.marks ?? 0;
  for (const r of rules) {
    const group = marks
      .map((m, i) => ({ ...m, i }))
      .filter((m) => r.questionNumbers.includes(m.number))
      .sort((a, b) => (b.marks ?? 0) - (a.marks ?? 0) || a.i - b.i);
    group.forEach((m, rank) => {
      if (rank < r.countBest) total += m.marks ?? 0;
      else dropped.push(m.number);
    });
  }
  return { total: round2(total), dropped };
}

export function percentage(total: number, max: number): number {
  if (max <= 0) return 0;
  return round2(clamp((total / max) * 100, 0, 100));
}

export function gradeFor(percent: number, bands: Array<{ minPercent: number; label: string }>): string {
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  return sorted.find((b) => percent >= b.minPercent)?.label ?? '';
}

/**
 * problems keep an exam in 'draft'. warnings are shown but don't block. When marking points don't
 * add up to max marks, the pipeline scales criterion marks proportionally.
 */
export function examReadiness(questions: Question[], rules: ChoiceRule[]): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (questions.length === 0) problems.push('Add at least one question.');
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.number)) problems.push(`Question ${q.label} appears twice.`);
    seen.add(q.number);
    if (!(q.maxMarks > 0)) problems.push(`Q${q.label}: set max marks.`);
    if (!q.modelAnswer.trim() && q.markingPoints.length === 0)
      problems.push(`Q${q.label}: add a model answer or marking points.`);
    const ptSum = round2(q.markingPoints.reduce((a, p) => a + p.marks, 0));
    if (q.markingPoints.length > 0 && Math.abs(ptSum - q.maxMarks) > 1e-6)
      warnings.push(`Q${q.label}: marking points add up to ${ptSum}, not ${q.maxMarks}. Marks will be scaled.`);
  }
  for (const r of rules) {
    const missing = r.questionNumbers.filter((n) => !seen.has(n));
    if (missing.length) problems.push(`Choice rule "${r.description || r.id}" refers to unknown questions: ${missing.join(', ')}.`);
    if (r.countBest >= r.questionNumbers.length)
      problems.push(`Choice rule "${r.description || r.id}": "best ${r.countBest}" must be fewer than its ${r.questionNumbers.length} questions.`);
  }
  return { problems, warnings };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
