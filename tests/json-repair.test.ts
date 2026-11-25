import { describe, expect, it } from 'vitest';
import { extractJson, findBalancedJson, lightRepair, parseAndValidate } from '../src/main/ai/json-repair';
import { EvaluationOutput, AnswerOcrOutput } from '../src/shared/schemas/ai-output';

describe('extractJson', () => {
  it('reads JSON from code fences and surrounding prose', () => {
    const r = extractJson('Sure! Here is the result:\n```json\n{"a": 1}\n```\nHope this helps.');
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('finds the first balanced object even with braces inside strings', () => {
    const t = 'prefix {"text": "a } tricky { string", "n": [1, {"x": 2}]} suffix {"other": 1}';
    expect(findBalancedJson(t)).toBe('{"text": "a } tricky { string", "n": [1, {"x": 2}]}');
  });

  it('repairs trailing commas, unquoted keys, Python literals and raw newlines', () => {
    expect(extractJson('{results: [{"q": "1", "review": False, "x": None,},],}')).toEqual({
      ok: true,
      value: { results: [{ q: '1', review: false, x: null }] },
    });
    expect(extractJson('{"text": "line one\nline two"}')).toEqual({ ok: true, value: { text: 'line one\nline two' } });
  });

  it('never alters text inside strings while repairing', () => {
    const fixed = lightRepair('{"feedback": "Good, note: add units, True story,", "n": 1,}');
    expect(JSON.parse(fixed)).toEqual({ feedback: 'Good, note: add units, True story,', n: 1 });
  });

  it('reports failure when there is no JSON', () => {
    expect(extractJson('I cannot help with that.').ok).toBe(false);
  });
});

describe('parseAndValidate', () => {
  it('validates with zod and coerces sloppy types', () => {
    const r = parseAndValidate('{"results":[{"q":"1a","criteria":[{"id":"p1","awarded":"1.5"}],"confidence":"0.8"}]}', EvaluationOutput, 'results');
    expect(r.ok && r.value.results[0]!.criteria[0]!.awarded).toBe(1.5);
  });

  it('accepts a bare array for an array-wrapper schema', () => {
    const r = parseAndValidate('[{"page": 1, "fragments": []}]', AnswerOcrOutput, 'pages');
    expect(r.ok).toBe(true);
  });

  it('accepts a single wrapping object ({"data": {...}})', () => {
    const r = parseAndValidate('{"data": {"results": [{"q": "2"}]}}', EvaluationOutput, 'results');
    expect(r.ok).toBe(true);
  });

  it('returns readable errors for the repair prompt', () => {
    const r = parseAndValidate('{"results": []}', EvaluationOutput, 'results');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/results/);
  });
});
