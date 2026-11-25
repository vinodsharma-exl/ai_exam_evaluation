/**
 * Question paper and model answer: upload (handwritten OK), then AI extraction into an editable proposal.
 *
 * Cheapest route first:
 *   - typed PDF with a text layer → text prompt to the EVALUATION model (no vision request at all)
 *   - scans and photos → vision prompt to the OCR model, pages in groups
 *   - pasted text → text prompt
 * The result is returned as a PROPOSAL. Nothing changes in exam.json until the professor saves the table.
 */
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { ChoiceRule, ExamFile, Question, SourceExtractionFile } from '../../shared/schemas/exam';
import type { ModelAnswerOutput, QuestionPaperOutput } from '../../shared/schemas/ai-output';
import type { ModelRef } from '../../shared/schemas/common';
import type { ExtractionProposal } from '../../shared/ipc';
import { normalizeQuestionNumber } from '../../shared/schemas/common';
import { IMAGE_QUALITY_PRESETS, SCHEMA_VERSIONS, CONTEXT_FILL_RATIO } from '../../shared/constants';
import { buildModelAnswerPrompt, buildQuestionPaperPrompt } from '../../shared/prompts/templates';
import { round2 } from '../../shared/grading-math';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from '../store/file-store';
import type { ExamRepo } from '../store/exam-repo';
import type { ConfigService } from '../store/config-service';
import type { RenderHost } from '../pdf/render-host';
import { detectKind, renderOptions } from '../pages/page-service';
import { estimateTokens, ocrGroupSize } from '../jobs/job-planner';
import type { AiClient } from './ai-client';
import { hashImage } from './ai-client';
import { sha256 } from './response-cache';

export type SourceDocKey = 'questionPaper' | 'modelAnswer';
const PREFIX: Record<SourceDocKey, 'qp' | 'ma'> = { questionPaper: 'qp', modelAnswer: 'ma' };
/** Average characters per page above which a PDF counts as typed (text layer is used, no vision). */
const TYPED_PAGE_CHARS = 150;

export class ExamSourceService {
  constructor(
    private readonly store: FileStore,
    private readonly exams: ExamRepo,
    private readonly config: ConfigService,
    private readonly render: RenderHost,
    private readonly ai: AiClient,
  ) {}

  private async readSourceFile(examId: string): Promise<SourceExtractionFile> {
    return (
      (await this.store.read('sourceExtraction', P.sourceExtractionFile(examId))) ?? {
        schemaVersion: SCHEMA_VERSIONS.sourceExtraction,
        examId,
        documents: { questionPaper: null, modelAnswer: null },
        updatedAt: new Date().toISOString(),
      }
    );
  }

  /** Stores the files, renders the pages and reads any text layer. Replaces earlier files for this document. */
  async attach(examId: string, doc: SourceDocKey, filePaths: string[]): Promise<ExamFile> {
    if (filePaths.length === 0) throw new AppError('VALIDATION', 'Choose at least one file.');
    const exam = await this.exams.getExam(examId);
    const prefix = PREFIX[doc];
    const quality = (await this.config.get()).imageQuality;
    // Clear previous renders of this document.
    for (const f of await this.store.listFiles(`${P.examSourceDir(examId)}/pages`)) {
      if (f.startsWith(`${prefix}_`)) await this.store.remove(`${P.examSourceDir(examId)}/pages/${f}`);
    }
    const pages: NonNullable<SourceExtractionFile['documents']['questionPaper']>['pages'] = [];
    const names: string[] = [];
    for (const [u, path] of filePaths.entries()) {
      const bytes = new Uint8Array(await fs.readFile(path));
      const kind = detectKind(bytes, path);
      names.push(basename(path));
      await this.store.writeBytes(P.sourceUploadFile(examId, prefix, u, kind), bytes);
      await this.render.withDocument(bytes, kind === 'pdf' ? 'pdf' : 'image', async (d) => {
        const texts = kind === 'pdf' ? await d.text() : [];
        for (let i = 0; i < d.pageCount; i++) {
          const r = await d.render(i, renderOptions(quality, 0));
          const idx = pages.length;
          const rel = P.sourcePageImage(examId, prefix, idx);
          await this.store.writeBytes(rel, r.jpeg);
          pages.push({ index: idx, file: rel.slice(P.examDir(examId).length + 1), sha256: sha256(r.jpeg), text: texts[i] ?? '' });
        }
      });
    }
    // One combined PDF for reference (source/question_paper.pdf or model_answer.pdf).
    const pdf = await PDFDocument.create();
    for (const p of pages) {
      const img = await pdf.embedJpg(await this.store.readBytes(P.sourcePageImage(examId, prefix, p.index)));
      const pg = pdf.addPage([595, (img.height / img.width) * 595]);
      pg.drawImage(img, { x: 0, y: 0, width: 595, height: (img.height / img.width) * 595 });
    }
    const pdfRel = doc === 'questionPaper' ? P.questionPaperPdf(examId) : P.modelAnswerPdf(examId);
    await this.store.writeBytes(pdfRel, await pdf.save());

    const src = await this.readSourceFile(examId);
    src.documents[doc] = { pages, rawOutput: null, cacheKeys: [] };
    src.updatedAt = new Date().toISOString();
    await this.store.write('sourceExtraction', P.sourceExtractionFile(examId), src);

    const allImages = filePaths.every((p) => /\.(jpe?g|png)$/i.test(p));
    const updated: ExamFile = {
      ...exam,
      sources: {
        ...exam.sources,
        [doc]: {
          kind: allImages ? 'images' : 'pdf',
          file: pdfRel.slice(P.examDir(examId).length + 1),
          originalFileNames: names,
          pageCount: pages.length,
          extractedWith: null,
          extractedAt: null,
        },
      },
    };
    return (await this.exams.saveExam(updated)).exam;
  }

  /** Runs AI extraction on the attached document, or on pasted text. Returns an editable proposal. */
  async extract(
    examId: string,
    doc: SourceDocKey,
    opts: { signal: AbortSignal; onWaiting?: (t: number | null) => void; pastedText?: string },
  ): Promise<ExtractionProposal> {
    const exam = await this.exams.getExam(examId);
    const cfg = await this.config.get();
    if (doc === 'modelAnswer' && exam.questions.length === 0) {
      throw new AppError('EXAM_NOT_READY', 'Add the questions first (extract the question paper or type them), then the model answer.');
    }
    const src = await this.readSourceFile(examId);
    const pages = src.documents[doc]?.pages ?? [];
    const typedChars = pages.reduce((n, p) => n + p.text.length, 0);
    const route: ExtractionProposal['route'] = opts.pastedText !== undefined ? 'pasted-text' : pages.length > 0 && typedChars / pages.length >= TYPED_PAGE_CHARS ? 'text-layer' : 'vision';
    if (route === 'vision' && pages.length === 0) throw new AppError('VALIDATION', 'Upload the document first, or paste its text.');

    const outputs: Array<QuestionPaperOutput | ModelAnswerOutput> = [];
    const cacheKeys: string[] = [];
    let requestsUsed = 0;
    const langHint = cfg.grading.languageHint;
    const qList = exam.questions.map((q) => ({ label: q.label, maxMarks: q.maxMarks }));

    const run = async (ref: ModelRef, source: Parameters<typeof buildQuestionPaperPrompt>[0]['source'], images?: ReturnType<typeof hashImage>[]) => {
      if (doc === 'questionPaper') {
        const r = await this.ai.request({ kind: 'question_paper', ref, prompt: buildQuestionPaperPrompt({ languageHint: langHint, source }), images, signal: opts.signal, onWaiting: opts.onWaiting });
        outputs.push(r.output);
        cacheKeys.push(r.cacheKey);
        requestsUsed += r.requestsUsed;
      } else {
        const r = await this.ai.request({ kind: 'model_answer', ref, prompt: buildModelAnswerPrompt({ questions: qList, languageHint: langHint, source }), images, signal: opts.signal, onWaiting: opts.onWaiting });
        outputs.push(r.output);
        cacheKeys.push(r.cacheKey);
        requestsUsed += r.requestsUsed;
      }
    };

    if (route === 'vision') {
      const ref = cfg.stages.ocr;
      const caps = await this.config.capabilities(ref);
      if (!caps.supportsVision) throw new AppError('MODEL_NO_VISION', `${ref.providerId}:${ref.model}. Or paste the text instead.`);
      const size = ocrGroupSize(caps, IMAGE_QUALITY_PRESETS[cfg.imageQuality].pagesPerOcrRequest);
      for (let i = 0; i < pages.length; i += size) {
        const group = pages.slice(i, i + size);
        const images = [];
        for (const p of group) images.push(hashImage(await this.store.readBytes(P.sourcePageImage(examId, PREFIX[doc], p.index)), 'image/jpeg', `Page ${p.index + 1}`));
        await run(ref, { kind: 'images', pageFrom: group[0]!.index + 1, pageTo: group[group.length - 1]!.index + 1, pageTotal: pages.length }, images);
      }
    } else {
      const ref = cfg.stages.evaluation; // text model: cheaper, separate quota
      const caps = await this.config.capabilities(ref);
      const budget = Math.max(1000, Math.floor(caps.contextWindow * CONTEXT_FILL_RATIO) - caps.maxOutputTokens - 600);
      const texts = route === 'pasted-text' ? [opts.pastedText ?? ''] : pages.map((p) => p.text);
      // Pack pages into chunks that fit the model's context.
      let chunk = '';
      for (const t of texts) {
        if (chunk && estimateTokens(chunk + t) > budget) {
          await run(ref, { kind: 'text', text: chunk });
          chunk = '';
        }
        chunk += (chunk ? '\n\n' : '') + t;
      }
      if (chunk.trim()) await run(ref, { kind: 'text', text: chunk });
      else throw new AppError('VALIDATION', 'The text is empty.');
    }

    const now = new Date().toISOString();
    const srcNow = await this.readSourceFile(examId);
    srcNow.documents[doc] = { pages, rawOutput: outputs, cacheKeys };
    srcNow.updatedAt = now;
    await this.store.write('sourceExtraction', P.sourceExtractionFile(examId), srcNow);

    const proposal =
      doc === 'questionPaper'
        ? proposeQuestions(exam, outputs as QuestionPaperOutput[])
        : proposeModelAnswers(exam, outputs as ModelAnswerOutput[]);
    return { ...proposal, requestsUsed, route };
  }
}

/** Merges question-paper outputs (one per page group) into questions, keeping existing model answers. */
export function proposeQuestions(exam: ExamFile, outputs: QuestionPaperOutput[]): Omit<ExtractionProposal, 'requestsUsed' | 'route'> {
  const warnings: string[] = [];
  const byNumber = new Map<string, Question>();
  const existing = new Map(exam.questions.map((q) => [q.number, q]));
  let printedTotal: number | null = null;
  const rules: ChoiceRule[] = [];
  for (const out of outputs) {
    printedTotal ??= out.totalMarks;
    for (const q of out.questions) {
      const number = normalizeQuestionNumber(q.label);
      const prev = byNumber.get(number);
      if (prev) {
        // The same question continued on the next page group.
        prev.text = `${prev.text}\n${q.text}`.trim();
        if (!prev.maxMarks && q.maxMarks) prev.maxMarks = q.maxMarks;
        continue;
      }
      const keep = existing.get(number);
      byNumber.set(number, {
        label: q.label.trim(),
        number,
        order: byNumber.size,
        text: q.text.trim(),
        maxMarks: q.maxMarks ?? keep?.maxMarks ?? 0,
        type: q.type,
        modelAnswer: keep?.modelAnswer ?? '',
        markingPoints: keep?.markingPoints ?? [],
        finalAnswer: keep?.finalAnswer ?? '',
        expectsDiagram: keep?.expectsDiagram ?? false,
        origin: 'ai',
        extractionConfidence: q.confidence,
      });
    }
    for (const r of out.choiceRules) {
      rules.push({ id: `r${rules.length + 1}`, questionNumbers: r.questions.map(normalizeQuestionNumber), countBest: r.countBest, description: r.text });
    }
  }
  const questions = [...byNumber.values()];
  for (const q of questions) {
    if (!q.maxMarks) warnings.push(`Q${q.label}: max marks not found. Please enter them.`);
    if ((q.extractionConfidence ?? 1) < 0.6) warnings.push(`Q${q.label}: low reading confidence. Please check the text.`);
  }
  const sum = round2(questions.reduce((s, q) => s + q.maxMarks, 0));
  if (printedTotal && rules.length === 0 && Math.abs(sum - printedTotal) > 1e-6) {
    warnings.push(`The paper says total ${printedTotal}, but the questions add up to ${sum}. Check max marks or "answer any" rules.`);
  }
  return { questions, choiceRules: rules.length ? rules : exam.choiceRules, warnings };
}

/** Applies model-answer outputs to the exam's existing questions. */
export function proposeModelAnswers(exam: ExamFile, outputs: ModelAnswerOutput[]): Omit<ExtractionProposal, 'requestsUsed' | 'route'> {
  const warnings: string[] = [];
  const questions = exam.questions.map((q) => ({ ...q, markingPoints: [...q.markingPoints] }));
  const byNumber = new Map(questions.map((q) => [q.number, q]));
  const touched = new Set<string>();
  for (const out of outputs) {
    for (const a of out.answers) {
      const n = normalizeQuestionNumber(a.label);
      const q = byNumber.get(n);
      if (!q) {
        warnings.push(`The model answer has "${a.label}", which is not a question in this exam.`);
        continue;
      }
      const first = !touched.has(n);
      touched.add(n);
      q.modelAnswer = first ? a.modelAnswer.trim() : `${q.modelAnswer}\n${a.modelAnswer}`.trim();
      if (a.finalAnswer.trim()) q.finalAnswer = a.finalAnswer.trim();
      const pts = a.markingPoints.map((p) => ({ description: p.description.trim(), marks: p.marks }));
      q.markingPoints = (first ? pts : [...q.markingPoints, ...pts]).map((p, i) => ({ ...p, id: `p${i + 1}` }));
      q.expectsDiagram = q.expectsDiagram || a.expectsDiagram;
      q.origin = 'ai_edited';
      if (a.confidence <= 0.6) warnings.push(`Q${q.label}: the marking points were suggested by the AI (not found in the scheme). Please check them.`);
    }
  }
  for (const q of questions) {
    if (!touched.has(q.number)) warnings.push(`Q${q.label}: no model answer found.`);
    const sum = round2(q.markingPoints.reduce((s, p) => s + p.marks, 0));
    if (q.markingPoints.length && Math.abs(sum - q.maxMarks) > 1e-6) warnings.push(`Q${q.label}: marking points add up to ${sum}, not ${q.maxMarks}.`);
  }
  return { questions, choiceRules: exam.choiceRules, warnings };
}
