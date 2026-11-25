import type { StudentStatus } from '../../shared/schemas/student';

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtMarks(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

export function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtMinutes(min: number): string {
  if (min < 1) return 'under a minute';
  if (min < 60) return `about ${Math.ceil(min)} minute${Math.ceil(min) === 1 ? '' : 's'}`;
  return `about ${Math.floor(min / 60)}h ${Math.round(min % 60)}m`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  draft: 'Not processed',
  processing: 'In progress',
  paused: 'Paused',
  needs_review: 'Needs review',
  evaluated: 'Completed',
  finalized: 'Finalized',
  failed: 'Failed',
};

export function greeting(name: string, title: string): string {
  return [title, name].filter(Boolean).join(' ');
}
