/**
 * Exams / Batch ("Reports" in the sidebar): one exam's whole class.
 *   bulk upload (student ID from file names) · class table · average/highest/lowest · Needs Review filter
 *   "Process all (queued)" with an estimate first: students run one at a time within the free limits.
 */
import { useMemo, useState } from 'react';
import { BarChart3, FileSpreadsheet, FileText, Pause, Play, PlayCircle, Upload, Users } from 'lucide-react';
import { ChartCard, ColumnChart, HBarChart } from '../components/Charts';
import type { ClassSummary } from '../../shared/ipc';
import { api, call } from '../lib/api';
import { useAction, useAppEvent, useAsync } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtMarks } from '../lib/format';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Select, cx } from '../components/ui';
import { StudentStatusBadge } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { Dropzone } from '../components/Uploads';
import { EstimateDialog, UsageMeter } from '../components/Usage';
import { useTitle } from '../components/Shell';

type Filter = 'all' | 'review' | 'todo' | 'done';
const FILTERS: Array<{ id: Filter; label: string; match: (r: ClassSummary['rows'][number]) => boolean }> = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'review', label: 'Needs review', match: (r) => r.status === 'needs_review' || r.needsReview > 0 },
  { id: 'todo', label: 'Not processed', match: (r) => r.status === 'draft' || r.status === 'paused' || r.status === 'failed' },
  { id: 'done', label: 'Finalized', match: (r) => r.status === 'finalized' },
];

export function Reports({ initialExamId }: { initialExamId?: string }) {
  useTitle('Reports');
  const { go } = useRouter();
  const { toast, config } = useApp();
  const exams = useAsync(() => call(api.listExams()), []);
  const [examId, setExamId] = useState<string | undefined>(initialExamId);
  const chosen = examId ?? exams.data?.[0]?.id;
  const exam = exams.data?.find((e) => e.id === chosen);
  const summary = useAsync(() => (chosen ? call(api.getClassSummary(chosen)) : Promise.resolve(null)), [chosen]);
  const queue = useAsync(() => call(api.getQueueStatus()), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [estimateFor, setEstimateFor] = useState<string[] | null>(null);
  const act = useAction();
  const upload = useAction();
  const exportAct = useAction();

  useAppEvent('queue:update', (q) => queue.setData(q));
  useAppEvent('job:progress', (p) => {
    if (p.examId === chosen && (p.state === 'completed' || p.state === 'paused' || p.state === 'running')) void summary.reload();
  });

  const rows = useMemo(() => (summary.data?.rows ?? []).filter(FILTERS.find((f) => f.id === filter)!.match), [summary.data, filter]);
  const todo = (summary.data?.rows ?? []).filter((r) => r.status !== 'finalized' && r.status !== 'evaluated' && r.status !== 'needs_review').map((r) => r.studentId);

  const bulk = async (paths?: string[]) => {
    if (!chosen) return;
    const created = await upload.run(() => call(api.bulkCreateFromFiles(chosen, paths)));
    if (created) {
      toast(`${created.length} student${created.length === 1 ? '' : 's'} added`);
      void summary.reload();
    }
  };

  const processAll = async (ids: string[]) => {
    if (!chosen) return;
    const r = await act.run(() => call(api.enqueueAll(chosen, ids)));
    if (r) toast(`${r.queued} answer sheet${r.queued === 1 ? '' : 's'} queued. They run one at a time within your free limits.`, 'info');
    void queue.reload();
  };

  if (exams.loading && !exams.data) return <Loading />;
  if (!exams.data?.length) {
    return (
      <>
        <PageHeader title="Reports" />
        <Card>
          <EmptyState icon={<BarChart3 className="h-10 w-10" />} title="No exams yet" action={<Button onClick={() => go({ name: 'exams' })}>Set up an exam</Button>}>
            Class reports appear once an exam has students.
          </EmptyState>
        </Card>
      </>
    );
  }

  const s = summary.data?.stats;
  const q = queue.data;
  return (
    <>
      <PageHeader
        title="Class Results"
        subtitle="Upload a whole class, process everyone within the free limits, and review."
        actions={
          <Select value={chosen ?? ''} onChange={(e) => setExamId(e.target.value)} className="w-72" aria-label="Exam">
            {exams.data.map((e) => (
              <option key={e.id} value={e.id}>{e.title}</option>
            ))}
          </Select>
        }
      />
      <ErrorBanner error={summary.error ?? act.error} handlers={{ onRetry: summary.reload }} onDismiss={() => act.setError(null)} />
      {exam && exam.status !== 'ready' && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <span className="flex-1">This exam's setup isn't complete. Add max marks and model answers before processing.</span>
          <Button size="sm" onClick={() => go({ name: 'exam-setup', examId: exam.id })}>Open setup</Button>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Students', value: s ? String(s.count) : '—' },
          { label: 'Average', value: s?.average != null ? `${fmtMarks(s.average)} / ${exam?.totalMarks ?? ''}` : '—' },
          { label: 'Highest', value: s?.highest != null ? fmtMarks(s.highest) : '—' },
          { label: 'Lowest', value: s?.lowest != null ? fmtMarks(s.lowest) : '—' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-3xl font-semibold text-navy-900 dark:text-white">{c.value}</div>
            <div className="mt-1 text-sm text-slate-500">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card
            padded={false}
            title={
              <div className="flex gap-1" role="tablist">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={filter === f.id}
                    type="button"
                    onClick={() => setFilter(f.id)}
                    className={cx('rounded-md px-3 py-1 text-sm font-normal', filter === f.id ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}
                  >
                    {f.label}
                    {summary.data && <span className="ml-1 opacity-70">{summary.data.rows.filter(f.match).length}</span>}
                  </button>
                ))}
              </div>
            }
            actions={
              <Button size="sm" icon={<PlayCircle className="h-4 w-4" />} disabled={!todo.length || exam?.status !== 'ready'} onClick={() => (config?.ui.confirmBeforeProcessing ? setEstimateFor(todo) : void processAll(todo))}>
                Process all (queued) · {todo.length}
              </Button>
            }
          >
            {summary.loading && !summary.data ? (
              <Loading />
            ) : rows.length === 0 ? (
              <EmptyState icon={<Users className="h-10 w-10" />} title={filter === 'all' ? 'No students yet' : 'Nobody in this filter'}>
                {filter === 'all' && 'Drop the answer sheets on the right. File names like "21CS045_Asha Kumar.pdf" become the student ID and name.'}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Student ID</th>
                      <th>Name</th>
                      <th>Marks</th>
                      <th>Status</th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.studentId}>
                        <td className="font-medium">{r.displayId}</td>
                        <td>{r.name || '—'}</td>
                        <td>
                          <span className="inline-flex items-center gap-2">
                            {r.total === null ? '—' : `${fmtMarks(r.total)} / ${fmtMarks(r.maxTotal)}`}
                            {r.source === 'ai' && <Badge tone="purple">recommended</Badge>}
                            {r.source === 'final_draft' && <Badge tone="blue">draft</Badge>}
                            {r.needsReview > 0 && <Badge tone="red">{r.needsReview} to review</Badge>}
                          </span>
                        </td>
                        <td><StudentStatusBadge status={r.status} /></td>
                        <td>
                          <div className="flex justify-end gap-1">
                            {r.status === 'draft' ? (
                              <Button size="sm" variant="outline" onClick={() => go({ name: 'evaluate', examId: chosen!, studentId: r.studentId })}>Upload</Button>
                            ) : r.status === 'processing' || r.status === 'paused' || r.status === 'failed' ? (
                              <Button size="sm" variant="outline" onClick={() => go({ name: 'processing', examId: chosen!, studentId: r.studentId })}>Progress</Button>
                            ) : (
                              <Button size="sm" variant="outline" onClick={() => go({ name: 'results', examId: chosen!, studentId: r.studentId })}>View</Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {summary.data && s && s.count > 0 && (
            <>
              <ChartCard
                title="Marks distribution"
                subtitle={`${summary.data.rows.filter((r) => r.total !== null).length} students with marks`}
                chart={<ColumnChart data={s.distribution.map((b) => ({ label: b.bucket, value: b.count }))} valueLabel={(v) => `${v} student${v === 1 ? '' : 's'}`} />}
                table={
                  <table className="table-base">
                    <thead><tr><th>Percentage band</th><th>Students</th></tr></thead>
                    <tbody>{s.distribution.map((b) => <tr key={b.bucket}><td>{b.bucket}</td><td className="tabular-nums">{b.count}</td></tr>)}</tbody>
                  </table>
                }
              />
              <ChartCard
                title="Average score per question"
                subtitle="% of each question's max marks"
                chart={
                  <HBarChart
                    data={summary.data.questionStats.map((q) => ({
                      label: q.label,
                      percent: q.averagePercent,
                      detail: q.average === null ? 'Not graded yet' : `${fmtMarks(q.average)} of ${fmtMarks(q.maxMarks)} marks on average · ${q.graded} student${q.graded === 1 ? '' : 's'}`,
                    }))}
                  />
                }
                table={
                  <table className="table-base">
                    <thead><tr><th>Question</th><th>Max</th><th>Average</th><th>Average %</th><th>Graded</th></tr></thead>
                    <tbody>
                      {summary.data.questionStats.map((q) => (
                        <tr key={q.number}>
                          <td>Q{q.label}</td>
                          <td className="tabular-nums">{fmtMarks(q.maxMarks)}</td>
                          <td className="tabular-nums">{fmtMarks(q.average)}</td>
                          <td className="tabular-nums">{q.averagePercent === null ? '—' : `${Math.round(q.averagePercent)}%`}</td>
                          <td className="tabular-nums">{q.graded}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                }
              />
            </>
          )}
          <Card title="Export">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                icon={<FileSpreadsheet className="h-4 w-4" />}
                busy={exportAct.busy}
                disabled={!chosen}
                onClick={async () => {
                  const rel = await exportAct.run(() => call(api.generateClassSheet(chosen!)));
                  if (rel) {
                    toast('Class sheet created');
                    void call(api.openPath(rel)).catch(() => call(api.showInFolder(rel)));
                  }
                }}
              >
                Class sheet (Excel)
              </Button>
              <Button
                variant="outline"
                icon={<FileText className="h-4 w-4" />}
                busy={exportAct.busy}
                disabled={!chosen || !summary.data?.rows.some((r) => r.total !== null)}
                onClick={async () => {
                  const r = await exportAct.run(() => call(api.generateAllReports(chosen!)));
                  if (r) {
                    toast(`${r.count} PDF report${r.count === 1 ? '' : 's'} created${r.skipped.length ? `; ${r.skipped.length} without marks skipped` : ''}`);
                    void call(api.openDataDir(`exams/${chosen}/students`));
                  }
                }}
              >
                All student PDFs
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-500">Students who aren't finalized get a DRAFT watermark on their PDF and "AI recommended" in the sheet.</p>
            <ErrorBanner error={exportAct.error} onDismiss={() => exportAct.setError(null)} />
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Queue">
            {q ? (
              <div className="space-y-3 text-sm">
                <p>
                  {q.running ? <>Processing <strong>{q.running.studentId}</strong>. </> : q.pending ? 'Waiting. ' : 'Idle. '}
                  {q.pending} in queue.
                </p>
                <div className="flex gap-2">
                  {q.autoRun ? (
                    <Button size="sm" variant="secondary" icon={<Pause className="h-4 w-4" />} onClick={() => void act.run(() => call(api.pause()))}>Pause all</Button>
                  ) : (
                    <Button size="sm" icon={<Play className="h-4 w-4" />} disabled={!q.pending} onClick={() => void act.run(() => call(api.resume()))}>Resume queue</Button>
                  )}
                </div>
                <p className="text-xs text-slate-500">One answer sheet at a time, paced to your per-minute limit. If the daily limit runs out, the queue continues on the next launch or when you press Resume.</p>
              </div>
            ) : (
              <Loading />
            )}
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
              <UsageMeter compact />
            </div>
          </Card>

          <Card title={<span className="flex items-center gap-2"><Upload className="h-4 w-4" /> Bulk upload</span>}>
            <Dropzone compact title="Drop many answer sheets" subtitle='One file per student, or "ID_p1.jpg, ID_p2.jpg"' busy={upload.busy} onPaths={(p) => void bulk(p)} onPick={() => void bulk()} />
            <p className="mt-2 text-xs text-slate-500">Names like <code>21CS045_Asha Kumar.pdf</code> set the student ID and name. Page markers like <code>_p2</code> or <code>(2)</code> are grouped automatically.</p>
            <ErrorBanner error={upload.error} onDismiss={() => upload.setError(null)} />
          </Card>
        </div>
      </div>

      {chosen && estimateFor && (
        <EstimateDialog
          open
          targets={estimateFor.map((studentId) => ({ examId: chosen, studentId }))}
          confirmLabel={`Queue ${estimateFor.length} answer sheet${estimateFor.length === 1 ? '' : 's'}`}
          onClose={() => setEstimateFor(null)}
          onConfirm={() => {
            const ids = estimateFor;
            setEstimateFor(null);
            void processAll(ids);
          }}
        />
      )}
    </>
  );
}
