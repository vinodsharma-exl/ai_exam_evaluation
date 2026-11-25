/** "Question Paper & Model": exam templates (list, create, duplicate) and the full setup editor. */
import { useState } from 'react';
import { BookOpen, Copy, FileSearch, Pencil, Plus, Users } from 'lucide-react';
import { api, call } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDate } from '../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader } from '../components/ui';
import { ErrorBanner } from '../components/ErrorBanner';
import { ExamEditor } from '../components/ExamEditor';
import { useTitle } from '../components/Shell';

export function ExamsScreen() {
  useTitle('Question Paper & Model');
  const { go } = useRouter();
  const { toast } = useApp();
  const { data: exams, error, loading, reload } = useAsync(() => call(api.listExams()), []);
  const [creating, setCreating] = useState(false);
  const [dup, setDup] = useState<{ id: string; title: string } | null>(null);
  const act = useAction();

  return (
    <>
      <PageHeader
        title="Question Paper & Model Answers"
        subtitle="Set up each exam once (questions, marks, model answers). It is reused for every student in that exam."
        actions={<Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New exam</Button>}
      />
      <ErrorBanner error={error ?? act.error} handlers={{ onRetry: reload }} />
      {loading && !exams ? (
        <Loading />
      ) : !exams?.length ? (
        <Card>
          <EmptyState icon={<BookOpen className="h-10 w-10" />} title="No exams yet" action={<Button onClick={() => setCreating(true)}>Create your first exam</Button>}>
            An exam holds the question paper, max marks and model answers. Upload a handwritten or typed paper and the AI fills in the table for you to check.
          </EmptyState>
        </Card>
      ) : (
        <Card padded={false}>
          <table className="table-base">
            <thead>
              <tr>
                <th>Exam</th>
                <th>Course</th>
                <th>Date</th>
                <th>Questions</th>
                <th>Total marks</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.id}>
                  <td className="font-medium">{e.title}</td>
                  <td>{e.courseCode || '—'}</td>
                  <td>{fmtDate(e.examDate)}</td>
                  <td>{e.questions.length}</td>
                  <td>{e.totalMarks}</td>
                  <td>{e.status === 'ready' ? <Badge tone="green">Ready</Badge> : e.status === 'archived' ? <Badge>Archived</Badge> : <Badge tone="orange">Draft</Badge>}</td>
                  <td>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => go({ name: 'exam-setup', examId: e.id })}>Edit</Button>
                      <Button size="sm" variant="ghost" icon={<FileSearch className="h-3.5 w-3.5" />} disabled={e.status !== 'ready'} onClick={() => go({ name: 'evaluate', examId: e.id })}>Evaluate</Button>
                      <Button size="sm" variant="ghost" icon={<Users className="h-3.5 w-3.5" />} onClick={() => go({ name: 'reports', examId: e.id })}>Class</Button>
                      <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} title="Duplicate (e.g. same paper, another section)" onClick={() => setDup({ id: e.id, title: `${e.title} (copy)` })} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <NewExamModal open={creating} onClose={() => setCreating(false)} onCreated={(id) => go({ name: 'exam-setup', examId: id })} />
      <Modal
        open={!!dup}
        onClose={() => setDup(null)}
        title="Duplicate exam"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDup(null)}>Cancel</Button>
            <Button
              busy={act.busy}
              onClick={async () => {
                const e = await act.run(() => call(api.duplicateExam(dup!.id, dup!.title)));
                setDup(null);
                if (e) {
                  toast('Exam duplicated');
                  void reload();
                }
              }}
            >
              Duplicate
            </Button>
          </>
        }
      >
        <Field label="New title" hint="Questions, marks and model answers are copied. Students are not.">
          <Input value={dup?.title ?? ''} onChange={(e) => setDup(dup && { ...dup, title: e.target.value })} />
        </Field>
      </Modal>
    </>
  );
}

export function NewExamModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (examId: string) => void }) {
  const [f, setF] = useState({ title: '', courseCode: '', subject: '', className: '', examDate: '' });
  const act = useAction();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New exam"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            busy={act.busy}
            disabled={!f.title.trim()}
            onClick={async () => {
              const e = await act.run(() => call(api.createExam({ ...f, examDate: f.examDate || null })));
              if (e) {
                onClose();
                onCreated(e.id);
              }
            }}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Field label="Exam title" required>
            <Input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Data Structures Midterm" />
          </Field>
        </div>
        <Field label="Course code">
          <Input value={f.courseCode} onChange={(e) => setF({ ...f, courseCode: e.target.value })} placeholder="CS201" />
        </Field>
        <Field label="Exam date">
          <Input type="date" value={f.examDate} onChange={(e) => setF({ ...f, examDate: e.target.value })} />
        </Field>
        <Field label="Subject">
          <Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </Field>
        <Field label="Class / section">
          <Input value={f.className} onChange={(e) => setF({ ...f, className: e.target.value })} placeholder="B.Sc. CS Sem 3 – A" />
        </Field>
      </div>
      <div className="mt-3">
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

export function ExamSetupScreen({ examId }: { examId: string }) {
  const { go, back, canGoBack } = useRouter();
  const { data: exam, error, loading, reload } = useAsync(() => call(api.getExam(examId)), [examId]);
  useTitle(exam ? `Setup · ${exam.title}` : 'Exam setup');
  return (
    <>
      <PageHeader
        title={exam ? exam.title : 'Exam setup'}
        subtitle="Question paper, max marks and model answers. Save when the checklist is green."
        actions={
          <>
            {canGoBack && <Button variant="secondary" onClick={back}>Back</Button>}
            <Button variant="outline" disabled={exam?.status !== 'ready'} onClick={() => go({ name: 'evaluate', examId })}>Evaluate a student</Button>
            <Button variant="outline" onClick={() => go({ name: 'reports', examId })}>Class view</Button>
          </>
        }
      />
      <ErrorBanner error={error} handlers={{ onRetry: reload }} />
      {loading && !exam ? <Loading /> : exam && <ExamEditor exam={exam} />}
    </>
  );
}
