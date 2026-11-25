/**
 * The "New Evaluation" wizard from the screenshot:
 *   1 Upload Files → 2 Configure Questions → 3 Process → 4 Review Results
 * Step 1 also picks the exam and the student. Steps 3 and 4 are the Processing and Results screens.
 */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Plus, UserRound } from 'lucide-react';
import type { ExamFile } from '../../shared/schemas/exam';
import type { StudentFile } from '../../shared/schemas/student';
import type { UploadedPagePreview } from '../../shared/ipc';
import { api, call } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useRouter, type Route } from '../lib/router';
import { useApp } from '../lib/app-context';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, Select } from '../components/ui';
import { Stepper } from '../components/Stepper';
import { Dropzone, PageGrid } from '../components/Uploads';
import { ErrorBanner } from '../components/ErrorBanner';
import { ExamEditor } from '../components/ExamEditor';
import { EstimateDialog } from '../components/Usage';
import { NewExamModal } from './Exams';
import { useTitle } from '../components/Shell';

export function Evaluate({ route }: { route: Extract<Route, { name: 'evaluate' }> }) {
  useTitle('New Evaluation');
  const { go } = useRouter();
  const { config } = useApp();
  const [examId, setExamId] = useState<string | undefined>(route.examId);
  const [studentId, setStudentId] = useState<string | undefined>(route.studentId);
  const [step, setStep] = useState<0 | 1>(route.step === 2 ? 1 : 0);
  const [estimate, setEstimate] = useState(false);
  const exams = useAsync(() => call(api.listExams()), []);
  const exam = exams.data?.find((e) => e.id === examId);
  const start = useAction();

  const begin = async () => {
    if (!examId || !studentId) return;
    const job = await start.run(() => call(api.startProcessing(examId, studentId)));
    if (job) go({ name: 'processing', examId, studentId });
  };

  return (
    <>
      <PageHeader title="New Evaluation" subtitle="Upload a student's answer sheet, check the questions, and let the AI recommend marks." />
      <Stepper current={step} onStep={(i) => i < step && setStep(i as 0)} />
      {step === 0 && (
        <UploadStep
          exams={exams.data}
          examId={examId}
          setExamId={(id) => {
            setExamId(id);
            setStudentId(undefined);
          }}
          studentId={studentId}
          setStudentId={setStudentId}
          onReloadExams={exams.reload}
          onNext={() => setStep(1)}
        />
      )}
      {step === 1 && exam && (
        <div className="space-y-4">
          <ExamEditor exam={exam} compact onSaved={() => void exams.reload()} />
          <ErrorBanner error={start.error} handlers={{ onRetry: () => void begin() }} />
          <div className="flex justify-between">
            <Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep(0)}>Back</Button>
            <Button
              busy={start.busy}
              disabled={exam.status !== 'ready'}
              title={exam.status !== 'ready' ? 'Save the exam once the checklist is green' : undefined}
              onClick={() => (config?.ui.confirmBeforeProcessing ? setEstimate(true) : void begin())}
            >
              Next: Process <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          {examId && studentId && (
            <EstimateDialog
              open={estimate}
              targets={[{ examId, studentId }]}
              onClose={() => setEstimate(false)}
              onConfirm={() => {
                setEstimate(false);
                void begin();
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

function UploadStep({
  exams,
  examId,
  setExamId,
  studentId,
  setStudentId,
  onReloadExams,
  onNext,
}: {
  exams: ExamFile[] | null;
  examId?: string;
  setExamId: (id: string) => void;
  studentId?: string;
  setStudentId: (id: string | undefined) => void;
  onReloadExams: () => Promise<void>;
  onNext: () => void;
}) {
  const [newExam, setNewExam] = useState(false);
  const [form, setForm] = useState({ displayId: '', name: '', rollNo: '' });
  const [student, setStudent] = useState<StudentFile | null>(null);
  const [previews, setPreviews] = useState<UploadedPagePreview[]>([]);
  const act = useAction();
  const upload = useAction();

  // Load the chosen student's pages (when resuming a draft).
  useEffect(() => {
    if (!examId || !studentId) {
      setStudent(null);
      setPreviews([]);
      return;
    }
    void call(api.getStudentBundle(examId, studentId)).then((b) => setStudent(b.student));
    void call(api.getPagePreviews(examId, studentId)).then(setPreviews).catch(() => setPreviews([]));
  }, [examId, studentId]);

  const createStudent = async () => {
    if (!examId) return;
    const s = await act.run(async () => {
      try {
        return await call(api.createStudent(examId, form));
      } catch (e) {
        // Same ID in this exam: continue with the existing student instead of failing.
        const existing = (await call(api.listStudents(examId))).find((x) => x.displayId.toLowerCase() === form.displayId.trim().toLowerCase());
        if (existing) return existing;
        throw e;
      }
    });
    if (s) {
      setStudent(s);
      setStudentId(s.id);
    }
  };

  const addFiles = async (paths?: string[]) => {
    if (!examId || !studentId) return;
    const p = await upload.run(() => call(api.addUploads(examId, studentId, paths)));
    if (p) {
      setPreviews(p);
      setStudent((await call(api.getStudentBundle(examId, studentId))).student);
    }
  };

  if (!exams) return <Loading />;
  const ready = exams.filter((e) => e.status !== 'archived');

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="1. Exam">
          <div className="space-y-3">
            <Field label="Which exam is this answer sheet for?">
              <Select value={examId ?? ''} onChange={(e) => setExamId(e.target.value)}>
                <option value="" disabled>Choose an exam…</option>
                {ready.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                    {e.courseCode ? ` (${e.courseCode})` : ''}
                    {e.status === 'draft' ? '  · setup incomplete' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setNewExam(true)}>
              New exam
            </Button>
          </div>
        </Card>

        <Card title="2. Student">
          {student ? (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-100 text-brand-700"><UserRound className="h-5 w-5" /></div>
              <div className="flex-1">
                <p className="font-semibold">{student.displayId}</p>
                <p className="text-sm text-slate-500">{student.name || 'No name'}{student.rollNo ? ` · Roll ${student.rollNo}` : ''}</p>
              </div>
              <Badge>{student.uploads.length} file{student.uploads.length === 1 ? '' : 's'}</Badge>
              <Button size="sm" variant="ghost" onClick={() => setStudentId(undefined)}>Change</Button>
            </div>
          ) : (
            <form
              className="grid gap-3 sm:grid-cols-[1fr_1fr_100px_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                void createStudent();
              }}
            >
              <Field label="Student ID" required>
                <Input value={form.displayId} onChange={(e) => setForm({ ...form, displayId: e.target.value })} placeholder="21/CS/045" disabled={!examId} />
              </Field>
              <Field label="Name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!examId} />
              </Field>
              <Field label="Roll no.">
                <Input value={form.rollNo} onChange={(e) => setForm({ ...form, rollNo: e.target.value })} disabled={!examId} />
              </Field>
              <Button type="submit" busy={act.busy} disabled={!examId || !form.displayId.trim()}>Add</Button>
            </form>
          )}
          <div className="mt-2">
            <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
          </div>
        </Card>
      </div>

      <Card title="3. Upload Student Answer Sheet">
        {!studentId || !examId ? (
          <p className="text-sm text-slate-500">Choose the exam and add the student first.</p>
        ) : (
          <div className="space-y-5">
            <Dropzone
              title="Upload Student Answer Sheet (PDF or photos)"
              subtitle="Supports scanned PDFs (multiple pages) and phone photos (JPG/PNG). You can add several files."
              busy={upload.busy}
              onPaths={(p) => void addFiles(p)}
              onPick={() => void addFiles()}
            />
            <ErrorBanner error={upload.error} onDismiss={() => upload.setError(null)} />
            {student && <PageGrid examId={examId} studentId={studentId} previews={previews} uploads={student.uploads} onChanged={setPreviews} />}
          </div>
        )}
      </Card>

      <div className="flex justify-end">
        <Button disabled={!studentId || previews.length === 0} onClick={onNext}>
          Next <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <NewExamModal
        open={newExam}
        onClose={() => setNewExam(false)}
        onCreated={(id) => {
          void onReloadExams().then(() => setExamId(id));
        }}
      />
    </div>
  );
}
