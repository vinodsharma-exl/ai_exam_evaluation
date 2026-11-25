/**
 * Screen 6: Results Summary (question-wise), as in the screenshot: total marks card, question table with
 * Good / Partial / Needs Review pills, "Edit All Marks" and "Generate Report".
 * Also shows anything that needs attention: unread pages, unassigned text, answers edited since grading.
 */
import { useState } from 'react';
import { AlertTriangle, FileText, Keyboard, PencilLine, RefreshCw, RotateCcw } from 'lucide-react';
import { api, call } from '../lib/api';
import { useAction, useAppEvent, useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDate, fmtMarks } from '../lib/format';
import { Badge, Button, Card, EmptyState, Loading, Modal, PageHeader } from '../components/ui';
import { Stepper } from '../components/Stepper';
import { ConfidenceText, FlagChips, QuestionStatusBadge, RecommendedTag, StudentStatusBadge } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { ManualEntryModal } from '../components/ManualEntry';
import { useTitle } from '../components/Shell';

export function Results({ examId, studentId }: { examId: string; studentId: string }) {
  useTitle('Results');
  const { go } = useRouter();
  const { toast } = useApp();
  const data = useAsync(async () => {
    const [b, exam] = await Promise.all([call(api.getStudentBundle(examId, studentId)), call(api.getExam(examId))]);
    return { ...b, exam };
  }, [examId, studentId]);
  const [manual, setManual] = useState<number | null>(null);
  const [confirmReeval, setConfirmReeval] = useState(false);
  const act = useAction();

  useAppEvent('job:progress', (p) => {
    if (p.examId === examId && p.studentId === studentId && (p.state === 'completed' || p.state === 'paused')) void data.reload();
  });

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBanner error={data.error} handlers={{ onRetry: data.reload }} />;
  const { student, evaluation, extraction, final, exam, jobs } = data.data!;
  if (!evaluation) {
    return (
      <Card>
        <EmptyState title="No results yet" action={<Button onClick={() => go({ name: 'processing', examId, studentId })}>Go to processing</Button>}>
          This answer sheet hasn't been evaluated yet.
        </EmptyState>
      </Card>
    );
  }

  const isFinal = final?.status === 'finalized';
  const total = isFinal ? final!.total : evaluation.totals.recommended;
  const qByNum = new Map(exam.questions.map((q) => [q.number, q]));
  const edited = evaluation.questions.filter((q) => q.flags.includes('answer_changed_since_evaluation'));
  const pending = evaluation.questions.filter((q) => q.status === 'pending' || q.status === 'failed');
  const badPages = extraction?.pages.filter((p) => p.ocr.status === 'failed' || p.ocr.status === 'pending' || /unreadable/i.test(p.pageNote)) ?? [];
  const blankPages = extraction?.pages.filter((p) => p.ocr.status === 'blank') ?? [];
  const allBlank = !!extraction && extraction.pages.length > 0 && blankPages.length === extraction.pages.length;
  const running = jobs?.state === 'running' || jobs?.state === 'waiting_rate_limit';

  const reevaluateEdited = async () => {
    setConfirmReeval(false);
    // One request per edited question, queued together and run as one job.
    const ok = await act.run(async () => {
      await call(api.reevaluateQuestion(examId, studentId, edited.map((q) => q.questionNumber)));
      return true;
    });
    if (!ok) return;
    toast(`Re-evaluating ${edited.length} question${edited.length === 1 ? '' : 's'}…`, 'info');
    go({ name: 'processing', examId, studentId });
  };

  return (
    <>
      <PageHeader title="Evaluation Results" />
      <Stepper current={3} />
      <div className="mb-6 grid gap-4 lg:grid-cols-[1fr_260px]">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{student.name || student.displayId}</h2>
            <StudentStatusBadge status={student.status} />
          </div>
          <dl className="mt-3 grid grid-cols-[110px_1fr] gap-y-1 text-sm">
            <dt className="text-slate-500">Student ID:</dt>
            <dd className="font-medium">{student.displayId}</dd>
            <dt className="text-slate-500">Exam:</dt>
            <dd>{exam.title}</dd>
            <dt className="text-slate-500">Date:</dt>
            <dd>{fmtDate(exam.examDate ?? evaluation.updatedAt)}</dd>
            <dt className="text-slate-500">Grading:</dt>
            <dd className="capitalize">{evaluation.settings.strictness}{evaluation.settings.allowHalfMarks ? ', half marks allowed' : ', whole marks only'}</dd>
          </dl>
        </Card>
        <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-white p-5 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm text-slate-500">Total Marks</p>
          <p className="mt-1 text-4xl font-bold text-navy-900 dark:text-white">
            {fmtMarks(total)} <span className="text-2xl font-semibold text-slate-400">/ {fmtMarks(evaluation.totals.max)}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">{isFinal ? 'Final (professor)' : '(Recommended)'}</p>
          {evaluation.totals.droppedByChoiceRules.length > 0 && <p className="mt-2 text-xs text-slate-500">Best answers counted; dropped: {evaluation.totals.droppedByChoiceRules.map((q) => `Q${qByNum.get(q)?.label ?? q}`).join(', ')}</p>}
        </div>
      </div>

      {(badPages.length > 0 || blankPages.length > 0 || (extraction?.unassigned.length ?? 0) > 0 || edited.length > 0 || pending.length > 0) && (
        <Card className="mb-6" title={<span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" /> Needs your attention</span>}>
          <ul className="space-y-3 text-sm">
            {allBlank && (
              <li className="rounded-lg bg-red-50 p-3 font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200">
                Every page looked blank, so nothing was read. Check the upload (wrong file, or very faint scan), or read the pages anyway.
              </li>
            )}
            {blankPages.map((p) => (
              <li key={`b${p.index}`} className="flex flex-wrap items-center gap-2">
                <span className="flex-1">Page {p.index + 1} looked blank and was skipped (no request used).</span>
                <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={running} onClick={() => void act.run(() => call(api.rerunOcrPage(examId, studentId, p.index))).then(() => go({ name: 'processing', examId, studentId }))}>
                  Read anyway (1 request)
                </Button>
              </li>
            ))}
            {badPages.map((p) => (
              <li key={p.index} className="flex flex-wrap items-center gap-2">
                <span className="flex-1">Page {p.index + 1}: {p.ocr.error?.detail ?? (p.pageNote || 'not read yet')}</span>
                <Button size="sm" variant="secondary" icon={<Keyboard className="h-3.5 w-3.5" />} onClick={() => setManual(p.index)}>Type text</Button>
                <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={running} onClick={() => void act.run(() => call(api.rerunOcrPage(examId, studentId, p.index))).then(() => go({ name: 'processing', examId, studentId }))}>
                  Read again (1 request)
                </Button>
              </li>
            ))}
            {extraction?.unassigned.map((u, i) => (
              <li key={`u${i}`} className="flex flex-wrap items-start gap-2">
                <span className="flex-1">
                  <span className="text-slate-500">Text on page {u.page + 1} not matched to a question: </span>
                  <span className="italic">"{u.text.slice(0, 140)}{u.text.length > 140 ? '…' : ''}"</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => setManual(u.page)}>Fix on page</Button>
              </li>
            ))}
            {edited.length > 0 && (
              <li className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{edited.length} answer{edited.length === 1 ? ' was' : 's were'} edited after grading ({edited.map((q) => `Q${qByNum.get(q.questionNumber)?.label ?? q.questionNumber}`).join(', ')}).</span>
                <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} disabled={running} onClick={() => setConfirmReeval(true)}>Re-evaluate edited</Button>
              </li>
            )}
            {pending.length > 0 && (
              <li className="flex flex-wrap items-center gap-2">
                <span className="flex-1">{pending.length} question{pending.length === 1 ? ' is' : 's are'} not graded yet.</span>
                <Button size="sm" onClick={() => go({ name: 'processing', examId, studentId })}>Continue processing</Button>
              </li>
            )}
          </ul>
          <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
        </Card>
      )}

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-16">Q. No.</th>
                <th>Question</th>
                <th className="w-20">Max Marks</th>
                <th className="w-36">Recommended Marks</th>
                {isFinal && <th className="w-24">Final</th>}
                <th className="w-24">Confidence</th>
                <th>Status</th>
                <th className="w-20 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.questions.map((q) => {
                const meta = qByNum.get(q.questionNumber);
                const fq = final?.questions.find((x) => x.questionNumber === q.questionNumber);
                return (
                  <tr key={q.questionNumber}>
                    <td className="font-medium">{meta?.label ?? q.questionNumber}</td>
                    <td className="max-w-md truncate text-slate-600 dark:text-slate-300" title={meta?.text}>{meta?.text || '—'}</td>
                    <td>{fmtMarks(q.maxMarks)}</td>
                    <td>
                      <span className="text-base font-semibold">{fmtMarks(q.recommendedMarks)}</span>
                      {q.recommendedMarks !== null && q.status !== 'not_attempted' && <RecommendedTag className="ml-2" />}
                    </td>
                    {isFinal && <td className="font-semibold">{fmtMarks(fq?.finalMarks)}{fq?.overridden && <Badge tone="blue">edited</Badge>}</td>}
                    <td><ConfidenceText value={q.status === 'not_attempted' ? null : q.confidence} /></td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        <QuestionStatusBadge q={q} />
                        <FlagChips flags={q.flags.filter((f) => f !== 'low_confidence' || q.status !== 'needs_review')} />
                      </div>
                    </td>
                    <td className="text-right">
                      <Button size="sm" variant="outline" onClick={() => go({ name: 'question', examId, studentId, questionNumber: q.questionNumber })}>View</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 dark:border-slate-800">
          <p className="mr-auto text-xs text-slate-500">All AI marks are recommendations. Review them and finalize.</p>
          <Button variant="outline" icon={<PencilLine className="h-4 w-4" />} onClick={() => go({ name: 'finalize', examId, studentId })}>Edit All Marks</Button>
          <Button icon={<FileText className="h-4 w-4" />} onClick={() => go({ name: 'report', examId, studentId })}>Generate Report</Button>
        </div>
      </Card>

      {extraction && (
        <ManualEntryModal open={manual !== null} onClose={() => setManual(null)} examId={examId} studentId={studentId} pages={extraction.pages} startPage={manual ?? 0} onSaved={() => void data.reload()} />
      )}
      <Modal
        open={confirmReeval}
        onClose={() => setConfirmReeval(false)}
        title="Re-evaluate edited answers?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmReeval(false)}>Cancel</Button>
            <Button onClick={() => void reevaluateEdited()}>Re-evaluate ({edited.length} request{edited.length === 1 ? '' : 's'})</Button>
          </>
        }
      >
        <p className="text-sm">The AI will grade the edited text again. The previous recommendation is kept in the history.</p>
      </Modal>
    </>
  );
}
