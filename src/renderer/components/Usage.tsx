/**
 * Free-tier awareness in the UI: today's usage per model, and the estimate shown before any job starts.
 */
import { useEffect, useState } from 'react';
import { Gauge, Info, AlertTriangle } from 'lucide-react';
import type { AppEvents, UsageEstimate } from '../../shared/ipc';
import { api, call } from '../lib/api';
import { useAppEvent } from '../lib/hooks';
import { fmtMinutes } from '../lib/format';
import { useApp } from '../lib/app-context';
import { Button, Modal, ProgressBar, Spinner } from './ui';

type Snap = AppEvents['usage:update'];

export function useUsageSummary() {
  const [usage, setUsage] = useState<{ ocr: Snap; evaluation: Snap } | null>(null);
  const load = () => void call(api.getUsageSummary()).then(setUsage).catch(() => undefined);
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useAppEvent('usage:update', (u) => setUsage((cur) => (cur ? { ocr: cur.ocr.key === u.key ? u : cur.ocr, evaluation: cur.evaluation.key === u.key ? u : cur.evaluation } : cur)));
  useAppEvent('config:changed', load);
  return usage;
}

function modelName(key: string): string {
  return key.split(':').slice(1).join(':');
}

export function UsageMeter({ compact }: { compact?: boolean }) {
  const usage = useUsageSummary();
  if (!usage) return null;
  const rows = usage.ocr.key === usage.evaluation.key ? [{ label: 'Reading + grading', s: usage.ocr }] : [{ label: 'Reading (OCR)', s: usage.ocr }, { label: 'Grading', s: usage.evaluation }];
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {rows.map(({ label, s }) => (
        <div key={label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-slate-600 dark:text-slate-400">
              {label} · <span className="font-mono">{modelName(s.key)}</span>
            </span>
            <span className="font-medium">
              {s.usedToday}
              {s.dailyLimit !== null ? ` / ${s.dailyLimit}` : ''} today · {s.rpm}/min
            </span>
          </div>
          {s.dailyLimit !== null && <ProgressBar value={s.usedToday} max={s.dailyLimit} tone={s.usedToday / s.dailyLimit > 0.85 ? 'orange' : 'blue'} />}
        </div>
      ))}
    </div>
  );
}

/**
 * "~24 requests, about 6 minutes on your free limit". Shown before starting unless turned off in Settings.
 * Calls onConfirm when the professor goes ahead.
 */
export function EstimateDialog({
  open,
  targets,
  onClose,
  onConfirm,
  confirmLabel = 'Start evaluation',
}: {
  open: boolean;
  targets: Array<{ examId: string; studentId: string }>;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
}) {
  const [est, setEst] = useState<UsageEstimate | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { updateConfig } = useApp();
  useEffect(() => {
    if (!open) return;
    setEst(null);
    setErr(null);
    call(api.estimateUsage(targets)).then(setEst, (e) => setErr(String(e?.message ?? e)));
  }, [open, JSON.stringify(targets)]); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = est ? Object.entries(est.remainingToday) : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Before you start"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onConfirm} disabled={!est}>{confirmLabel}</Button>
        </>
      }
    >
      {!est && !err && <Spinner />}
      {err && <p className="text-sm text-red-600">{err}</p>}
      {est && (
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-3 rounded-lg bg-brand-50 p-4 dark:bg-brand-700/20">
            <Gauge className="mt-0.5 h-5 w-5 text-brand-600" />
            <div>
              <p className="text-base font-semibold">
                ~{est.requests} AI request{est.requests === 1 ? '' : 's'}, {fmtMinutes(est.minutes)} on your limits
              </p>
              <p className="text-slate-600 dark:text-slate-300">
                {est.byStage.ocr} to read pages · {est.byStage.evaluation} to grade
                {est.cachedSkips > 0 && ` · ${est.cachedSkips} page${est.cachedSkips === 1 ? '' : 's'} already done or blank (free)`}
              </p>
            </div>
          </div>
          {remaining.length > 0 && (
            <ul className="space-y-1">
              {remaining.map(([k, left]) => (
                <li key={k} className="flex justify-between">
                  <span className="font-mono text-xs text-slate-500">{k}</span>
                  <span>{left === null ? 'no daily cap' : `${left} left today`}</span>
                </li>
              ))}
            </ul>
          )}
          {!est.fitsToday && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              This may go over today's free limit. Work pauses safely when the limit is reached and resumes tomorrow without repeating finished pages.
            </p>
          )}
          <p className="flex items-start gap-2 text-xs text-slate-500">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Estimates are rough. Requests are spaced out to respect per-minute limits, so the app may pause briefly between pages.
          </p>
          <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => void updateConfig({ ui: { confirmBeforeProcessing: false } }).then(onConfirm)}>
            Don't show this again and start
          </button>
        </div>
      )}
    </Modal>
  );
}
