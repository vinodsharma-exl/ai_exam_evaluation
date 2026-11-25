/**
 * Shows an error the way the brief asks: plain title, what happened, and the next action as a button.
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, Clock } from 'lucide-react';
import { ERROR_INFO, type AppErrorData, type ErrorCode, type NextAction } from '../../shared/errors';
import { useRouter } from '../lib/router';
import { useCountdown } from '../lib/hooks';
import { fmtDuration } from '../lib/format';
import { Button } from './ui';

export interface ErrorHandlers {
  onRetry?: () => void;
  onEnterManually?: () => void;
  onRescan?: () => void;
}

export function ErrorBanner({ error, handlers = {}, onDismiss }: { error: AppErrorData | null; handlers?: ErrorHandlers; onDismiss?: () => void }) {
  const { go } = useRouter();
  const [details, setDetails] = useState(false);
  const countdown = useCountdown(error?.resumeAt ?? null);
  if (!error) return null;
  const info = ERROR_INFO[error.code as ErrorCode] ?? ERROR_INFO.UNKNOWN;
  const waiting = error.code === 'RATE_LIMITED' || error.code === 'PROVIDER_UNAVAILABLE';

  const button = (a: NextAction) => {
    switch (a) {
      case 'open_settings_keys':
        return <Button key={a} size="sm" onClick={() => go({ name: 'settings', tab: 'providers' })}>Open API key settings</Button>;
      case 'open_settings_models':
      case 'switch_ocr_model':
        return <Button key={a} size="sm" variant={a === 'switch_ocr_model' ? 'primary' : 'secondary'} onClick={() => go({ name: 'settings', tab: 'models' })}>Choose another model</Button>;
      case 'open_settings_limits':
        return <Button key={a} size="sm" variant="secondary" onClick={() => go({ name: 'settings', tab: 'providers' })}>Edit limits</Button>;
      case 'enter_text_manually':
        return handlers.onEnterManually ? <Button key={a} size="sm" variant="secondary" onClick={handlers.onEnterManually}>Type the text instead</Button> : null;
      case 'rescan_page':
        return handlers.onRescan ? <Button key={a} size="sm" variant="secondary" onClick={handlers.onRescan}>Replace the scan</Button> : null;
      case 'retry':
      case 'resume_tomorrow':
        return handlers.onRetry ? <Button key={a} size="sm" variant="secondary" onClick={handlers.onRetry}>{a === 'retry' ? 'Try again' : 'Resume'}</Button> : null;
      case 'choose_data_folder':
      case 'restore_backup':
        return <Button key={a} size="sm" variant="secondary" onClick={() => go({ name: 'settings', tab: 'data' })}>Data settings</Button>;
      case 'open_exam_setup':
        return null; // screens that know the exam show their own link
      default:
        return null;
    }
  };

  return (
    <div role="alert" className={`rounded-lg border p-4 ${waiting ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40' : 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'}`}>
      <div className="flex items-start gap-3">
        {waiting ? <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900 dark:text-white">{info.title}</p>
          <p className="mt-0.5 text-sm text-slate-700 dark:text-slate-300">
            {info.message}
            {countdown > 0 && <strong> Resuming in {fmtDuration(countdown)}.</strong>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {info.actions.map(button)}
            {onDismiss && <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>}
            {error.detail && (
              <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:underline" onClick={() => setDetails((d) => !d)}>
                Details <ChevronDown className={`h-3 w-3 transition-transform ${details ? 'rotate-180' : ''}`} />
              </button>
            )}
          </div>
          {details && error.detail && <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-white/70 p-2 font-mono text-xs text-slate-600 dark:bg-black/30 dark:text-slate-400">{error.detail}</pre>}
        </div>
      </div>
    </div>
  );
}
