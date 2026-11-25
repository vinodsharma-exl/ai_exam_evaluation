/**
 * Offline demo provider. It reads our own prompts and returns plausible, deterministic answers, so
 * the whole app (upload → OCR → grading → review → report) can be tried without internet or a key.
 * It never looks at image contents.
 */
import type { CompletionRequest, CompletionResponse, ProviderAdapter, ProviderInfo } from '../../../shared/providers/types';
import { abortableSleep } from '../backoff';
import { findBalancedJson } from '../json-repair';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const SAMPLE_SENTENCES = [
  'The definition is stated clearly with the key term.',
  'An example is given to support the explanation.',
  'The student explains the main steps in order.',
  'Units are written with the final value.',
  'A short conclusion summarises the idea.',
];

export class MockAdapter implements ProviderAdapter {
  constructor(
    readonly info: ProviderInfo,
    private readonly latencyMs = 250,
  ) {}

  async complete(req: CompletionRequest, ctx: { signal: AbortSignal }): Promise<CompletionResponse> {
    await abortableSleep(this.latencyMs, ctx.signal);
    const out = this.respond(req);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    return { text, finishReason: 'stop', usage: { inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) } };
  }

  private respond(req: CompletionRequest): unknown {
    const s = req.system;
    if (req.user.includes('What word is written in the image')) return { word: 'TEST' };
    if (req.user.startsWith('Reply with {"ok":true}')) return { ok: true };
    if (s.startsWith('You fix malformed JSON')) {
      const bad = req.user.split('JSON to fix:\n')[1] ?? '{}';
      return findBalancedJson(bad) ?? '{}';
    }
    if (s.startsWith('You extract the questions')) return this.questionPaper();
    if (s.startsWith('You extract a model answer')) return this.modelAnswer(s);
    if (s.startsWith('You transcribe')) return this.ocr(s, req.user);
    if (s.startsWith('You recommend marks')) return this.evaluate(req.user);
    return { ok: true };
  }

  private questionPaper() {
    return {
      questions: [
        { label: '1(a)', text: 'Define a stack and state its main property.', maxMarks: 2, type: 'theory', confidence: 0.95 },
        { label: '1(b)', text: 'Explain push and pop with an example.', maxMarks: 3, type: 'theory', confidence: 0.92 },
        { label: '2', text: 'A queue holds 5 items and 3 are removed. How many remain? Show working.', maxMarks: 5, type: 'numerical', confidence: 0.9 },
      ],
      choiceRules: [],
      totalMarks: 10,
      notes: 'Demo data from the offline mock provider.',
    };
  }

  private modelAnswer(system: string) {
    const block = system.split('Exam questions (label: max marks):\n')[1]?.split('\nRules:')[0] ?? '';
    const qs = block
      .split('\n')
      .map((l) => l.match(/^(.+?):\s*([\d.]+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => ({ label: m[1]!.trim(), max: Number(m[2]) }));
    return {
      answers: qs.map((q) => {
        const first = Math.ceil(q.max / 2);
        return {
          label: q.label,
          modelAnswer: `Model answer for ${q.label}: states the key definition, explains it, and gives an example.`,
          finalAnswer: '',
          markingPoints: [
            { description: 'Correct definition / key idea', marks: first },
            ...(q.max - first > 0 ? [{ description: 'Explanation or example', marks: q.max - first }] : []),
          ],
          expectsDiagram: false,
          confidence: 0.9,
        };
      }),
      notes: '',
    };
  }

  private ocr(system: string, user: string) {
    const labels = (system.match(/Exam question labels: (.*)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const m = user.match(/pages (\d+)-(\d+) of (\d+)/);
    const from = Number(m?.[1] ?? 1);
    const to = Number(m?.[2] ?? from);
    const total = Number(m?.[3] ?? to);
    const perPage = Math.max(1, Math.ceil(labels.length / total));
    const pages = [];
    for (let p = from; p <= to; p++) {
      const mine = labels.slice((p - 1) * perPage, p * perPage);
      const fragments = [];
      if (p > 1) {
        // Top of page continues the previous answer.
        fragments.push({ q: null, continued: true, text: 'continued: ' + SAMPLE_SENTENCES[p % SAMPLE_SENTENCES.length], diagram: '', illegible: 0, confidence: 0.85 });
      }
      for (const label of mine) {
        const h = hash(label);
        const n = 2 + (h % 3);
        const text = Array.from({ length: n }, (_, i) => SAMPLE_SENTENCES[(h + i) % SAMPLE_SENTENCES.length]).join('\n');
        const illegible = h % 5 === 0 ? 1 : 0;
        fragments.push({
          q: label,
          continued: false,
          text: illegible ? `${text}\nThe value is [illegible].` : text,
          diagram: h % 7 === 0 ? 'Box diagram with arrows labelled push and pop' : '',
          illegible,
          confidence: illegible ? 0.65 : 0.9,
        });
      }
      pages.push({ page: p, blank: false, fragments, note: '' });
    }
    return { pages };
  }

  private evaluate(user: string) {
    const items = user.split('\n---\n');
    return {
      results: items.map((item) => {
        const head = item.match(/^Q (\S+) \| max ([\d.]+)/m);
        const label = head?.[1] ?? '?';
        const criteriaBlock = item.split('Criteria:\n')[1]?.split('\nStudent answer:')[0] ?? '';
        const criteria = [...criteriaBlock.matchAll(/^(\S+) \(([\d.]+)\):/gm)].map((c) => ({ id: c[1]!, max: Number(c[2]) }));
        const answer = item.split('<<<\n')[1]?.split('\n>>>')[0] ?? '';
        const blank = !answer.trim() || answer.trim() === '(blank)';
        const h = hash(label + answer.length);
        const ratio = blank ? 0 : 0.5 + (h % 5) / 10; // 0.5 … 0.9
        const conf = blank ? 0.95 : h % 6 === 0 ? 0.55 : 0.85;
        return {
          q: label,
          criteria: criteria.map((c) => ({ id: c.id, awarded: Math.round(c.max * ratio * 2) / 2, comment: ratio >= 0.7 ? 'Mostly covered' : 'Partly covered' })),
          correct: blank ? [] : ['Key idea identified'],
          missing: ratio < 0.9 ? ['More detail or an example needed'] : [],
          feedback: blank ? 'No answer was written.' : 'Good start; add more precise detail to earn full marks.',
          confidence: conf,
          review: conf < 0.6,
          reviewReason: conf < 0.6 ? 'Demo: low confidence example' : '',
        };
      }),
    };
  }
}
