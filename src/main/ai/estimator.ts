/**
 * Shown before starting: "~24 requests, about 6 minutes on your free limit, 176 left today".
 * Counts only work that still needs doing: pages already read and unchanged evaluations are free
 * (resume/cache), and blank or manual pages never cost anything.
 */
import type { UsageEstimate } from '../../shared/ipc';
import { IMAGE_QUALITY_PRESETS } from '../../shared/constants';
import { limiterKey } from '../../shared/defaults';
import * as P from '../../shared/paths';
import type { FileStore } from '../store/file-store';
import type { ExamRepo } from '../store/exam-repo';
import type { ConfigService } from '../store/config-service';
import type { UsageLedger } from './usage-ledger';
import { EVAL_OUTPUT_TOKENS_PER_QUESTION, ocrGroupSize, planOcrTasks } from '../jobs/job-planner';

export async function estimateUsage(
  deps: { store: FileStore; exams: ExamRepo; config: ConfigService; ledger: UsageLedger },
  targets: Array<{ examId: string; studentId: string }>,
): Promise<UsageEstimate> {
  const cfg = await deps.config.get();
  const ocrRef = cfg.stages.ocr;
  const evRef = cfg.stages.evaluation;
  const ocrCaps = await deps.config.capabilities(ocrRef);
  const evCaps = await deps.config.capabilities(evRef);
  const group = ocrGroupSize(ocrCaps, IMAGE_QUALITY_PRESETS[cfg.imageQuality].pagesPerOcrRequest);
  const outputCap = Math.max(1, Math.floor((evCaps.maxOutputTokens - 200) / EVAL_OUTPUT_TOKENS_PER_QUESTION));
  const batch = cfg.grading.batchQuestions ? Math.max(1, Math.min(cfg.grading.maxQuestionsPerBatch, outputCap)) : 1;

  let ocr = 0;
  let evaluation = 0;
  let cachedSkips = 0;
  const examCache = new Map<string, number>();
  for (const t of targets) {
    const ext = await deps.store.read('extraction', P.extractionFile(t.examId, t.studentId)).catch(() => null);
    const pages = ext?.pages ?? [];
    const todo = pages.filter((p) => p.ocr.status === 'pending' || p.ocr.status === 'failed').map((p) => p.index);
    cachedSkips += pages.length - todo.length;
    ocr += planOcrTasks(todo, group, ocrRef).length;

    if (!examCache.has(t.examId)) examCache.set(t.examId, (await deps.exams.getExam(t.examId)).questions.length);
    const ev = await deps.store.read('evaluation', P.evaluationFile(t.examId, t.studentId)).catch(() => null);
    // If pages still need reading (or nothing was graded yet), assume every question may need grading.
    const n =
      todo.length > 0 || !ev
        ? examCache.get(t.examId)!
        : ev.questions.filter((q) => q.status === 'pending' || q.status === 'failed').length;
    evaluation += n > 0 ? Math.ceil(n / batch) : 0;
  }

  // Time: each model is paced at its own RPM; stages run one after another.
  const perKey = new Map<string, { requests: number; rpm: number; daily: number | null; provider: typeof ocrRef.providerId }>();
  const addTo = (ref: typeof ocrRef, n: number, rpm: number, daily: number | null) => {
    const k = limiterKey(ref);
    const cur = perKey.get(k) ?? { requests: 0, rpm, daily, provider: ref.providerId };
    cur.requests += n;
    perKey.set(k, cur);
  };
  addTo(ocrRef, ocr, ocrCaps.requestsPerMinute, ocrCaps.dailyLimit);
  addTo(evRef, evaluation, evCaps.requestsPerMinute, evCaps.dailyLimit);

  let minutes = 0;
  const remainingToday: Record<string, number | null> = {};
  let fitsToday = true;
  for (const [k, v] of perKey) {
    minutes += v.requests / v.rpm;
    if (v.daily === null) remainingToday[k] = null;
    else {
      const used = await deps.ledger.usedToday(k, v.provider);
      const exhausted = await deps.ledger.exhaustedUntil(k);
      const left = exhausted ? 0 : Math.max(0, v.daily - used);
      remainingToday[k] = left;
      if (v.requests > left) fitsToday = false;
    }
  }
  return {
    requests: ocr + evaluation,
    byStage: { ocr, evaluation },
    minutes: Math.round(minutes * 10) / 10,
    remainingToday,
    fitsToday,
    cachedSkips,
  };
}
