/** Screen 2: Dashboard. Stat cards, Start New Evaluation, recent evaluations, and today's AI usage. */
import { ClipboardList, Plus, Users } from 'lucide-react';
import { api, call } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useApp } from '../lib/app-context';
import { useRouter } from '../lib/router';
import { fmtDate, fmtMarks } from '../lib/format';
import { Button, Card, EmptyState, Loading, PageHeader } from '../components/ui';
import { StudentStatusBadge } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { UsageMeter } from '../components/Usage';
import { useTitle } from '../components/Shell';

export function Dashboard() {
  useTitle('Dashboard');
  const { profile } = useApp();
  const { go } = useRouter();
  const { data, error, loading, reload } = useAsync(() => call(api.getDashboard()), []);

  const stats = data
    ? [
        { value: data.studentsEvaluated, label: 'Answer Sheets Evaluated', color: 'text-brand-600' },
        { value: data.inProgress, label: 'In Progress', color: 'text-slate-800 dark:text-white' },
        { value: data.needsReview, label: 'Needs Review', color: 'text-amber-500' },
        { value: data.finalized, label: 'Finalized', color: 'text-green-600' },
      ]
    : [];

  return (
    <>
      <PageHeader
        title={`Welcome, ${[profile?.title, profile?.name].filter(Boolean).join(' ')}`}
        subtitle="Evaluate answer sheets quickly and accurately using AI."
      />
      <ErrorBanner error={error} handlers={{ onRetry: reload }} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                  <div className={`text-4xl font-semibold ${s.color}`}>{s.value}</div>
                  <div className="mt-2 text-sm text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button size="lg" icon={<Plus className="h-4 w-4" />} onClick={() => go({ name: 'evaluate' })}>
                Start New Evaluation
              </Button>
              <Button size="lg" variant="secondary" icon={<Users className="h-4 w-4" />} onClick={() => go({ name: 'reports' })}>
                Evaluate a whole class
              </Button>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
              <Card title="Recent Evaluations" padded={false}>
                {data.recent.length === 0 ? (
                  <EmptyState icon={<ClipboardList className="h-10 w-10" />} title="No evaluations yet">
                    Start with one student's answer sheet, or set up an exam and upload the whole class.
                  </EmptyState>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="table-base">
                      <thead>
                        <tr>
                          <th>Student ID</th>
                          <th>Name</th>
                          <th>Exam Name</th>
                          <th>Updated</th>
                          <th>Marks</th>
                          <th>Status</th>
                          <th className="text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.recent.map((r) => (
                          <tr key={`${r.examId}/${r.studentId}`}>
                            <td className="font-medium">{r.displayId}</td>
                            <td>{r.name || '—'}</td>
                            <td>{r.examTitle}</td>
                            <td>{fmtDate(r.updatedAt)}</td>
                            <td>{r.total === null ? '—' : `${fmtMarks(r.total)} / ${fmtMarks(r.maxTotal)}`}</td>
                            <td><StudentStatusBadge status={r.status} /></td>
                            <td className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  go(
                                    r.status === 'draft'
                                      ? { name: 'evaluate', examId: r.examId, studentId: r.studentId }
                                      : r.status === 'processing' || r.status === 'paused'
                                        ? { name: 'processing', examId: r.examId, studentId: r.studentId }
                                        : { name: 'results', examId: r.examId, studentId: r.studentId },
                                  )
                                }
                              >
                                View
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card title="AI usage today" actions={<Button size="sm" variant="ghost" onClick={() => go({ name: 'settings', tab: 'models' })}>Models</Button>}>
                <UsageMeter />
                <p className="mt-4 text-xs text-slate-500">
                  {data.requestsToday} request{data.requestsToday === 1 ? '' : 's'} sent today. Free limits reset daily; finished pages are never sent twice.
                </p>
              </Card>
            </div>
          </div>
        )
      )}
    </>
  );
}
