/**
 * Screen 10: Generate & Download Report. Student PDF, plus the class Excel sheet for the same exam.
 * "Download" means: open it, save a copy anywhere, or show it in its folder.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, FolderOpen, Lock } from 'lucide-react';
import { api, call } from '../lib/api';
import { useAction, useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDateTime, fmtMarks } from '../lib/format';
import { Button, Card, Loading, PageHeader } from '../components/ui';
import { ErrorBanner } from '../components/ErrorBanner';
import { useTitle } from '../components/Shell';

export function Report({ examId, studentId }: { examId: string; studentId: string }) {
  useTitle('Report');
  const { go } = useRouter();
  const { toast } = useApp();
  const data = useAsync(async () => {
    const [b, exam, final] = await Promise.all([call(api.getStudentBundle(examId, studentId)), call(api.getExam(examId)), call(api.getFinalDraft(examId, studentId))]);
    return { ...b, exam, finalDraft: final };
  }, [examId, studentId]);
  const [pdf, setPdf] = useState<string | null>(null);
  const [xlsx, setXlsx] = useState<string | null>(null);
  const act = useAction();

  const saveCopy = async (rel: string) => {
    const p = await act.run(() => call(api.saveCopyAs(rel)));
    if (p) toast(`Saved to ${p}`);
  };

  if (data.loading && !data.data) return <Loading />;
  if (data.error) return <ErrorBanner error={data.error} handlers={{ onRetry: data.reload }} />;
  const d = data.data!;
  const isFinal = d.final?.status === 'finalized';
  const f = d.finalDraft;

  return (
    <>
      <PageHeader
        title="Generate & Download Report"
        subtitle={`${d.student.displayId}${d.student.name ? ` · ${d.student.name}` : ''} · ${d.exam.title}`}
        actions={<Button variant="secondary" onClick={() => go({ name: 'results', examId, studentId })}>Back to results</Button>}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={<span className="flex items-center gap-2"><FileText className="h-4 w-4 text-red-600" /> Student report (PDF)</span>}>
          <div className="space-y-4">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold">{fmtMarks(f.total)} / {fmtMarks(f.maxTotal)}</span>
              <span className="text-slate-500">{fmtMarks(f.percentage)}%{f.grade ? ` · Grade ${f.grade}` : ''}</span>
            </div>
            {isFinal ? (
              <p className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"><Lock className="h-4 w-4" /> Finalized by {d.final!.finalizedBy} on {fmtDateTime(d.final!.finalizedAt)}</p>
            ) : (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Marks are not finalized, so the report will be watermarked <strong>DRAFT</strong>{d.final ? '' : ' and use the AI recommendations'}.{' '}
                  <button type="button" className="font-medium underline" onClick={() => go({ name: 'finalize', examId, studentId })}>Review and finalize</button>
                </span>
              </div>
            )}
            {pdf ? (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/30">
                <p className="flex items-center gap-2 font-semibold text-green-800 dark:text-green-300"><CheckCircle2 className="h-5 w-5" /> Report Generated Successfully!</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button icon={<FileText className="h-4 w-4" />} onClick={() => void act.run(() => call(api.openPath(pdf)))}>Open PDF Report</Button>
                  <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => void saveCopy(pdf)}>Save a copy…</Button>
                  <Button variant="ghost" icon={<FolderOpen className="h-4 w-4" />} onClick={() => void act.run(() => call(api.showInFolder(pdf)))}>Open folder</Button>
                </div>
              </div>
            ) : (
              <Button
                size="lg"
                icon={<FileText className="h-4 w-4" />}
                busy={act.busy}
                onClick={async () => {
                  const rel = await act.run(() => call(api.generateStudentReport(examId, studentId)));
                  if (rel) setPdf(rel);
                }}
              >
                {d.final?.reportGeneratedAt ? 'Generate again' : 'Generate PDF report'}
              </Button>
            )}
            {d.final?.reportGeneratedAt && !pdf && <p className="text-xs text-slate-500">Last generated {fmtDateTime(d.final.reportGeneratedAt)}.</p>}
            <p className="text-xs text-slate-500">Includes question-wise marks, your comments and overall comment. Private notes are never printed. The footer notes that AI assisted and that you reviewed the marks.</p>
          </div>
        </Card>

        <Card title={<span className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-green-700" /> Class sheet (Excel)</span>}>
          <div className="space-y-4 text-sm">
            <p>One row per student in <strong>{d.exam.title}</strong>: question-wise marks, total, %, grade, and whether each mark is final or still an AI recommendation. Plus class averages and per-question statistics.</p>
            {xlsx ? (
              <div className="rounded-xl border border-green-200 bg-green-50 p-4 dark:border-green-900 dark:bg-green-950/30">
                <p className="flex items-center gap-2 font-semibold text-green-800 dark:text-green-300"><CheckCircle2 className="h-5 w-5" /> Class sheet ready</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => void act.run(() => call(api.openPath(xlsx)))}>Open in Excel</Button>
                  <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => void saveCopy(xlsx)}>Save a copy…</Button>
                  <Button variant="ghost" icon={<FolderOpen className="h-4 w-4" />} onClick={() => void act.run(() => call(api.showInFolder(xlsx)))}>Open folder</Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                icon={<FileSpreadsheet className="h-4 w-4" />}
                busy={act.busy}
                onClick={async () => {
                  const rel = await act.run(() => call(api.generateClassSheet(examId)));
                  if (rel) setXlsx(rel);
                }}
              >
                Download Excel
              </Button>
            )}
          </div>
        </Card>
      </div>
      <div className="mt-4">
        <ErrorBanner error={act.error} onDismiss={() => act.setError(null)} />
      </div>
    </>
  );
}
