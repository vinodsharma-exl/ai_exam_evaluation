/**
 * Screen 9 for the whole answer sheet: AI marks vs final marks for every question, comments, live total
 * (with "answer any N" rules and grade), Save draft / Finalize, and the audit trail.
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCheck, FileText, Lock, LockOpen, ScrollText } from 'lucide-react';
import type { FinalFile } from '../../shared/schemas/final';
import { computeStudentTotal, gradeFor, percentage, validateManualMark } from '../../shared/grading-math';
import { api, call } from '../lib/api';
import { useAction, useAsync, useShortcuts } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDateTime, fmtMarks } from '../lib/format';
import { Badge, Button, Card, Input, Loading, Modal, PageHeader, Textarea, cx } from '../components/ui';
import { QuestionStatusBadge, RecommendedTag } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { useTitle } from '../components/Shell';

type Row = { questionNumber: string; marks: string; comment: string };

const ACTION_TEXT: Record<string, string> = {
  create: 'Started final marks',
  edit_marks: 'Changed marks',
  accept_ai: 'Accepted AI mark',
  edit_comment: 'Edited comment',
  finalize: 'Finalized',
  unfinalize: 'Re-opened for editing',
  reevaluate_applied: 'Applied re-evaluation',
};

export function Finalize({ examId, studentId }: { examId: string; studentId: string }) {
  useTitle('Edit marks');
  const { go } = useRouter();
  const { config, toast, profile } = useApp();
  const data = useAsync(async () => {
    const [b, exam, final] = await Promise.all([call(api.getStudentBundle(examId, studentId)), call(api.getExam(examId)), call(api.getFinalDraft(examId, studentId))]);
    return { ...b, exam, final };
  }, [examId, studentId]);
  const [rows, setRows] = useState<Row[]>([]);
  const [overall, setOverall] = useState('');
  const [confirm, setConfirm] = useState(false);
  const save = useAction();

  const reset = (f: FinalFile) => {
    setRows(f.questions.map((q) => ({ questionNumber: q.questionNumber, marks: String(q.finalMarks), comment: q.comment })));
    setOverall(f.overallComment);
  };
  useEffect(() => {
    if (data.data) reset(data.data.final);
  }, [data.data]);

  const d = data.data;
  const half = d ? d.exam.gradingOverrides.allowHalfMarks ?? config?.grading.allowHalfMarks ?? true : true;
  const errors = useMemo(() => {
    const m = new Map<string, string>();
    if (!d) return m;
    for (const r of rows) {
      const fq = d.final.questions.find((q) => q.questionNumber === r.questionNumber)!;
      const e = r.marks.trim() === '' ? 'Required' : validateManualMark(Number(r.marks), fq.maxMarks, half);
      if (e) m.set(r.questionNumber, e);
    }
    return m;
  }, [rows, d, half]);
  const live = useMemo(() => {
    if (!d) return null;
    const { total, dropped } = computeStudentTotal(rows.map((r) => ({ number: r.questionNumber, marks: Number(r.marks) || 0 })), d.exam.choiceRules);
    const pct = percentage(total, d.exam.totalMarks);
    return { total, dropped, pct, grade: config ? gradeFor(pct, config.gradeBands) : '' };
  }, [rows, d, config]);

  const isFinal = d?.final.status === 'finalized';
  const dirty = !!d && (overall !== d.final.overallComment || rows.some((r) => {
    const fq = d.final.questions.find((q) => q.questionNumber === r.questionNumber)!;
    return Number(r.marks) !== fq.finalMarks || r.comment !== fq.comment;
  }));
  const overridden = d ? rows.filter((r) => { const fq = d.final.questions.find((q) => q.questionNumber === r.questionNumber)!; return fq.aiMarks !== null && Number(r.marks) !== fq.aiMarks; }).length : 0;
  const needsReview = d?.evaluation?.questions.filter((q) => q.status === 'needs_review').length ?? 0;

  const doSave = async (finalize: boolean) => {
    if (errors.size) return;
    const f = await save.run(() =>
      call(api.saveFinal(examId, studentId, { questions: rows.map((r) => ({ questionNumber: r.questionNumber, finalMarks: Number(r.marks), comment: r.comment })), overallComment: overall }, finalize)),
    );
    if (f) {
      toast(finalize ? 'Marks finalized' : isFinal ? 'Re-opened for editing' : 'Draft saved');
      await data.reload();
    }
  };
  useShortcuts({ 'ctrl+s': () => !isFinal && void doSave(false) });

  if (data.loading && !d) return <Loading />;
  if (data.error) return <ErrorBanner error={data.error} handlers={{ onRetry: data.reload }} />;
  if (!d || !live) return null;

  return (
    <>
      <PageHeader
        title="Edit Marks & Finalize"
        subtitle={`${d.student.displayId}${d.student.name ? ` · ${d.student.name}` : ''} · ${d.exam.title}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => go({ name: 'results', examId, studentId })}>Back to results</Button>
            <Button variant="outline" icon={<FileText className="h-4 w-4" />} onClick={() => go({ name: 'report', examId, studentId })}>Report</Button>
          </>
        }
      />

      {isFinal ? (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm dark:border-green-900 dark:bg-green-950/30">
          <Lock className="h-5 w-5 text-green-700" />
          <span className="flex-1">Finalized by <strong>{d.final.finalizedBy}</strong> on {fmtDateTime(d.final.finalizedAt)}. Re-open to change marks; every change is recorded.</span>
          <Button size="sm" variant="secondary" icon={<LockOpen className="h-4 w-4" />} busy={save.busy} onClick={() => void doSave(false)}>Re-open for editing</Button>
        </div>
      ) : (
        needsReview > 0 && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
            {needsReview} question{needsReview === 1 ? ' is' : 's are'} marked <strong>Needs Review</strong>. Open them (View) to check the AI's reasoning against the original image.
          </div>
        )
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
            <span className="text-sm text-slate-500">{overridden} of {rows.length} marks differ from the AI recommendation</span>
            {!isFinal && (
              <Button size="sm" variant="ghost" icon={<CheckCheck className="h-4 w-4" />} onClick={() => setRows((rs) => rs.map((r) => { const fq = d.final.questions.find((q) => q.questionNumber === r.questionNumber)!; return fq.aiMarks === null ? r : { ...r, marks: String(fq.aiMarks) }; }))}>
                Accept all AI marks
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-16">Q. No.</th>
                  <th className="w-16">Max</th>
                  <th className="w-32">AI marks</th>
                  <th className="w-32">Final marks</th>
                  <th>Comment for the student</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const fq = d.final.questions.find((q) => q.questionNumber === r.questionNumber)!;
                  const meta = d.exam.questions.find((q) => q.number === r.questionNumber);
                  const ev = d.evaluation?.questions.find((q) => q.questionNumber === r.questionNumber);
                  const err = errors.get(r.questionNumber);
                  const diff = fq.aiMarks !== null && Number(r.marks) !== fq.aiMarks;
                  const dropped = live.dropped.includes(r.questionNumber);
                  return (
                    <tr key={r.questionNumber} className={cx(dropped && 'opacity-60')}>
                      <td className="font-medium">{meta?.label ?? r.questionNumber}</td>
                      <td>{fmtMarks(fq.maxMarks)}</td>
                      <td>
                        <div className="flex flex-col gap-1">
                          <span className="font-semibold">{fmtMarks(fq.aiMarks)}</span>
                          {ev && ev.status !== 'not_attempted' && <QuestionStatusBadge q={ev} />}
                        </div>
                      </td>
                      <td>
                        <Input
                          type="number"
                          step={half ? 0.5 : 1}
                          min={0}
                          max={fq.maxMarks}
                          value={r.marks}
                          disabled={isFinal}
                          aria-label={`Final marks for Q${meta?.label}`}
                          aria-invalid={!!err}
                          onChange={(e) => setRows((rs) => rs.map((x, k) => (k === i ? { ...x, marks: e.target.value } : x)))}
                          className={cx('w-24 py-1 text-center font-semibold', err && 'border-red-500', diff && !err && 'border-brand-500')}
                        />
                        {err && <div className="mt-0.5 text-xs text-red-600">{err}</div>}
                        {dropped && <div className="mt-0.5 text-xs text-slate-500">not counted</div>}
                      </td>
                      <td>
                        <Textarea rows={2} value={r.comment} disabled={isFinal} onChange={(e) => setRows((rs) => rs.map((x, k) => (k === i ? { ...x, comment: e.target.value } : x)))} className="min-h-0 py-1 text-sm" />
                      </td>
                      <td>
                        <Button size="sm" variant="ghost" onClick={() => go({ name: 'question', examId, studentId, questionNumber: r.questionNumber })}>View</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-slate-100 p-5 dark:border-slate-800">
            <label className="mb-1 block text-sm font-medium">Overall comment (on the report)</label>
            <Textarea rows={3} value={overall} disabled={isFinal} onChange={(e) => setOverall(e.target.value)} maxLength={4000} />
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <p className="text-sm text-slate-500">Total</p>
            <p className="text-4xl font-bold text-navy-900 dark:text-white">
              {fmtMarks(live.total)} <span className="text-2xl text-slate-400">/ {fmtMarks(d.exam.totalMarks)}</span>
            </p>
            <p className="mt-1 text-sm">
              {fmtMarks(live.pct)}%{live.grade && <> · Grade <strong>{live.grade}</strong></>}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              AI recommended: {fmtMarks(d.evaluation?.totals.recommended)} <RecommendedTag />
            </p>
            {!isFinal && (
              <div className="mt-5 flex flex-col gap-2">
                <Button variant="secondary" busy={save.busy} disabled={!dirty || errors.size > 0} onClick={() => void doSave(false)}>Save draft</Button>
                <Button busy={save.busy} disabled={errors.size > 0} icon={<Lock className="h-4 w-4" />} onClick={() => setConfirm(true)}>Finalize marks</Button>
              </div>
            )}
            <ErrorBanner error={save.error} onDismiss={() => save.setError(null)} />
          </Card>

          <Card title={<span className="flex items-center gap-2"><ScrollText className="h-4 w-4" /> Audit trail</span>}>
            {d.final.audit.length === 0 ? (
              <p className="text-sm text-slate-500">No changes yet.</p>
            ) : (
              <ol className="max-h-80 space-y-2 overflow-y-auto text-xs">
                {[...d.final.audit].reverse().map((a, i) => (
                  <li key={i} className="border-l-2 border-slate-200 pl-2 dark:border-slate-700">
                    <div className="font-medium">
                      {ACTION_TEXT[a.action] ?? a.action}
                      {a.questionNumber && ` · Q${d.exam.questions.find((q) => q.number === a.questionNumber)?.label ?? a.questionNumber}`}
                      {a.action === 'edit_marks' || a.action === 'accept_ai' ? `: ${a.from ?? '—'} → ${a.to}` : ''}
                    </div>
                    {a.reason && <div className="text-slate-600 dark:text-slate-300">"{a.reason}"</div>}
                    <div className="text-slate-400">{a.by} · {fmtDateTime(a.at)}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Finalize these marks?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button icon={<Lock className="h-4 w-4" />} onClick={() => { setConfirm(false); void doSave(true); }}>Finalize</Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>
            Total <strong>{fmtMarks(live.total)} / {fmtMarks(d.exam.totalMarks)}</strong> ({fmtMarks(live.pct)}%{live.grade ? `, grade ${live.grade}` : ''}).
          </p>
          <p>{overridden} mark{overridden === 1 ? '' : 's'} differ from the AI recommendation.</p>
          {needsReview > 0 && <p className="text-amber-700">{needsReview} question{needsReview === 1 ? '' : 's'} were marked Needs Review. Make sure you've checked them.</p>}
          <p className="text-slate-500">Finalized marks appear on the report without the DRAFT watermark. You can re-open them later; changes stay in the audit trail.</p>
          <Badge tone="blue">Signed as {[profile?.title, profile?.name].filter(Boolean).join(' ')}</Badge>
        </div>
      </Modal>
    </>
  );
}
