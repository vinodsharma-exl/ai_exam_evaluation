/**
 * Screen 5: Processing (AI Analysis). Live step list, progress bar, rate-limit countdown, pause,
 * resume and cancel, requests used today, and the manual-entry fallback when no vision model is available.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, Clock, FileSearch, Info, Keyboard, Loader2, Pause, Play, Square, XCircle, MinusCircle } from 'lucide-react';
import type { AppEvents } from '../../shared/ipc';
import type { Task } from '../../shared/schemas/jobs';
import type { AppErrorData, ErrorCode } from '../../shared/errors';
import { api, call } from '../lib/api';
import { useAction, useAppEvent, useAsync, useCountdown } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDuration } from '../lib/format';
import { Button, Card, Loading, PageHeader, ProgressBar, cx } from '../components/ui';
import { Stepper } from '../components/Stepper';
import { ErrorBanner } from '../components/ErrorBanner';
import { EstimateDialog, UsageMeter } from '../components/Usage';
import { ManualEntryModal } from '../components/ManualEntry';
import { useTitle } from '../components/Shell';

type Progress = AppEvents['job:progress'];

function taskLabel(t: Task): string {
  switch (t.kind) {
    case 'render_pages':
      return 'Preparing page images';
    case 'ocr_pages': {
      const a = (t.pages[0] ?? 0) + 1;
      const b = (t.pages[t.pages.length - 1] ?? 0) + 1;
      return `Extracting handwritten text (page${a === b ? ` ${a}` : `s ${a}–${b}`})`;
    }
    case 'merge_answers':
      return 'Identifying questions';
    case 'evaluate_questions':
      return `Evaluating answers using AI (${t.questions.map((q) => `Q${q}`).join(', ')})`;
    case 'finalize_totals':
      return 'Calculating totals';
  }
}

const STATUS_TEXT: Record<Task['status'], string> = {
  pending: 'Pending',
  running: 'In progress…',
  done: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  superseded: 'Split into smaller requests',
};

export function Processing({ examId, studentId }: { examId: string; studentId: string }) {
  useTitle('Processing');
  const { go } = useRouter();
  const { config, toast } = useApp();
  const bundle = useAsync(() => call(api.getStudentBundle(examId, studentId)), [examId, studentId]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [manual, setManual] = useState(false);
  const [estimate, setEstimate] = useState(false);
  const act = useAction();
  const sawRunning = useRef(false);

  useAppEvent('job:progress', (p) => {
    if (p.examId !== examId || p.studentId !== studentId) return;
    setProgress(p);
    if (p.state === 'running' || p.state === 'waiting_rate_limit') sawRunning.current = true;
    void bundle.reload();
  });

  const job = bundle.data?.jobs ?? null;
  const state = progress?.state ?? job?.state ?? 'idle';
  const running = state === 'running' || state === 'waiting_rate_limit';
  const countdown = useCountdown(state === 'waiting_rate_limit' ? progress?.resumeAt ?? null : null);

  // Arrived here and finished: move on to results (only if we watched it run).
  useEffect(() => {
    if (state === 'completed' && sawRunning.current) {
      const t = setTimeout(() => go({ name: 'results', examId, studentId }), 1200);
      return () => clearTimeout(t);
    }
  }, [state, examId, studentId, go]);

  const tasks = useMemo(() => (job?.tasks ?? []).filter((t) => t.status !== 'superseded'), [job]);
  const done = tasks.filter((t) => ['done', 'skipped', 'failed'].includes(t.status)).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  // The latest error: from a live event, or from the job file (after a restart).
  const error: AppErrorData | null = useMemo(() => {
    if (progress?.error) return progress.error;
    if (state === 'paused' || state === 'failed') {
      const failed = [...tasks].reverse().find((t) => t.lastError);
      // jobs.json stores the code as a plain string; it is always one of ours.
      return failed?.lastError ? ({ ...failed.lastError, code: failed.lastError.code as ErrorCode } satisfies AppErrorData) : null;
    }
    return null;
  }, [progress, state, tasks]);

  const pagesNeedingText = (bundle.data?.extraction?.pages ?? []).filter((p) => p.ocr.status === 'pending' || p.ocr.status === 'failed');

  const resume = () => act.run(() => call(api.resume(examId, studentId)));
  const startOrResume = async () => {
    if (!job || job.state === 'idle') {
      if (config?.ui.confirmBeforeProcessing) return setEstimate(true);
      await act.run(() => call(api.startProcessing(examId, studentId)));
    } else await resume();
  };

  const current = tasks.find((t) => t.status === 'running');
  const pageNow = current?.kind === 'ocr_pages' ? (current.pages[current.pages.length - 1] ?? 0) + 1 : null;
  const totalPages = bundle.data?.extraction?.pages.length ?? 0;

  return (
    <>
      <PageHeader
        title="Processing Answer Sheet"
        subtitle={`${bundle.data?.student.displayId ?? ''}${bundle.data?.student.name ? ` · ${bundle.data.student.name}` : ''}: AI is reading and analysing the handwritten answers.`}
      />
      <Stepper current={2} />
      {bundle.loading && !bundle.data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
          <Card>
            <div className="space-y-5">
              <ul className="space-y-3">
                {tasks.length === 0 && <li className="text-sm text-slate-500">Not started yet.</li>}
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 text-sm">
                    <TaskIcon status={t.status} waiting={t.status === 'running' && state === 'waiting_rate_limit'} />
                    <span className={cx('flex-1', t.status === 'pending' && 'text-slate-500')}>
                      {taskLabel(t)}
                      {t.cacheHit && <span className="ml-2 text-xs text-slate-400">(from cache, free)</span>}
                    </span>
                    <span className={cx('text-xs', t.status === 'done' ? 'text-green-600' : t.status === 'running' ? 'text-brand-600' : t.status === 'failed' ? 'text-red-600' : 'text-slate-400')}>
                      {t.status === 'running' && state === 'waiting_rate_limit' ? 'Waiting for rate limit' : STATUS_TEXT[t.status]}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="flex items-center gap-3">
                <ProgressBar value={pct} tone={state === 'paused' ? 'orange' : state === 'completed' ? 'green' : 'blue'} />
                <span className="w-10 text-right text-sm font-medium">{pct}%</span>
              </div>

              {state === 'waiting_rate_limit' && countdown > 0 && (
                <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                  <Clock className="h-4 w-4" /> Waiting for rate limit, resuming in {fmtDuration(countdown)}. Your free plan allows only a few requests per minute.
                </p>
              )}
              {running && state !== 'waiting_rate_limit' && (
                <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                  <Info className="h-4 w-4" /> This may take a few minutes depending on the number of pages. You can leave this screen; work continues in the background.
                </p>
              )}

              <ErrorBanner error={error} handlers={{ onRetry: () => void resume(), onEnterManually: pagesNeedingText.length ? () => setManual(true) : undefined }} />
              <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />

              {running && (
                <div className="flex flex-col items-center gap-2 py-4 text-slate-500">
                  <FileSearch className="h-14 w-14 text-brand-600" />
                  <p className="text-sm">{pageNow ? `Analyzing page ${pageNow} of ${totalPages}…` : progress?.currentLabel || 'Working…'}</p>
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4 dark:border-slate-800">
                {running && (
                  <>
                    <Button variant="secondary" icon={<Pause className="h-4 w-4" />} onClick={() => void act.run(() => call(api.pause(examId, studentId))).then(() => toast('Pausing after the current step…', 'info'))}>
                      Pause
                    </Button>
                    <Button variant="ghost" icon={<Square className="h-4 w-4" />} onClick={() => void act.run(() => call(api.cancel(examId, studentId)))}>
                      Cancel
                    </Button>
                  </>
                )}
                {!running && state !== 'completed' && pagesNeedingText.length > 0 && error?.code === 'MODEL_NO_VISION' && (
                  <Button variant="secondary" icon={<Keyboard className="h-4 w-4" />} onClick={() => setManual(true)}>
                    Type page text ({pagesNeedingText.length})
                  </Button>
                )}
                {!running && state !== 'completed' && (
                  <Button icon={<Play className="h-4 w-4" />} busy={act.busy} onClick={() => void startOrResume()}>
                    {!job || job.state === 'idle' ? 'Start' : 'Resume'}
                  </Button>
                )}
                {state === 'completed' && <Button onClick={() => go({ name: 'results', examId, studentId })}>View results</Button>}
              </div>
            </div>
          </Card>

          <div className="space-y-6">
            <Card title="Free-tier usage">
              <UsageMeter />
              <p className="mt-3 text-xs text-slate-500">If the daily limit runs out, work pauses and continues tomorrow from exactly where it stopped. Finished pages are never sent again.</p>
            </Card>
            <Card title="Tips">
              <ul className="list-disc space-y-1 pl-4 text-sm text-slate-600 dark:text-slate-400">
                <li><strong>Pause</strong> waits for the current request to finish, so nothing you've paid for is lost.</li>
                <li>You can close the app; press Resume next time.</li>
                <li>No vision model? Type the page text and grading still works.</li>
              </ul>
            </Card>
          </div>
        </div>
      )}

      {bundle.data?.extraction && (
        <ManualEntryModal
          open={manual}
          onClose={() => setManual(false)}
          examId={examId}
          studentId={studentId}
          pages={bundle.data.extraction.pages}
          startPage={pagesNeedingText[0]?.index ?? 0}
          onSaved={() => void bundle.reload()}
        />
      )}
      <EstimateDialog
        open={estimate}
        targets={[{ examId, studentId }]}
        onClose={() => setEstimate(false)}
        onConfirm={() => {
          setEstimate(false);
          void act.run(() => call(api.startProcessing(examId, studentId)));
        }}
      />
    </>
  );
}

function TaskIcon({ status, waiting }: { status: Task['status']; waiting: boolean }) {
  if (status === 'done') return <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />;
  if (status === 'running') return waiting ? <Clock className="h-5 w-5 shrink-0 text-amber-500" /> : <Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-600" />;
  if (status === 'failed') return <XCircle className="h-5 w-5 shrink-0 text-red-600" />;
  if (status === 'skipped') return <MinusCircle className="h-5 w-5 shrink-0 text-slate-400" />;
  return <Circle className="h-5 w-5 shrink-0 text-slate-300" />;
}
