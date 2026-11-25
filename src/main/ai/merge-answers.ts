/**
 * Deterministic (no AI) stitching of per-page OCR fragments into one answer per question.
 *
 * Walk pages in order and fragments in order:
 *   - a labelled fragment starts or continues that question ("current")
 *   - an unlabelled fragment continues "current" (an answer spanning pages)
 *   - text before any label, rough work and unknown labels go to "unassigned" for the professor
 *   - a question answered in two places ("Q2 … Q5 … Q2 contd.") is joined with a marker
 * Answers the professor edited (origin manual / ai_edited) are never overwritten.
 */
import { createHash } from 'node:crypto';
import type { ExamFile } from '../../shared/schemas/exam';
import type { ExtractionFile, ExtractionPage, MergedAnswer, PageFragment } from '../../shared/schemas/extraction';
import { normalizeQuestionNumber } from '../../shared/schemas/common';

export const textHash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface MergeResult {
  answers: MergedAnswer[];
  notAttempted: string[];
  unassigned: Array<{ page: number; text: string }>;
  unknownQuestionNumbers: string[];
}

/** Maps what the student or the AI wrote to an exam question number, or null. */
export function resolveQuestion(raw: string, exam: Pick<ExamFile, 'questions'>): string | null {
  const n = normalizeQuestionNumber(raw);
  const numbers = exam.questions.map((q) => q.number);
  if (numbers.includes(n)) return n;
  // "3.b" or "3-b" written differently but normalising the same is handled above. Also try dropping
  // a trailing roman part the exam doesn't have ("2a.i" → "2a").
  const base = n.replace(/\.[ivx]+$/, '');
  if (base !== n && numbers.includes(base)) return base;
  return null;
}

export function mergeAnswers(exam: ExamFile, pages: ExtractionPage[], previous: MergedAnswer[], nowIso: string): MergeResult {
  type Acc = { pages: number[]; parts: string[]; diagrams: string[]; illegible: number; conf: number };
  const acc = new Map<string, Acc>();
  const unassigned: MergeResult['unassigned'] = [];
  const unknown = new Set<string>();
  let current: string | null = null;
  let lastAppended: string | null = null;

  const add = (q: string, page: number, f: PageFragment) => {
    let a = acc.get(q);
    if (!a) acc.set(q, (a = { pages: [], parts: [], diagrams: [], illegible: 0, conf: 1 }));
    if (!a.pages.includes(page)) a.pages.push(page);
    const text = f.text.trim();
    if (text) {
      // Returning to a question after answering another one: mark it so the grader sees the jump.
      if (a.parts.length > 0 && lastAppended !== q) a.parts.push('[continued later in the sheet]');
      a.parts.push(text);
    }
    if (f.diagramDescription.trim()) a.diagrams.push(f.diagramDescription.trim());
    a.illegible += f.illegibleCount;
    a.conf = Math.min(a.conf, f.confidence);
    lastAppended = q;
  };

  const ordered = [...pages].sort((a, b) => a.index - b.index);
  for (const page of ordered) {
    if (page.ocr.status === 'blank' || page.ocr.status === 'skipped') continue;
    for (const f of page.fragments) {
      const raw = f.questionNumber;
      if (raw && raw.toLowerCase() === 'rough') {
        if (f.text.trim()) unassigned.push({ page: page.index, text: `[rough work] ${f.text.trim()}` });
        continue;
      }
      if (raw && !f.continued) {
        const q = resolveQuestion(raw, exam);
        if (q) {
          current = q;
          add(q, page.index, f);
        } else {
          unknown.add(raw);
          current = null; // don't glue later text onto the wrong question
          if (f.text.trim()) unassigned.push({ page: page.index, text: `[written as "${raw}"] ${f.text.trim()}` });
        }
        continue;
      }
      // Unlabelled or explicitly continued.
      if (current) add(current, page.index, f);
      else if (f.text.trim()) unassigned.push({ page: page.index, text: f.text.trim() });
    }
  }

  const prevByQ = new Map(previous.map((a) => [a.questionNumber, a]));
  const answers: MergedAnswer[] = [];
  for (const q of exam.questions) {
    const prev = prevByQ.get(q.number);
    if (prev && prev.origin !== 'ai') {
      answers.push(prev); // the professor's text wins
      continue;
    }
    const a = acc.get(q.number);
    if (!a) continue;
    const text = a.parts.join('\n');
    const diagram = a.diagrams.join('; ');
    answers.push({
      questionNumber: q.number,
      pages: a.pages,
      text,
      hasDiagram: a.diagrams.length > 0,
      diagramDescription: diagram,
      illegibleCount: a.illegible,
      confidence: a.conf,
      origin: 'ai',
      editedAt: prev?.editedAt ?? null,
      textHash: textHash(text + '\u0000' + diagram),
    });
  }
  const answered = new Set(answers.filter((a) => a.text.trim() || a.diagramDescription.trim()).map((a) => a.questionNumber));
  void nowIso;
  return {
    answers,
    notAttempted: exam.questions.filter((q) => !answered.has(q.number)).map((q) => q.number),
    unassigned,
    unknownQuestionNumbers: [...unknown],
  };
}

/**
 * Manual entry for a page (fallback when no vision model is available). Lines that start with a
 * question label begin a new answer, e.g.
 *     Q1 (a) A stack is ...
 *     2. Total = 5 - 3 = 2
 *     Ans 3(b): ...
 * Text before the first label continues the previous page's answer.
 */
/**
 * A label is a number followed by sub-parts that are bracketed "(a)", attached "1a"/"1.a", or dotted
 * numbers "1.2". A sub-part separated by a space must be bracketed, so "Q1 A stack…" doesn't swallow "A".
 */
const LABEL = String.raw`\d+(?:\s*\(\s*[a-z]{1,4}\s*\)|\.?[a-z]{1,3}(?![a-z])|\.\d+)*`;
/** With a "Q"/"Ans"/"Question" prefix the separator is optional: "Q2 5 - 3 = 2". */
const PREFIXED_LABEL = new RegExp(String.raw`^\s*(?:q\.?\s*no\.?|question|ques|answer|ans|q)\.?\s*(${LABEL})\s*[).:\-–]?\s*(.*)$`, 'i');
/** A bare number needs a separator: "2. …", "2) …", "1(b): …". Plain maths lines are not labels. */
const BARE_LABEL = new RegExp(String.raw`^\s*(${LABEL})\s*[).:\-–]\s*(.*)$`, 'i');

export function parseManualPageText(text: string, exam: Pick<ExamFile, 'questions'>): PageFragment[] {
  const fragments: PageFragment[] = [];
  let cur: PageFragment | null = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = line.match(PREFIXED_LABEL) ?? line.match(BARE_LABEL);
    const q = m ? resolveQuestion(m[1]!, exam) : null;
    if (m && q) {
      cur = { questionNumber: q, continued: false, text: m[2] ?? '', hasDiagram: false, diagramDescription: '', illegibleCount: 0, confidence: 1 };
      fragments.push(cur);
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + line;
    } else if (line.trim()) {
      cur = { questionNumber: null, continued: true, text: line, hasDiagram: false, diagramDescription: '', illegibleCount: 0, confidence: 1 };
      fragments.push(cur);
    }
  }
  for (const f of fragments) {
    f.text = f.text.trim();
    f.illegibleCount = (f.text.match(/\[illegible\]/gi) ?? []).length;
  }
  return fragments;
}

/** Empty extraction file with pages and nothing read yet. */
export function emptyExtraction(examId: string, studentId: string, pages: ExtractionPage[], nowIso: string): ExtractionFile {
  return {
    schemaVersion: 1,
    examId,
    studentId,
    pages,
    answers: [],
    notAttempted: [],
    unassigned: [],
    unknownQuestionNumbers: [],
    mergedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
