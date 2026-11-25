/** Student Results: search by ID, roll no or name; each student's exam history; open, edit marks, re-export. */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, Search, Users } from 'lucide-react';
import { api, call } from '../lib/api';
import { useAction, useAsync, useDebounced } from '../lib/hooks';
import { useRouter } from '../lib/router';
import { useApp } from '../lib/app-context';
import { fmtDate, fmtMarks } from '../lib/format';
import { Badge, Button, Card, EmptyState, Input, Loading, PageHeader } from '../components/ui';
import { StudentStatusBadge } from '../components/StatusBadges';
import { ErrorBanner } from '../components/ErrorBanner';
import { useTitle } from '../components/Shell';

export function Students({ initialQuery }: { initialQuery: string }) {
  useTitle('Students');
  const { go } = useRouter();
  const { toast } = useApp();
  const [q, setQ] = useState(initialQuery);
  const query = useDebounced(q, 200);
  const res = useAsync(() => call(api.searchStudents(query)), [query]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rebuild = useAction();

  useEffect(() => {
    // Open the only match automatically.
    if (res.data?.length === 1) setOpen(new Set([res.data[0]!.searchKey]));
  }, [res.data]);

  return (
    <>
      <PageHeader
        title="Student Results"
        subtitle="Find any student by ID, roll number or name and see every exam they've taken."
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            busy={rebuild.busy}
            onClick={async () => {
              const r = await rebuild.run(() => call(api.rebuildIndex()));
              if (r) {
                toast(`Search index rebuilt (${r.students} students)`);
                void res.reload();
              }
            }}
          >
            Rebuild search index
          </Button>
        }
      />
      <div className="mb-4 max-w-lg">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Student ID, roll number or name" leading={<Search className="h-4 w-4" />} aria-label="Search" />
      </div>
      <ErrorBanner error={res.error ?? rebuild.error} handlers={{ onRetry: res.reload }} />
      {res.loading && !res.data ? (
        <Loading />
      ) : !res.data?.length ? (
        <Card>
          <EmptyState icon={<Users className="h-10 w-10" />} title={query ? `No student matches "${query}"` : 'No students yet'}>
            {query ? 'Separators are ignored, so "21cs045" finds "21/CS/045".' : 'Students appear here once you add their answer sheets.'}
          </EmptyState>
        </Card>
      ) : (
        <Card padded={false}>
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-8" />
                <th>Student ID</th>
                <th>Name</th>
                <th>Roll no.</th>
                <th>Exams</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {res.data.map((s) => {
                const expanded = open.has(s.searchKey);
                const latest = s.exams[0];
                return [
                  <tr key={s.searchKey} className="cursor-pointer" onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(s.searchKey)) n.delete(s.searchKey); else n.add(s.searchKey); return n; })}>
                    <td>{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="font-medium">{s.displayId}</td>
                    <td>{s.name || '—'}</td>
                    <td>{s.rollNo || '—'}</td>
                    <td>{s.exams.length}</td>
                    <td>{latest && <StudentStatusBadge status={latest.status} />}</td>
                  </tr>,
                  expanded && (
                    <tr key={`${s.searchKey}-h`}>
                      <td />
                      <td colSpan={5} className="bg-slate-50 p-0 dark:bg-slate-800/30">
                        <table className="table-base">
                          <thead>
                            <tr>
                              <th>Exam</th>
                              <th>Date</th>
                              <th>Marks</th>
                              <th>Status</th>
                              <th className="text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.exams.map((x) => (
                              <tr key={`${x.examId}/${x.studentId}`}>
                                <td>{x.examTitle}</td>
                                <td>{fmtDate(x.examDate ?? x.updatedAt)}</td>
                                <td>
                                  <span className="inline-flex flex-wrap items-center gap-1.5">
                                    {x.total === null ? '—' : `${fmtMarks(x.total)} / ${fmtMarks(x.maxTotal)}`}
                                    {x.total !== null && !x.isFinal && <Badge tone="purple">recommended</Badge>}
                                    {x.needsReviewCount > 0 && <Badge tone="red">{x.needsReviewCount} to review</Badge>}
                                  </span>
                                </td>
                                <td><StudentStatusBadge status={x.status} /></td>
                                <td>
                                  <div className="flex justify-end gap-1">
                                    <Button size="sm" variant="outline" onClick={() => go(x.status === 'draft' ? { name: 'evaluate', examId: x.examId, studentId: x.studentId } : { name: 'results', examId: x.examId, studentId: x.studentId })}>Open</Button>
                                    <Button size="sm" variant="ghost" disabled={x.total === null} onClick={() => go({ name: 'finalize', examId: x.examId, studentId: x.studentId })}>Edit marks</Button>
                                    <Button size="sm" variant="ghost" disabled={x.total === null} onClick={() => go({ name: 'report', examId: x.examId, studentId: x.studentId })}>Re-export</Button>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
