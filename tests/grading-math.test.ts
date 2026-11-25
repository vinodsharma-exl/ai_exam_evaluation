import { describe, expect, it } from 'vitest';
import {
  computeExamTotal,
  computeStudentTotal,
  examReadiness,
  gradeFor,
  normalizeMarks,
  roundToStep,
  validateManualMark,
} from '../src/shared/grading-math';
import type { Question } from '../src/shared/schemas/exam';

const q = (number: string, maxMarks: number, extra: Partial<Question> = {}): Question => ({
  label: number,
  number,
  order: 0,
  text: '',
  maxMarks,
  type: 'theory',
  modelAnswer: 'x',
  markingPoints: [],
  finalAnswer: '',
  expectsDiagram: false,
  origin: 'manual',
  ...extra,
});

describe('grading math', () => {
  it('rounds to half or whole marks', () => {
    expect(roundToStep(2.24, true)).toBe(2);
    expect(roundToStep(2.25, true)).toBe(2.5);
    expect(roundToStep(2.5, false)).toBe(3);
    expect(roundToStep(NaN, true)).toBe(0);
  });

  it('never exceeds max marks and flags clamping', () => {
    expect(normalizeMarks(7, 5, true)).toEqual({ value: 5, clamped: true });
    expect(normalizeMarks(-1, 5, true)).toEqual({ value: 0, clamped: true });
    expect(normalizeMarks(4.4, 4.5, false)).toEqual({ value: 4, clamped: false });
    expect(normalizeMarks(4.75, 4.5, true).value).toBe(4.5);
  });

  it('validates manual marks', () => {
    expect(validateManualMark(3.5, 5, true)).toBeNull();
    expect(validateManualMark(3.5, 5, false)).toMatch(/Half/);
    expect(validateManualMark(3.3, 5, true)).toMatch(/half/);
    expect(validateManualMark(6, 5, true)).toMatch(/Maximum/);
  });

  it('applies "answer any N" rules to exam and student totals', () => {
    const qs = [q('1', 10), q('2', 5), q('3', 5), q('4', 8)];
    const rules = [{ id: 'r1', questionNumbers: ['2', '3', '4'], countBest: 2, description: '' }];
    expect(computeExamTotal(qs, rules)).toBe(10 + 8 + 5);
    const st = computeStudentTotal(
      [
        { number: '1', marks: 7 },
        { number: '2', marks: 4 },
        { number: '3', marks: 2 },
        { number: '4', marks: 3 },
      ],
      rules,
    );
    expect(st).toEqual({ total: 7 + 4 + 3, dropped: ['3'] });
  });

  it('grades by bands', () => {
    const bands = [
      { minPercent: 80, label: 'A' },
      { minPercent: 0, label: 'F' },
    ];
    expect(gradeFor(85, bands)).toBe('A');
    expect(gradeFor(10, bands)).toBe('F');
  });

  it('reports readiness problems and warnings', () => {
    const r = examReadiness(
      [
        q('1', 5, { modelAnswer: '', markingPoints: [] }),
        q('2', 4, { markingPoints: [{ id: 'p1', description: 'a', marks: 3 }] }),
        q('2', 4),
      ],
      [],
    );
    expect(r.problems.join(' ')).toMatch(/Q1: add a model answer/);
    expect(r.problems.join(' ')).toMatch(/appears twice/);
    expect(r.warnings.join(' ')).toMatch(/add up to 3, not 4/);
  });
});
