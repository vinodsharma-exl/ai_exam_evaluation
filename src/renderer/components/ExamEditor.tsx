/**
 * Screen 4: Question Paper & Model Answer setup (an "exam template").
 *   - upload the question paper / model answer (handwritten OK), or paste text, or type questions
 *   - "Read with AI" fills an editable table (a proposal; nothing is saved until Save)
 *   - question-wise table: Q.No, question, max marks, type; expand a row for the model answer and marking points
 *   - "answer any N" rules, grading options; readiness checks before grading is allowed
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardPaste, Plus, Save, Sparkles, Trash2, Wand2, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { ChoiceRule, ExamFile, Question } from '../../shared/schemas/exam';
import type { ExtractionProposal } from '../../shared/ipc';
import { normalizeQuestionNumber } from '../../shared/schemas/common';
import { computeExamTotal, examReadiness, round2 } from '../../shared/grading-math';
import { api, call } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useApp } from '../lib/app-context';
import { useShortcuts } from '../lib/hooks';
import { Badge, Button, Card, Field, Input, Modal, Select, Textarea, Toggle, cx } from './ui';
import { Dropzone, FileRow } from './Uploads';
import { ErrorBanner } from './ErrorBanner';

type Doc = 'questionPaper' | 'modelAnswer';
const DOC_LABEL: Record<Doc, string> = { questionPaper: 'Question Paper', modelAnswer: 'Model Answers / Marking Scheme' };

function blankQuestion(order: number, label: string): Question {
  return { label, number: normalizeQuestionNumber(label), order, text: '', maxMarks: 0, type: 'theory', modelAnswer: '', markingPoints: [], finalAnswer: '', expectsDiagram: false, origin: 'manual' };
}

export function ExamEditor({ exam: initial, onSaved, compact }: { exam: ExamFile; onSaved?: (e: ExamFile) => void; compact?: boolean }) {
  const { toast } = useApp();
  const [exam, setExam] = useState(initial);
  const [questions, setQuestions] = useState<Question[]>(initial.questions);
  const [rules, setRules] = useState<ChoiceRule[]>(initial.choiceRules);
  const [meta, setMeta] = useState({ title: initial.title, courseCode: initial.courseCode, subject: initial.subject, className: initial.className, examDate: initial.examDate ?? '', evaluatorNotes: initial.evaluatorNotes });
  const [overrides, setOverrides] = useState(initial.gradingOverrides);
  const [open, setOpen] = useState<number | null>(null);
  const [proposal, setProposal] = useState<(ExtractionProposal & { doc: Doc }) | null>(null);
  const [paste, setPaste] = useState<Doc | null>(null);
  const [dirty, setDirty] = useState(false);
  const save = useAction();
  const extract = useAction();
  const [attaching, setAttaching] = useState<Doc | null>(null);

  useEffect(() => {
    setExam(initial);
    setQuestions(initial.questions);
    setRules(initial.choiceRules);
  }, [initial]);

  const touch = () => setDirty(true);
  const readiness = useMemo(() => examReadiness(questions.map((q) => ({ ...q, number: normalizeQuestionNumber(q.label) })), rules), [questions, rules]);
  const total = useMemo(() => computeExamTotal(questions.map((q) => ({ number: normalizeQuestionNumber(q.label), maxMarks: q.maxMarks })), rules), [questions, rules]);

  const updateQ = (i: number, patch: Partial<Question>) => {
    setQuestions((qs) => qs.map((q, k) => (k === i ? { ...q, ...patch, origin: q.origin === 'ai' ? 'ai_edited' : q.origin } : q)));
    touch();
  };

  const doSave = async (quiet = false): Promise<boolean> => {
    const res = await save.run(() =>
      call(
        api.saveExam({
          ...exam,
          ...meta,
          examDate: meta.examDate || null,
          gradingOverrides: overrides,
          questions: questions.map((q) => ({ ...q, label: q.label.trim() || String(q.order + 1) })),
          choiceRules: rules,
        }),
      ),
    );
    if (!res) return false;
    setExam(res.exam);
    setQuestions(res.exam.questions);
    setRules(res.exam.choiceRules);
    setDirty(false);
    setProposal(null);
    if (!quiet) toast(res.exam.status === 'ready' ? 'Exam saved and ready for grading' : 'Exam saved as draft. See the checklist.', res.exam.status === 'ready' ? 'success' : 'info');
    onSaved?.(res.exam);
    return true;
  };
  useShortcuts({ 'ctrl+s': () => void doSave() });

  const attach = async (doc: Doc, paths?: string[]) => {
    setAttaching(doc);
    const e = await extract.run(() => call(api.attachExamSource(exam.id, doc, paths)));
    setAttaching(null);
    if (e) {
      setExam(e);
      toast(`${DOC_LABEL[doc]} uploaded`);
    }
  };

  const runExtract = async (doc: Doc, text?: string) => {
    // The AI reads against the SAVED exam (e.g. the model answer is matched to the saved questions),
    // so save the current table first. Saving a draft is always allowed.
    if (dirty && !(await doSave(true))) return;
    const p = await extract.run(() => call(text !== undefined ? api.extractExamSourceFromText(exam.id, doc, text) : api.extractExamSource(exam.id, doc)));
    if (!p) return;
    setQuestions(p.questions);
    setRules(p.choiceRules);
    setProposal({ ...p, doc });
    setDirty(true);
    setPaste(null);
  };

  const sourceCard = (doc: Doc) => {
    const src = exam.sources[doc];
    const blocked = doc === 'modelAnswer' && questions.length === 0;
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Upload {DOC_LABEL[doc]} <span className="font-normal text-slate-500">(PDF or photos, handwritten OK)</span></h3>
        {src ? (
          <>
            <FileRow name={src.originalFileNames.join(', ') || `${doc}.pdf`} meta={`${src.pageCount} page${src.pageCount === 1 ? '' : 's'}${src.extractedAt ? ' · read by AI' : ''}`} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Wand2 className="h-4 w-4" />} busy={extract.busy && !attaching} disabled={blocked} onClick={() => void runExtract(doc)} title={blocked ? 'Add the questions first' : undefined}>
                Read with AI
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void attach(doc)}>Replace file</Button>
              <Button size="sm" variant="ghost" icon={<ClipboardPaste className="h-4 w-4" />} disabled={blocked} onClick={() => setPaste(doc)}>Paste text instead</Button>
            </div>
          </>
        ) : (
          <>
            <Dropzone compact title={`Upload ${DOC_LABEL[doc]}`} busy={attaching === doc} onPaths={(p) => void attach(doc, p)} onPick={() => void attach(doc)} />
            <Button size="sm" variant="ghost" icon={<ClipboardPaste className="h-4 w-4" />} disabled={blocked} onClick={() => setPaste(doc)}>
              or paste / type the text
            </Button>
          </>
        )}
        {blocked && <p className="text-xs text-slate-500">Add the questions first (question paper or manual entry), then the model answer.</p>}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {!compact && (
        <Card title="Exam details">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Exam title" required>
              <Input value={meta.title} onChange={(e) => (setMeta({ ...meta, title: e.target.value }), touch())} />
            </Field>
            <Field label="Course code">
              <Input value={meta.courseCode} onChange={(e) => (setMeta({ ...meta, courseCode: e.target.value }), touch())} />
            </Field>
            <Field label="Exam date">
              <Input type="date" value={meta.examDate} onChange={(e) => (setMeta({ ...meta, examDate: e.target.value }), touch())} />
            </Field>
            <Field label="Subject">
              <Input value={meta.subject} onChange={(e) => (setMeta({ ...meta, subject: e.target.value }), touch())} />
            </Field>
            <Field label="Class / section">
              <Input value={meta.className} onChange={(e) => (setMeta({ ...meta, className: e.target.value }), touch())} />
            </Field>
          </div>
        </Card>
      )}

      <Card>
        <div className="grid gap-6 lg:grid-cols-2">
          {sourceCard('questionPaper')}
          {sourceCard('modelAnswer')}
        </div>
        <ErrorBanner error={extract.error} handlers={{ onRetry: () => extract.setError(null) }} onDismiss={() => extract.setError(null)} />
      </Card>

      {proposal && (
        <div className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-4 text-sm dark:border-violet-900 dark:bg-violet-950/30">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-violet-600" />
          <div className="flex-1">
            <p className="font-semibold">AI proposal from the {DOC_LABEL[proposal.doc].toLowerCase()}: please check, then Save</p>
            <p className="text-slate-600 dark:text-slate-300">
              {proposal.route === 'text-layer' ? 'Read from the PDF text (typed paper, no image reading needed). ' : proposal.route === 'pasted-text' ? 'Read from the pasted text. ' : 'Read from the page images. '}
              {proposal.requestsUsed} request{proposal.requestsUsed === 1 ? '' : 's'} used.
            </p>
            {proposal.warnings.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-amber-800 dark:text-amber-300">
                {proposal.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      <Card
        title={
          <span className="flex items-center gap-2">
            Question-wise Marks <span className="font-normal text-slate-500">(edit if needed)</span>
          </span>
        }
        actions={<span className="text-sm text-slate-500">Total: <strong className="text-slate-800 dark:text-white">{total}</strong> marks</span>}
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8" />
                <th className="w-24">Q. No.</th>
                <th>Question Title / Topic</th>
                <th className="w-28">Max Marks</th>
                <th className="w-36">Type</th>
                <th className="w-36">Model answer</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {questions.map((q, i) => {
                const expanded = open === i;
                const ptSum = round2(q.markingPoints.reduce((s, p) => s + p.marks, 0));
                const hasAnswer = q.modelAnswer.trim() || q.markingPoints.length > 0;
                return [
                  <tr key={`r${i}`} className={cx(expanded && 'bg-slate-50 dark:bg-slate-800/40')}>
                    <td>
                      <button type="button" onClick={() => setOpen(expanded ? null : i)} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={expanded ? 'Collapse' : 'Expand'}>
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td>
                      <Input value={q.label} onChange={(e) => updateQ(i, { label: e.target.value })} className="py-1" aria-label="Question number" />
                    </td>
                    <td>
                      <Input value={q.text} onChange={(e) => updateQ(i, { text: e.target.value })} placeholder="Question text or topic" className="py-1" />
                      {q.origin !== 'manual' && q.extractionConfidence !== undefined && q.extractionConfidence < 0.6 && <Badge tone="orange">check text</Badge>}
                    </td>
                    <td>
                      <Input type="number" min={0} step={0.5} value={q.maxMarks || ''} onChange={(e) => updateQ(i, { maxMarks: Number(e.target.value) })} className="py-1" aria-label="Max marks" />
                    </td>
                    <td>
                      <Select value={q.type} onChange={(e) => updateQ(i, { type: e.target.value as Question['type'] })} className="py-1">
                        <option value="theory">Theory</option>
                        <option value="numerical">Numerical</option>
                        <option value="mixed">Mixed</option>
                      </Select>
                    </td>
                    <td>
                      {hasAnswer ? (
                        <Badge tone={q.markingPoints.length && ptSum !== q.maxMarks ? 'orange' : 'green'}>
                          {q.markingPoints.length ? `${q.markingPoints.length} points · ${ptSum}` : 'answer only'}
                        </Badge>
                      ) : (
                        <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setOpen(i)}>Add</button>
                      )}
                    </td>
                    <td>
                      <button type="button" onClick={() => (setQuestions((qs) => qs.filter((_, k) => k !== i)), touch())} className="rounded p-1 text-slate-400 hover:text-red-600" aria-label="Delete question">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>,
                  expanded && (
                    <tr key={`d${i}`}>
                      <td />
                      <td colSpan={6} className="bg-slate-50 dark:bg-slate-800/40">
                        <QuestionDetailsEditor q={q} onChange={(patch) => updateQ(i, patch)} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <Button
            variant="outline"
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setQuestions((qs) => [...qs, blankQuestion(qs.length, String(qs.length + 1))]);
              setOpen(questions.length);
              touch();
            }}
          >
            Enter Questions Manually
          </Button>
          {questions.length === 0 && <span className="text-sm text-slate-500">Upload the question paper above, paste its text, or add questions one by one.</span>}
        </div>
      </Card>

      {!compact && <ChoiceRulesEditor rules={rules} onChange={(r) => (setRules(r), touch())} />}

      {!compact && (
        <Card title="Grading options for this exam">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Strictness" hint="Leave on 'Use Settings' to follow your global choice.">
              <Select value={overrides.strictness ?? ''} onChange={(e) => (setOverrides({ ...overrides, strictness: (e.target.value || undefined) as typeof overrides.strictness }), touch())}>
                <option value="">Use Settings</option>
                <option value="lenient">Lenient</option>
                <option value="standard">Standard</option>
                <option value="strict">Strict</option>
              </Select>
            </Field>
            <Field label="Half marks">
              <Select value={overrides.allowHalfMarks === undefined ? '' : String(overrides.allowHalfMarks)} onChange={(e) => (setOverrides({ ...overrides, allowHalfMarks: e.target.value === '' ? undefined : e.target.value === 'true' }), touch())}>
                <option value="">Use Settings</option>
                <option value="true">Allowed (e.g. 3.5)</option>
                <option value="false">Whole marks only</option>
              </Select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Notes for the AI evaluator" hint='Short and specific, e.g. "Units are mandatory", "Ignore spelling".'>
                <Textarea value={meta.evaluatorNotes} maxLength={1000} onChange={(e) => (setMeta({ ...meta, evaluatorNotes: e.target.value }), touch())} />
              </Field>
            </div>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-start gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="min-w-0 flex-1 text-sm">
          {readiness.problems.length === 0 ? (
            <p className="flex items-center gap-2 font-medium text-green-700 dark:text-green-400"><CheckCircle2 className="h-4 w-4" /> Ready for grading</p>
          ) : (
            <>
              <p className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400"><AlertTriangle className="h-4 w-4" /> Before grading:</p>
              <ul className="mt-1 list-disc pl-5 text-slate-600 dark:text-slate-300">
                {readiness.problems.slice(0, 6).map((p) => <li key={p}>{p}</li>)}
              </ul>
            </>
          )}
          {readiness.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">
              {readiness.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
        </div>
        <Button icon={<Save className="h-4 w-4" />} busy={save.busy} onClick={() => void doSave()} disabled={!dirty && !proposal && exam.status === 'ready'}>
          Save exam template
        </Button>
      </div>
      <ErrorBanner error={save.error} onDismiss={() => save.setError(null)} />

      <PasteModal doc={paste} onClose={() => setPaste(null)} busy={extract.busy} onSubmit={(doc, text) => void runExtract(doc, text)} />
    </div>
  );
}

function QuestionDetailsEditor({ q, onChange }: { q: Question; onChange: (p: Partial<Question>) => void }) {
  const pts = q.markingPoints;
  const sum = round2(pts.reduce((s, p) => s + p.marks, 0));
  const setPts = (next: Question['markingPoints']) => onChange({ markingPoints: next.map((p, i) => ({ ...p, id: `p${i + 1}` })) });
  return (
    <div className="grid gap-4 py-2 lg:grid-cols-2">
      <div className="space-y-3">
        <Field label="Full question text">
          <Textarea value={q.text} onChange={(e) => onChange({ text: e.target.value })} rows={3} />
        </Field>
        <Field label="Model answer" hint="The expected answer. Formulas in plain text are fine (x^2, sqrt(x)).">
          <Textarea value={q.modelAnswer} onChange={(e) => onChange({ modelAnswer: e.target.value })} rows={5} />
        </Field>
        {q.type !== 'theory' && (
          <Field label="Expected final answer (with units)">
            <Input value={q.finalAnswer} onChange={(e) => onChange({ finalAnswer: e.target.value })} placeholder="e.g. 2.33 ms" />
          </Field>
        )}
        <Toggle checked={q.expectsDiagram} onChange={(v) => onChange({ expectsDiagram: v })} label="A diagram is part of the answer" hint="The AI only sees a description of drawings, so these are flagged for your review." />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-sm font-medium">Marking points</span>
          <span className={cx('text-xs', pts.length && sum !== q.maxMarks ? 'text-amber-600' : 'text-slate-500')}>
            {sum} of {q.maxMarks} marks
          </span>
        </div>
        <div className="space-y-2">
          {pts.map((p, i) => (
            <div key={i} className="flex gap-2">
              <Input value={p.description} placeholder="What earns the marks" onChange={(e) => setPts(pts.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} />
              <Input type="number" min={0} step={0.5} className="w-20" value={p.marks} onChange={(e) => setPts(pts.map((x, k) => (k === i ? { ...x, marks: Number(e.target.value) } : x)))} aria-label="Marks" />
              <button type="button" className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => setPts(pts.filter((_, k) => k !== i))} aria-label="Remove point">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setPts([...pts, { id: 'p0', description: '', marks: 1 }])}>
            Add marking point
          </Button>
          {pts.length === 0 && <p className="text-xs text-slate-500">Without marking points, the AI grades against the model answer as a whole.</p>}
        </div>
      </div>
    </div>
  );
}

function ChoiceRulesEditor({ rules, onChange }: { rules: ChoiceRule[]; onChange: (r: ChoiceRule[]) => void }) {
  return (
    <Card title={'"Answer any N" rules'} actions={<Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...rules, { id: `r${rules.length + 1}`, questionNumbers: [], countBest: 1, description: '' }])}>Add rule</Button>}>
      {rules.length === 0 ? (
        <p className="text-sm text-slate-500">None. Every question counts. Add a rule for instructions like "Answer any 3 of Q5–Q9" (only the best answers count).</p>
      ) : (
        <div className="space-y-2">
          {rules.map((r, i) => (
            <div key={i} className="grid items-center gap-2 md:grid-cols-[1fr_120px_1fr_auto]">
              <Input placeholder="Questions, e.g. 5, 6, 7, 8, 9" value={r.questionNumbers.join(', ')} onChange={(e) => onChange(rules.map((x, k) => (k === i ? { ...x, questionNumbers: e.target.value.split(/[,\s]+/).filter(Boolean) } : x)))} />
              <Input type="number" min={1} value={r.countBest} onChange={(e) => onChange(rules.map((x, k) => (k === i ? { ...x, countBest: Math.max(1, Number(e.target.value)) } : x)))} aria-label="Best N" />
              <Input placeholder="Description (optional)" value={r.description} onChange={(e) => onChange(rules.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)))} />
              <button type="button" className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => onChange(rules.filter((_, k) => k !== i))} aria-label="Delete rule">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PasteModal({ doc, onClose, onSubmit, busy }: { doc: Doc | null; onClose: () => void; onSubmit: (d: Doc, text: string) => void; busy: boolean }) {
  const [text, setText] = useState('');
  useEffect(() => {
    setText('');
  }, [doc]);
  return (
    <Modal
      open={doc !== null}
      onClose={onClose}
      wide
      title={doc ? `Paste the ${DOC_LABEL[doc].toLowerCase()}` : ''}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button icon={<Wand2 className="h-4 w-4" />} busy={busy} disabled={!text.trim()} onClick={() => doc && onSubmit(doc, text)}>Read with AI</Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-slate-500">Uses the grading (text) model, not image reading, so it works with any free model and costs about one request.</p>
      <Textarea className="min-h-[50vh] font-mono text-[13px]" value={text} onChange={(e) => setText(e.target.value)} placeholder={doc === 'modelAnswer' ? 'Q1 (a) A stack is a LIFO structure… [1 mark: definition, 1 mark: property]' : 'Q1 (a) Define a stack. [2]\nQ1 (b) Explain push and pop. [3]'} />
    </Modal>
  );
}
