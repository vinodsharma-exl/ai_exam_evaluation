/**
 * The task handlers the JobRunner executes for each student:
 *
 *   render_pages       check the page images exist; plan OCR for pages not yet read (blank/manual skipped)
 *   ocr_pages          Stage A, vision: one request for a group of pages → fragments per page
 *   merge_answers      local: fragments → one answer per question; plan evaluation for what changed
 *   evaluate_questions Stage B, text only: a batch of questions → per-criterion marks; split on failure
 *   finalize_totals    local: totals (choice rules), student status, search index
 *
 * Every handler writes its results BEFORE returning (see JobRunner). Each request goes through
 * AiClient, which handles rate limits, retries, cache and validation.
 */
import type { ExamFile } from '../../shared/schemas/exam';
import type { EvaluationFile, QuestionEvaluation } from '../../shared/schemas/evaluation';
import type { ExtractionFile, PageFragment } from '../../shared/schemas/extraction';
import type { ModelRef } from '../../shared/schemas/common';
import type { Task } from '../../shared/schemas/jobs';
import { IMAGE_QUALITY_PRESETS, PROMPT_VERSION, SCHEMA_VERSIONS } from '../../shared/constants';
import { buildAnswerOcrPrompt, buildEvaluationPrompt, renderEvaluationItem } from '../../shared/prompts/templates';
import * as P from '../../shared/paths';
import { AppError } from '../../shared/errors';
import type { FileStore } from '../store/file-store';
import type { ExamRepo } from '../store/exam-repo';
import type { ConfigService } from '../store/config-service';
import type { StudentIndex } from '../store/student-index';
import type { JobStore } from '../jobs/job-store';
import type { TaskContext, TaskHandlers, TaskOutcome } from '../jobs/job-runner';
import {
  estimateTokens,
  ocrGroupSize,
  planEvaluationBatches,
  planEvaluationTasks,
  planOcrTasks,
  splitEvaluationTask,
} from '../jobs/job-planner';
import type { AiClient } from './ai-client';
import { hashImage } from './ai-client';
import { mergeAnswers, resolveQuestion } from './merge-answers';
import { findResult, notAttemptedEvaluation, pendingEvaluation, recomputeTotals, scoreQuestion, toEvaluationItem } from './grading';

export interface PipelineDeps {
  store: FileStore;
  exams: ExamRepo;
  config: ConfigService;
  index: StudentIndex;
  jobs: JobStore;
  ai: AiClient;
  now?: () => Date;
}

const NEEDS_OCR = new Set(['pending', 'failed']);

export function createPipeline(d: PipelineDeps): TaskHandlers {
  const iso = () => (d.now ? d.now() : new Date()).toISOString();

  async function load(e: string, s: string) {
    const [exam, extraction] = await Promise.all([d.exams.getExam(e), d.store.read('extraction', P.extractionFile(e, s))]);
    if (!extraction || extraction.pages.length === 0) throw new AppError('VALIDATION', 'Upload the answer sheet first.');
    return { exam, extraction };
  }

  async function grading(exam: ExamFile) {
    const cfg = await d.config.get();
    return {
      strictness: exam.gradingOverrides.strictness ?? cfg.grading.strictness,
      allowHalfMarks: exam.gradingOverrides.allowHalfMarks ?? cfg.grading.allowHalfMarks,
      threshold: cfg.grading.lowConfidenceThreshold,
      batchQuestions: cfg.grading.batchQuestions,
      maxQuestionsPerBatch: cfg.grading.maxQuestionsPerBatch,
      handwritingHint: cfg.grading.handwritingHint,
      languageHint: cfg.grading.languageHint,
      quality: cfg.imageQuality,
      ocr: cfg.stages.ocr,
      evaluation: cfg.stages.evaluation,
    };
  }

  // -------------------------------------------------------------------------------- render_pages
  async function renderPages(task: Task, ctx: TaskContext): Promise<TaskOutcome> {
    const { extraction } = await load(ctx.examId, ctx.studentId);
    for (const p of extraction.pages) {
      if (!(await d.store.exists(P.pageImage(ctx.examId, ctx.studentId, p.index)))) {
        throw new AppError('PDF_RENDER_FAILED', `Page image ${p.index + 1} is missing. Re-upload the sheet.`);
      }
    }
    const todo = extraction.pages.filter((p) => NEEDS_OCR.has(p.ocr.status)).map((p) => p.index);
    if (todo.length === 0) return {};
    const g = await grading(await d.exams.getExam(ctx.examId));
    const caps = await d.config.capabilities(g.ocr);
    if (!caps.supportsVision) throw new AppError('MODEL_NO_VISION', `${g.ocr.providerId}:${g.ocr.model}`);
    const size = ocrGroupSize(caps, IMAGE_QUALITY_PRESETS[g.quality].pagesPerOcrRequest);
    const reason = task.reason === 'plan' ? 'plan' : `${task.reason}-${Date.now().toString(36)}`;
    return { addTasks: planOcrTasks(todo, size, g.ocr, reason) };
  }

  // -------------------------------------------------------------------------------- ocr_pages
  async function ocrPages(task: Task, ctx: TaskContext): Promise<TaskOutcome> {
    const { exam, extraction } = await load(ctx.examId, ctx.studentId);
    const group = task.pages
      .map((i) => extraction.pages[i])
      .filter((p): p is NonNullable<typeof p> => !!p && (NEEDS_OCR.has(p.ocr.status) || task.bypassCache));
    if (group.length === 0) return { status: 'skipped' };
    const g = await grading(exam);
    const ref: ModelRef = g.ocr; // always the current Settings choice

    // Context for answers continuing from earlier pages: last labelled fragment before this group.
    let previousQuestion: string | null = null;
    for (const p of extraction.pages) {
      if (p.index >= group[0]!.index) break;
      for (const f of p.fragments) if (f.questionNumber && f.questionNumber !== 'rough') previousQuestion = f.questionNumber;
    }
    const labelFor = (n: string | null) => (n ? exam.questions.find((q) => q.number === n)?.label ?? n : null);

    const first = group[0]!.index;
    const last = group[group.length - 1]!.index;
    const prompt = buildAnswerOcrPrompt({
      questionLabels: exam.questions.map((q) => q.label),
      previousQuestion: labelFor(previousQuestion),
      pageFrom: first + 1,
      pageTo: last + 1,
      pageTotal: extraction.pages.length,
      handwritingHint: g.handwritingHint,
      languageHint: g.languageHint,
    });
    const images = [];
    for (const p of group) {
      const bytes = await d.store.readBytes(P.pageImage(ctx.examId, ctx.studentId, p.index));
      images.push(hashImage(bytes, 'image/jpeg', `Page ${p.index + 1}`));
    }
    const res = await d.ai.request({
      kind: 'answer_ocr',
      ref,
      prompt,
      images,
      bypassCache: task.bypassCache,
      signal: ctx.signal,
      onWaiting: ctx.setWaiting,
    });

    const now = iso();
    let failures = 0;
    await d.store.update('extraction', P.extractionFile(ctx.examId, ctx.studentId), (cur) => {
      if (!cur) return undefined;
      const pages = cur.pages.map((p) => {
        const k = group.findIndex((x) => x.index === p.index);
        if (k === -1) return p;
        const out =
          res.output.pages.find((o) => o.page === p.index + 1) ??
          (res.output.pages.length === group.length ? res.output.pages[k] : undefined);
        if (!out) {
          failures++;
          return {
            ...p,
            ocr: { ...p.ocr, status: 'failed' as const, by: ref, at: now, error: { code: 'INVALID_AI_JSON', detail: 'This page was missing from the AI reply.', at: now } },
          };
        }
        const fragments: PageFragment[] = out.fragments.map((f) => ({
          questionNumber: f.q === null ? null : f.q.toLowerCase() === 'rough' ? 'rough' : resolveQuestion(f.q, exam) ?? f.q,
          continued: f.q === null ? true : f.continued,
          text: f.text,
          hasDiagram: !!f.diagram.trim(),
          diagramDescription: f.diagram,
          illegibleCount: f.illegible,
          confidence: f.confidence,
        }));
        const words = fragments.reduce((n, f) => n + f.text.split(/\s+/).filter(Boolean).length, 0);
        const illegible = fragments.reduce((n, f) => n + f.illegibleCount, 0);
        const mostlyUnreadable = words > 0 && illegible / words > 0.3;
        return {
          ...p,
          fragments,
          pageNote: mostlyUnreadable ? 'Mostly unreadable: check the scan or type the text.' : out.note.slice(0, 500),
          ocr: {
            status: out.blank && fragments.length === 0 ? ('blank' as const) : ('done' as const),
            by: ref,
            cacheKey: res.cacheKey,
            at: now,
            error: null,
          },
        };
      });
      return { ...cur, pages, updatedAt: now };
    });
    if (failures === group.length) throw new AppError('INVALID_AI_JSON', 'No pages in the AI reply matched the pages sent.');
    return { requestsUsed: res.requestsUsed, cacheHit: res.cacheHit };
  }

  // -------------------------------------------------------------------------------- merge_answers
  async function merge(task: Task, ctx: TaskContext): Promise<TaskOutcome> {
    const { exam, extraction } = await load(ctx.examId, ctx.studentId);
    const now = iso();
    const merged = mergeAnswers(exam, extraction.pages, extraction.answers, now);
    const ext: ExtractionFile = { ...extraction, ...merged, mergedAt: now, updatedAt: now };
    await d.store.write('extraction', P.extractionFile(ctx.examId, ctx.studentId), ext);

    // Evaluation skeleton: keep results whose answer text is unchanged; everything else is pending.
    const g = await grading(exam);
    const prev = await d.store.read('evaluation', P.evaluationFile(ctx.examId, ctx.studentId));
    const prevByQ = new Map((prev?.questions ?? []).map((q) => [q.questionNumber, q]));
    const answerByQ = new Map(merged.answers.map((a) => [a.questionNumber, a]));
    const questions: QuestionEvaluation[] = exam.questions.map((q) => {
      const old = prevByQ.get(q.number);
      if (merged.notAttempted.includes(q.number)) return notAttemptedEvaluation(q, now);
      const a = answerByQ.get(q.number);
      const unchanged = old && a && old.answerTextHash === a.textHash && (old.status === 'recommended' || old.status === 'needs_review');
      if (unchanged && old.maxMarks === q.maxMarks) return old;
      return { ...pendingEvaluation(q), history: old?.history ?? [] };
    });
    const ev: EvaluationFile = {
      schemaVersion: SCHEMA_VERSIONS.evaluation,
      examId: ctx.examId,
      studentId: ctx.studentId,
      settings: { strictness: g.strictness, allowHalfMarks: g.allowHalfMarks, promptVersion: PROMPT_VERSION },
      questions,
      totals: { recommended: 0, max: exam.totalMarks, droppedByChoiceRules: [] },
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    ev.totals = recomputeTotals(exam, ev);
    await d.store.write('evaluation', P.evaluationFile(ctx.examId, ctx.studentId), ev);

    // Plan evaluation for pending questions that no pending task already covers.
    const job = await d.jobs.get(ctx.examId, ctx.studentId);
    const covered = new Set(
      (job?.tasks ?? []).filter((t) => t.kind === 'evaluate_questions' && t.status === 'pending').flatMap((t) => t.questions),
    );
    const pending = exam.questions.filter((q) => questions.find((x) => x.questionNumber === q.number)?.status === 'pending' && !covered.has(q.number));
    if (pending.length === 0) return {};
    const caps = await d.config.capabilities(g.evaluation);
    const sizes = pending.map((q) => ({ number: q.number, tokens: estimateTokens(renderEvaluationItem(toEvaluationItem(q, answerByQ.get(q.number)))) }));
    const batches = planEvaluationBatches(sizes, caps, { batchQuestions: g.batchQuestions, maxQuestionsPerBatch: g.maxQuestionsPerBatch });
    return { addTasks: planEvaluationTasks(batches, g.evaluation, task.reason === 'plan' ? 'plan' : 'rerun') };
  }

  // -------------------------------------------------------------------------------- evaluate_questions
  async function evaluate(task: Task, ctx: TaskContext): Promise<TaskOutcome> {
    const { exam, extraction } = await load(ctx.examId, ctx.studentId);
    const evaluation = await d.store.read('evaluation', P.evaluationFile(ctx.examId, ctx.studentId));
    if (!evaluation) throw new AppError('UNKNOWN', 'Evaluation file missing; answers were not merged.');
    const g = await grading(exam);
    const answerByQ = new Map(extraction.answers.map((a) => [a.questionNumber, a]));
    const evByQ = new Map(evaluation.questions.map((q) => [q.questionNumber, q]));

    const targets = task.questions
      .map((n) => exam.questions.find((q) => q.number === n))
      .filter((q): q is NonNullable<typeof q> => !!q)
      .filter((q) => {
        const cur = evByQ.get(q.number);
        const a = answerByQ.get(q.number);
        if (!a || !(a.text.trim() || a.diagramDescription.trim())) return false; // nothing to grade
        if (task.bypassCache) return true; // explicit re-evaluate
        return !cur || cur.status === 'pending' || cur.status === 'failed' || cur.answerTextHash !== a.textHash;
      });
    if (targets.length === 0) return { status: 'skipped' };

    const items = targets.map((q) => toEvaluationItem(q, answerByQ.get(q.number)));
    const prompt = buildEvaluationPrompt({ items, strictness: g.strictness, allowHalfMarks: g.allowHalfMarks, evaluatorNotes: exam.evaluatorNotes });
    const ref = g.evaluation;

    let res;
    try {
      res = await d.ai.request({ kind: 'evaluation', ref, prompt, bypassCache: task.bypassCache, signal: ctx.signal, onWaiting: ctx.setWaiting });
    } catch (err) {
      const code = err instanceof AppError ? err.code : null;
      if ((code === 'INVALID_AI_JSON' || code === 'CONTEXT_TOO_LONG') && task.questions.length > 1) {
        return { replaceWith: splitEvaluationTask(task) }; // smaller requests next
      }
      if (err instanceof AppError && (code === 'INVALID_AI_JSON' || code === 'CONTEXT_TOO_LONG' || code === 'CONTENT_FILTERED')) {
        await markFailed(ctx, targets.map((q) => q.number), err);
      }
      throw err;
    }

    const now = iso();
    const missing: string[] = [];
    const scored = new Map<string, QuestionEvaluation>();
    for (const q of targets) {
      const r = findResult(res.output.results, q.number, targets.length === 1);
      if (!r) {
        missing.push(q.number);
        continue;
      }
      scored.set(
        q.number,
        scoreQuestion({
          question: q,
          answer: answerByQ.get(q.number),
          result: r,
          allowHalfMarks: g.allowHalfMarks,
          lowConfidenceThreshold: g.threshold,
          by: ref,
          cacheKey: res.cacheKey,
          nowIso: now,
          previous: task.bypassCache ? evByQ.get(q.number) : undefined,
        }),
      );
    }
    await d.store.update('evaluation', P.evaluationFile(ctx.examId, ctx.studentId), (cur) => {
      if (!cur) return undefined;
      const next = {
        ...cur,
        settings: { strictness: g.strictness, allowHalfMarks: g.allowHalfMarks, promptVersion: PROMPT_VERSION },
        questions: cur.questions.map((q) => scored.get(q.questionNumber) ?? q),
        updatedAt: now,
      };
      return { ...next, totals: recomputeTotals(exam, next) };
    });
    const addTasks = missing.length && targets.length > 1 ? splitEvaluationTask({ ...task, id: `${task.id}~missing`, questions: missing }) : undefined;
    if (missing.length && targets.length === 1) throw new AppError('INVALID_AI_JSON', 'The AI reply did not include this question.');
    return { requestsUsed: res.requestsUsed, cacheHit: res.cacheHit, addTasks };
  }

  async function markFailed(ctx: TaskContext, numbers: string[], err: AppError) {
    const now = iso();
    await d.store.update('evaluation', P.evaluationFile(ctx.examId, ctx.studentId), (cur) =>
      cur
        ? {
            ...cur,
            questions: cur.questions.map((q) => (numbers.includes(q.questionNumber) ? { ...q, status: 'failed' as const, error: err.toData() } : q)),
            updatedAt: now,
          }
        : undefined,
    );
  }

  // -------------------------------------------------------------------------------- finalize_totals
  async function finalize(_task: Task, ctx: TaskContext): Promise<TaskOutcome> {
    const { exam, extraction } = await load(ctx.examId, ctx.studentId);
    const now = iso();
    const ev = await d.store.update('evaluation', P.evaluationFile(ctx.examId, ctx.studentId), (cur) =>
      cur ? { ...cur, totals: recomputeTotals(exam, cur), updatedAt: now } : undefined,
    );
    const final = await d.store.read('final', P.finalFile(ctx.examId, ctx.studentId));
    const allBlank = extraction.pages.length > 0 && extraction.pages.every((p) => p.ocr.status === 'blank');
    const reviewNeeded =
      allBlank || // never report an all-blank sheet as simply "Completed"
      !ev ||
      ev.questions.some((q) => q.status === 'needs_review' || q.status === 'failed' || q.status === 'pending') ||
      extraction.pages.some((p) => p.ocr.status === 'failed' || p.ocr.status === 'pending') ||
      extraction.unassigned.length > 0 ||
      extraction.unknownQuestionNumbers.length > 0;
    await d.exams.setStudentStatus(ctx.examId, ctx.studentId, final?.status === 'finalized' ? 'finalized' : reviewNeeded ? 'needs_review' : 'evaluated');
    await d.index.upsert(ctx.examId, ctx.studentId);
    return {};
  }

  return {
    render_pages: renderPages,
    ocr_pages: ocrPages,
    merge_answers: merge,
    evaluate_questions: evaluate,
    finalize_totals: finalize,
  };
}
