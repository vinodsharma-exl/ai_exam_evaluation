/**
 * Screens 7, 8 and 9 for one question, laid out as in the screenshot:
 *   7  Question Detail: question and model answer | student's answer (extracted text, editable) / original image
 *   8  AI Evaluation & Feedback: recommended marks, per-criterion breakdown, what's correct / missing,
 *      confidence, "Re-evaluate this question"
 *   9  Edit Marks for this question: final marks (validated), comment, private note, reason → Save
 * Shortcuts: Alt+← / Alt+→ previous/next · Ctrl+S save text or marks · Ctrl+Enter save marks and next.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, History, ImageIcon, Pencil, RefreshCw, Save, TextCursorInput, XCircle, ZoomIn, ZoomOut } from 'lucide-react';
import type { FinalFile } from '../../shared/schemas/final';
import { validateManualMark } from '../../shared/grading-math';
import { api, call } from '../lib/api';
import { useAction, useAppEvent, useAsync, useShortcuts } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDateTime, fmtMarks } from '../lib/format';
import { Badge, Button, Card, Field, Input, Kbd, Loading, Modal, Spinner, Textarea, cx } from '../components/ui';
import { ConfidenceText, FlagChips, QuestionStatusBadge, RecommendedTag } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { useTitle } from '../components/Shell';

export function QuestionDetail({ examId, studentId, questionNumber }: { examId: string; studentId: string; questionNumber: string }) {
  const { go } = useRouter();
  const { config, toast } = useApp();
  const data = useAsync(async () => {
    const [b, exam, final] = await Promise.all([call(api.getStudentBundle(examId, studentId)), call(api.getExam(examId)), call(api.getFinalDraft(examId, studentId))]);
    return { ...b, exam, finalDraft: final };
  }, [examId, studentId]);
  const [reevaluating, setReevaluating] = useState(false);

  useAppEvent('job:progress', (p) => {
    if (p.examId !== examId || p.studentId !== studentId) return;
    if (p.state === 'completed' || p.state === 'paused' || p.state === 'cancelled') {
      setReevaluating(false);
      void data.reload();
      if (p.state === 'completed' && reevaluating) toast('Re-evaluation finished');
    }
  });

  const d = data.data;
  const idx = d ? d.exam.questions.findIndex((q) => q.number === questionNumber) : -1;
  const q = d?.exam.questions[idx];
  useTitle(q ? `Question ${q.label}` : 'Question');
  const nav = (delta: number) => {
    const next = d?.exam.questions[idx + delta];
    if (next) go({ name: 'question', examId, studentId, questionNumber: next.number });
  };
  useShortcuts({ 'alt+arrowleft': () => nav(-1), 'alt+arrowright': () => nav(1) });

  if (data.loading && !d) return <Loading />;
  if (data.error) return <ErrorBanner error={data.error} handlers={{ onRetry: data.reload }} />;
  if (!d || !q) return <ErrorBanner error={{ code: 'NOT_FOUND', detail: `Question ${questionNumber}`, at: '' }} />;

  const answer = d.extraction?.answers.find((a) => a.questionNumber === q.number);
  const ev = d.evaluation?.questions.find((x) => x.questionNumber === q.number);
  const fq = d.finalDraft.questions.find((x) => x.questionNumber === q.number);
  const half = d.exam.gradingOverrides.allowHalfMarks ?? config?.grading.allowHalfMarks ?? true;
  const running = d.jobs?.state === 'running' || d.jobs?.state === 'waiting_rate_limit';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => go({ name: 'results', examId, studentId })} className="text-sm text-brand-600 hover:underline">
          ← {d.student.displayId} results
        </button>
        <h1 className="ml-2 text-2xl font-semibold text-slate-900 dark:text-white">
          Question {idx + 1} of {d.exam.questions.length}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-slate-400 lg:inline"><Kbd>Alt ←</Kbd> <Kbd>Alt →</Kbd></span>
          <Button variant="outline" icon={<ArrowLeft className="h-4 w-4" />} disabled={idx === 0} onClick={() => nav(-1)}>Previous</Button>
          <Button variant="outline" disabled={idx === d.exam.questions.length - 1} onClick={() => nav(1)}>Next <ArrowRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* ---------------------------------------------------------------- 7: question + model answer */}
        <Card>
          <h2 className="text-lg font-semibold">
            Question {q.label} <span className="text-sm font-normal text-slate-500">(Max Marks: {fmtMarks(q.maxMarks)})</span>
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{q.text || '—'}</p>
          <h3 className="mt-6 text-sm font-semibold">Model Answer / Marking Points</h3>
          {q.markingPoints.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {q.markingPoints.map((p) => (
                <li key={p.id}>
                  {p.description} <span className="text-slate-500">({fmtMarks(p.marks)} mark{p.marks === 1 ? '' : 's'})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">No separate marking points: graded against the model answer as a whole.</p>
          )}
          {q.modelAnswer && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">{q.modelAnswer}</p>}
          {q.finalAnswer && <p className="mt-2 text-sm"><span className="text-slate-500">Expected final answer: </span><strong>{q.finalAnswer}</strong></p>}
        </Card>

        <StudentAnswerCard examId={examId} studentId={studentId} questionNumber={q.number} answer={answer} disabled={running} onSaved={data.reload} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {/* ---------------------------------------------------------------- 8: AI evaluation */}
        <AiEvaluationCard
          ev={ev}
          label={q.label}
          answerEdited={!!ev?.flags.includes('answer_changed_since_evaluation')}
          busy={reevaluating || running}
          onReevaluate={async () => {
            setReevaluating(true);
            try {
              await call(api.reevaluateQuestion(examId, studentId, q.number));
            } catch (e) {
              setReevaluating(false);
              throw e;
            }
          }}
        />
        {/* ---------------------------------------------------------------- 9: edit marks */}
        {fq && (
          <EditMarksCard
            key={`${q.number}-${fq.finalMarks}-${d.finalDraft.updatedAt}`}
            final={d.finalDraft}
            fq={fq}
            label={q.label}
            half={half}
            examId={examId}
            studentId={studentId}
            onSaved={async (next) => {
              await data.reload();
              if (next) nav(1);
            }}
          />
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------------------------------
function StudentAnswerCard({
  examId,
  studentId,
  questionNumber,
  answer,
  disabled,
  onSaved,
}: {
  examId: string;
  studentId: string;
  questionNumber: string;
  answer: { text: string; pages: number[]; origin: string; illegibleCount: number; diagramDescription: string; confidence: number } | undefined;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useApp();
  const [tab, setTab] = useState<'text' | 'image'>('text');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(answer?.text ?? '');
  const save = useAction();
  useEffect(() => {
    setText(answer?.text ?? '');
    setEditing(false);
  }, [answer?.text, questionNumber]);

  const doSave = async () => {
    const r = await save.run(() => call(api.saveAnswerText(examId, studentId, questionNumber, text)));
    if (r) {
      toast('Answer text saved. Re-evaluate to grade the corrected text.', 'info');
      setEditing(false);
      await onSaved();
    }
  };
  useShortcuts({ 'ctrl+s': () => editing && void doSave() }, editing);

  return (
    <Card padded={false}>
      <div className="flex border-b border-slate-100 dark:border-slate-800" role="tablist">
        {[
          { id: 'text' as const, label: "Student's Answer (Extracted Text)", icon: <TextCursorInput className="h-4 w-4" /> },
          { id: 'image' as const, label: 'Original Answer Image', icon: <ImageIcon className="h-4 w-4" /> },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx('flex items-center gap-2 border-b-2 px-5 py-3 text-sm', tab === t.id ? 'border-brand-600 font-semibold text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500 hover:text-slate-700')}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'text' ? (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">Extracted Text {editing ? '' : '(editable)'}</span>
              {answer?.origin === 'ai' && <Badge tone="purple">read by AI</Badge>}
              {answer?.origin === 'ai_edited' && <Badge tone="blue">edited by you</Badge>}
              {answer?.origin === 'manual' && <Badge>typed</Badge>}
              {(answer?.illegibleCount ?? 0) > 0 && <Badge tone="orange">{answer!.illegibleCount} illegible</Badge>}
              {answer && answer.confidence < 0.7 && <Badge tone="orange">reading confidence {Math.round(answer.confidence * 100)}%</Badge>}
              <span className="ml-auto flex gap-2">
                {editing ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => { setText(answer?.text ?? ''); setEditing(false); }}>Cancel</Button>
                    <Button size="sm" icon={<Save className="h-3.5 w-3.5" />} busy={save.busy} onClick={() => void doSave()}>Save</Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} disabled={disabled} onClick={() => setEditing(true)}>Edit</Button>
                )}
              </span>
            </div>
            {editing ? (
              <Textarea autoFocus className="min-h-72 font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} />
            ) : answer?.text ? (
              <pre className="max-h-[28rem] min-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[13px] leading-relaxed dark:border-slate-700 dark:bg-slate-900">{answer.text}</pre>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
                No answer found for this question. If the student did answer it, click Edit and type it, or check the original image.
              </p>
            )}
            {answer?.diagramDescription && (
              <p className="mt-2 text-xs text-slate-500"><strong>Diagram (as described by the AI):</strong> {answer.diagramDescription}</p>
            )}
            <ErrorBanner error={save.error} onDismiss={() => save.setError(null)} />
          </>
        ) : (
          <PageImages examId={examId} studentId={studentId} pages={answer?.pages ?? []} />
        )}
      </div>
    </Card>
  );
}

function PageImages({ examId, studentId, pages }: { examId: string; studentId: string; pages: number[] }) {
  const [i, setI] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const page = pages[i];
  useEffect(() => {
    setI(0);
  }, [pages.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (page === undefined) return;
    setSrc(null);
    void call(api.getPageImage(examId, studentId, page)).then(setSrc).catch(() => setSrc(null));
  }, [examId, studentId, page]);
  if (pages.length === 0) return <p className="text-sm text-slate-500">This answer isn't linked to a page. Open the full answer sheet from the results screen.</p>;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-sm">
        {pages.map((p, k) => (
          <button key={p} type="button" onClick={() => setI(k)} className={cx('rounded-md px-2 py-1', k === i ? 'bg-brand-600 text-white' : 'bg-slate-100 dark:bg-slate-800')}>
            Page {p + 1}
          </button>
        ))}
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} icon={<ZoomOut className="h-4 w-4" />} />
          <Button size="sm" variant="ghost" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} icon={<ZoomIn className="h-4 w-4" />} />
        </span>
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
        {src ? <img src={src} alt={`Answer sheet page ${(page ?? 0) + 1}`} style={{ width: `${zoom * 100}%` }} className="max-w-none" /> : <div className="p-8"><Spinner /></div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
function AiEvaluationCard({
  ev,
  label,
  answerEdited,
  busy,
  onReevaluate,
}: {
  ev: import('../../shared/schemas/evaluation').QuestionEvaluation | undefined;
  label: string;
  answerEdited: boolean;
  busy: boolean;
  onReevaluate: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState(false);
  const act = useAction();
  useShortcuts({ 'ctrl+r': () => setConfirm(true) });

  if (!ev || ev.status === 'pending') {
    return (
      <Card title="AI Evaluation">
        <p className="text-sm text-slate-500">{busy ? 'Grading in progress…' : 'Not graded yet.'}</p>
      </Card>
    );
  }
  return (
    <Card
      title="AI Evaluation & Feedback"
      actions={
        <Button size="sm" variant="outline" icon={<RefreshCw className={cx('h-3.5 w-3.5', busy && 'animate-spin')} />} disabled={busy} onClick={() => setConfirm(true)}>
          {busy ? 'Re-evaluating…' : 'Re-evaluate this question'}
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-4 rounded-xl bg-red-50/70 p-4 dark:bg-red-950/20">
          <div>
            <p className="text-xs font-medium text-slate-600 dark:text-slate-300">Recommended Marks</p>
            <p className="text-3xl font-bold text-red-600 dark:text-red-400">
              {fmtMarks(ev.recommendedMarks)} <span className="text-xl text-slate-400">/ {fmtMarks(ev.maxMarks)}</span>
            </p>
            <RecommendedTag />
          </div>
          <div className="ml-auto space-y-1 text-right text-sm">
            <div>Confidence: <ConfidenceText value={ev.status === 'not_attempted' ? null : ev.confidence} /></div>
            <div className="flex justify-end gap-1"><QuestionStatusBadge q={ev} /></div>
            <FlagChips flags={ev.flags} />
          </div>
        </div>
        {answerEdited && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">The answer text was edited after grading. Re-evaluate to grade the corrected text.</p>}
        {ev.reviewNote && (
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <strong>Why the AI asked for review:</strong> {ev.reviewNote} <span className="text-xs opacity-80">(only you see this)</span>
          </p>
        )}

        {ev.criteria.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold">Marks Breakdown</h3>
            <table className="table-base">
              <thead>
                <tr>
                  <th>Criteria</th>
                  <th className="w-24">Marks (Max)</th>
                  <th className="w-24">Awarded</th>
                </tr>
              </thead>
              <tbody>
                {ev.criteria.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.description}
                      {c.comment && <div className="text-xs text-slate-500">{c.comment}</div>}
                    </td>
                    <td>{fmtMarks(c.maxMarks)}</td>
                    <td className={cx('font-semibold', c.awarded === 0 ? 'text-red-600' : c.awarded < c.maxMarks ? 'text-amber-600' : 'text-green-700 dark:text-green-400')}>{fmtMarks(c.awarded)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-green-700 dark:text-green-400"><CheckCircle2 className="h-4 w-4" /> What is Correct</h3>
            {ev.correct.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">{ev.correct.map((c) => <li key={c}>{c}</li>)}</ul>
            ) : <p className="text-sm text-slate-500">—</p>}
          </div>
          <div>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400"><XCircle className="h-4 w-4" /> What is Missing / Incorrect</h3>
            {ev.missing.length ? (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">{ev.missing.map((c) => <li key={c}>{c}</li>)}</ul>
            ) : <p className="text-sm text-slate-500">—</p>}
          </div>
        </div>
        {ev.feedback && (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Feedback for the student</h3>
            <p className="text-sm">{ev.feedback}</p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {ev.by && <span>Graded by {ev.by.providerId}:{ev.by.model} · {fmtDateTime(ev.evaluatedAt)}</span>}
          {ev.history.length > 0 && (
            <button type="button" className="inline-flex items-center gap-1 text-brand-600 hover:underline" onClick={() => setHistory((h) => !h)}>
              <History className="h-3.5 w-3.5" /> {ev.history.length} earlier recommendation{ev.history.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {history && (
          <ul className="space-y-1 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
            {ev.history.map((h, i) => (
              <li key={i}>
                <strong>{fmtMarks(h.recommendedMarks)}</strong> / {fmtMarks(ev.maxMarks)} · confidence {h.confidence === null ? '—' : `${Math.round(h.confidence * 100)}%`} · {h.by ? `${h.by.model}` : ''} · {fmtDateTime(h.evaluatedAt)}
                {h.feedback && <div className="text-slate-500">{h.feedback}</div>}
              </li>
            ))}
          </ul>
        )}
        <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Re-evaluate Q${label}?`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button onClick={() => { setConfirm(false); void act.run(onReevaluate); }}>Re-evaluate (1 request)</Button>
          </>
        }
      >
        <p className="text-sm">The AI grades this answer again with the current text and settings, skipping the cache. The current recommendation is kept in the history. Your own final mark is not changed.</p>
      </Modal>
    </Card>
  );
}

// ------------------------------------------------------------------------------------------------
function EditMarksCard({
  final,
  fq,
  label,
  half,
  examId,
  studentId,
  onSaved,
}: {
  final: FinalFile;
  fq: FinalFile['questions'][number];
  label: string;
  half: boolean;
  examId: string;
  studentId: string;
  onSaved: (next: boolean) => Promise<void>;
}) {
  const { toast } = useApp();
  const [marks, setMarks] = useState(String(fq.finalMarks));
  const [comment, setComment] = useState(fq.comment);
  const [note, setNote] = useState(fq.privateNote);
  const [reason, setReason] = useState('');
  const save = useAction();
  const value = Number(marks);
  const err = marks.trim() === '' ? 'Enter a mark.' : validateManualMark(value, fq.maxMarks, half);
  const differsFromAi = fq.aiMarks !== null && value !== fq.aiMarks;
  const dirty = value !== fq.finalMarks || comment !== fq.comment || note !== fq.privateNote;
  const isFinal = final.status === 'finalized';

  const doSave = async (next: boolean) => {
    if (err) return;
    const r = await save.run(() =>
      call(api.saveFinal(examId, studentId, { questions: [{ questionNumber: fq.questionNumber, finalMarks: value, comment, privateNote: note, reason }] }, isFinal)),
    );
    if (r) {
      toast(`Q${label} saved`);
      await onSaved(next);
    }
  };
  // Ctrl+S here only when focus is in this panel (the answer editor has its own Ctrl+S).
  const panel = useRef<HTMLDivElement>(null);
  const focusedHere = () => !!panel.current?.contains(document.activeElement);
  useShortcuts({ 'ctrl+s': () => focusedHere() && void doSave(false), 'ctrl+enter': () => void doSave(true) });
  const step = half ? 0.5 : 1;

  return (
    <div ref={panel}>
    <Card title={`Edit Marks for Q${label}`}>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Maximum Marks:</dt>
        <dd>{fmtMarks(fq.maxMarks)}</dd>
        <dt className="text-slate-500">Recommended Marks (AI):</dt>
        <dd className="flex items-center gap-2">
          {fmtMarks(fq.aiMarks)}
          {fq.aiMarks !== null && (
            <button type="button" className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline" onClick={() => setMarks(String(fq.aiMarks))}>
              <Check className="h-3 w-3" /> use
            </button>
          )}
        </dd>
      </dl>
      <div className="space-y-3">
        <Field label="Final Marks (Professor)" error={err}>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" aria-label="Decrease" onClick={() => setMarks(String(Math.max(0, (Number(marks) || 0) - step)))}>−</Button>
            <Input type="number" inputMode="decimal" min={0} max={fq.maxMarks} step={step} value={marks} onChange={(e) => setMarks(e.target.value)} className="w-28 text-center text-lg font-semibold" aria-label="Final marks" />
            <Button variant="secondary" size="sm" aria-label="Increase" onClick={() => setMarks(String(Math.min(fq.maxMarks, (Number(marks) || 0) + step)))}>+</Button>
            {differsFromAi && <Badge tone="blue">overrides AI</Badge>}
          </div>
        </Field>
        {differsFromAi && (
          <Field label="Reason for change (optional, kept in the audit trail)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Method correct, arithmetic slip" maxLength={500} />
          </Field>
        )}
        <Field label="Comments for the student (on the report)">
          <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </Field>
        <Field label="Private note (never printed)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </Field>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <span className="mr-auto text-xs text-slate-400"><Kbd>Ctrl S</Kbd> save · <Kbd>Ctrl Enter</Kbd> save &amp; next</span>
          <Button variant="secondary" disabled={!dirty} onClick={() => { setMarks(String(fq.finalMarks)); setComment(fq.comment); setNote(fq.privateNote); }}>Cancel</Button>
          <Button busy={save.busy} disabled={!!err} onClick={() => void doSave(false)}>Save</Button>
        </div>
        {isFinal && <p className="text-xs text-slate-500">These marks are finalized; changes are recorded in the audit trail.</p>}
        <ErrorBanner error={save.error} onDismiss={() => save.setError(null)} />
      </div>
    </Card>
    </div>
  );
}
