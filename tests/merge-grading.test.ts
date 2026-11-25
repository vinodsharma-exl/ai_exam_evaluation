import { describe, expect, it } from 'vitest';
import { mergeAnswers, parseManualPageText, resolveQuestion } from '../src/main/ai/merge-answers';
import { scoreQuestion } from '../src/main/ai/grading';
import type { ExamFile, Question } from '../src/shared/schemas/exam';
import type { ExtractionPage, PageFragment } from '../src/shared/schemas/extraction';

const q = (label: string, number: string, maxMarks: number, extra: Partial<Question> = {}): Question => ({
  label, number, order: 0, text: '', maxMarks, type: 'theory', modelAnswer: 'm', markingPoints: [], finalAnswer: '', expectsDiagram: false, origin: 'manual', ...extra,
});
const exam = { questions: [q('1(a)', '1a', 2), q('1(b)', '1b', 3), q('2', '2', 5), q('3(b)(ii)', '3b.ii', 4)], choiceRules: [] } as unknown as ExamFile;
const frag = (questionNumber: string | null, text: string, extra: Partial<PageFragment> = {}): PageFragment => ({
  questionNumber, continued: questionNumber === null, text, hasDiagram: false, diagramDescription: '', illegibleCount: 0, confidence: 0.9, ...extra,
});
const page = (index: number, fragments: PageFragment[], status: ExtractionPage['ocr']['status'] = 'done'): ExtractionPage => ({
  index, file: `pages/p${index + 1}.jpg`, source: { uploadIndex: 0, pageInUpload: index }, rotation: 0, width: 1, height: 1, sha256: 'a'.repeat(64),
  ocr: { status, by: null, cacheKey: null, at: null, error: null }, fragments, pageNote: '',
});

describe('resolveQuestion', () => {
  it('matches labels written in many styles', () => {
    expect(resolveQuestion('Q.1 (a)', exam)).toBe('1a');
    expect(resolveQuestion('Ans 3(b)(ii)', exam)).toBe('3b.ii');
    expect(resolveQuestion('Q. No. 2', exam)).toBe('2');
    expect(resolveQuestion('3 b ii', exam)).toBe('3b.ii');
    expect(resolveQuestion('Question 2', exam)).toBe('2');
    expect(resolveQuestion('7', exam)).toBe(null);
  });
});

describe('mergeAnswers', () => {
  it('stitches answers across pages, handles returns, rough work, unknown labels and skipped questions', () => {
    const pages = [
      page(0, [frag(null, 'Name: Asha'), frag('1a', 'A stack is LIFO.'), frag('2', 'Start of Q2')]),
      page(1, [frag(null, 'Q2 continued on page 2', { illegibleCount: 1, confidence: 0.6 }), frag('rough', '5-3=2'), frag('9', 'stray')]),
      page(2, [], 'blank'),
      page(3, [frag('1a', 'Also: push/pop at top.', { hasDiagram: true, diagramDescription: 'stack drawing' })]),
    ];
    const r = mergeAnswers(exam, pages, [], '2026-11-25T10:00:00Z');
    const a1 = r.answers.find((a) => a.questionNumber === '1a')!;
    const a2 = r.answers.find((a) => a.questionNumber === '2')!;
    expect(a1.text).toBe('A stack is LIFO.\n[continued later in the sheet]\nAlso: push/pop at top.');
    expect(a1.pages).toEqual([0, 3]);
    expect(a1.hasDiagram).toBe(true);
    expect(a2.text).toBe('Start of Q2\nQ2 continued on page 2');
    expect(a2.pages).toEqual([0, 1]);
    expect(a2.illegibleCount).toBe(1);
    expect(a2.confidence).toBe(0.6);
    expect(r.notAttempted).toEqual(['1b', '3b.ii']);
    expect(r.unknownQuestionNumbers).toEqual(['9']);
    expect(r.unassigned.map((u) => u.text)).toEqual(['Name: Asha', '[rough work] 5-3=2', '[written as "9"] stray']);
  });

  it("keeps the professor's edited text", () => {
    const pages = [page(0, [frag('2', 'AI text')])];
    const edited = { questionNumber: '2', pages: [0], text: 'Professor text', hasDiagram: false, diagramDescription: '', illegibleCount: 0, confidence: 1, origin: 'ai_edited' as const, editedAt: null, textHash: 'b'.repeat(64) };
    const r = mergeAnswers(exam, pages, [edited], '');
    expect(r.answers.find((a) => a.questionNumber === '2')!.text).toBe('Professor text');
  });
});

describe('parseManualPageText', () => {
  it('splits typed text at question labels', () => {
    const f = parseManualPageText('continuing from before\nQ1 (a) A stack is LIFO\nmore\n2. 5 - 3 = 2\n1(b): push adds [illegible]', exam);
    expect(f.map((x) => [x.questionNumber, x.text])).toEqual([
      [null, 'continuing from before'],
      ['1a', 'A stack is LIFO\nmore'],
      ['2', '5 - 3 = 2'],
      ['1b', 'push adds [illegible]'],
    ]);
    expect(f[3]!.illegibleCount).toBe(1);
  });
});

describe('scoreQuestion (code decides marks, not the model)', () => {
  const base = {
    answer: { questionNumber: '2', pages: [0], text: 'x', hasDiagram: false, diagramDescription: '', illegibleCount: 0, confidence: 0.9, origin: 'ai' as const, editedAt: null, textHash: 'c'.repeat(64) },
    allowHalfMarks: true,
    lowConfidenceThreshold: 0.6,
    by: { providerId: 'mock' as const, model: 'mock-vision' },
    cacheKey: 'k',
    nowIso: '2026-11-25T10:00:00Z',
  };
  const question = q('2', '2', 5, { markingPoints: [{ id: 'p1', description: 'method', marks: 3 }, { id: 'p2', description: 'answer', marks: 2 }] });

  it('clamps per criterion and never exceeds max marks', () => {
    const r = scoreQuestion({ ...base, question, result: { q: '2', criteria: [{ id: 'p1', awarded: 9, comment: '' }, { id: 'p2', awarded: 1.74, comment: '' }], correct: [], missing: [], feedback: '', confidence: 0.9, review: false, reviewReason: '' } });
    expect(r.criteria.map((c) => c.awarded)).toEqual([3, 1.5]);
    expect(r.recommendedMarks).toBe(4.5);
    expect(r.flags).toContain('marks_clamped');
    expect(r.status).toBe('needs_review');
  });

  it("keeps the AI's review reason out of the student's feedback", () => {
    const r = scoreQuestion({ ...base, question, result: { q: '2', criteria: [{ id: 'p1', awarded: 3, comment: '' }, { id: 'p2', awarded: 2, comment: '' }], correct: [], missing: [], feedback: 'Well done.', confidence: 0.9, review: true, reviewReason: 'Second page may belong to Q3' } });
    expect(r.feedback).toBe('Well done.');
    expect(r.reviewNote).toBe('Second page may belong to Q3');
    expect(r.flags).toContain('model_flagged');
  });

  it('marks low confidence as Needs Review', () => {
    const r = scoreQuestion({ ...base, question, result: { q: '2', criteria: [{ id: 'p1', awarded: 3, comment: '' }, { id: 'p2', awarded: 2, comment: '' }], correct: [], missing: [], feedback: '', confidence: 0.55, review: false, reviewReason: '' } });
    expect(r.recommendedMarks).toBe(5);
    expect(r.status).toBe('needs_review');
    expect(r.flags).toContain('low_confidence');
  });

  it('scales when marking points do not add up to max marks, and respects whole-marks mode', () => {
    const odd = q('2', '2', 10, { markingPoints: [{ id: 'p1', description: 'a', marks: 2 }, { id: 'p2', description: 'b', marks: 3 }] });
    const r = scoreQuestion({ ...base, allowHalfMarks: false, question: odd, result: { q: '2', criteria: [{ id: 'p1', awarded: 2, comment: '' }, { id: 'p2', awarded: 1, comment: '' }], correct: [], missing: [], feedback: '', confidence: 0.9, review: false, reviewReason: '' } });
    expect(r.recommendedMarks).toBe(6); // (3/5)×10
    expect(r.status).toBe('recommended');
  });

  it('treats a missing criterion as 0 and flags it', () => {
    const r = scoreQuestion({ ...base, question, result: { q: '2', criteria: [{ id: 'p1', awarded: 3, comment: '' }], correct: [], missing: [], feedback: '', confidence: 0.95, review: false, reviewReason: '' } });
    expect(r.recommendedMarks).toBe(3);
    expect(r.flags).toContain('low_confidence');
  });
});
