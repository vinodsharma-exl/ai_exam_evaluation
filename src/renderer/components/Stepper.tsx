/** Step indicator from the screenshot: numbered circles, check when done, blue when current. */
import { Check } from 'lucide-react';
import { Fragment } from 'react';
import { cx } from './ui';

export const WIZARD_STEPS = ['Upload Files', 'Configure Questions', 'Process', 'Review Results'];

export function Stepper({ current, steps = WIZARD_STEPS, onStep }: { current: number; steps?: string[]; onStep?: (i: number) => void }) {
  return (
    <ol className="mb-8 flex items-start" aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = !!onStep && done;
        return (
          <Fragment key={label}>
            <li className="flex w-28 shrink-0 flex-col items-center gap-2 text-center">
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onStep?.(i)}
                aria-current={active ? 'step' : undefined}
                className={cx(
                  'flex h-9 w-9 items-center justify-center rounded-full border-2 text-sm font-semibold transition-colors',
                  done && 'border-brand-600 bg-brand-600 text-white',
                  active && 'border-brand-600 bg-brand-600 text-white ring-4 ring-brand-100 dark:ring-brand-700/40',
                  !done && !active && 'border-slate-300 bg-white text-slate-500 dark:border-slate-600 dark:bg-slate-900',
                  clickable && 'cursor-pointer hover:bg-brand-700',
                )}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </button>
              <span className={cx('text-xs', active ? 'font-semibold text-brand-700 dark:text-brand-100' : 'text-slate-500')}>{label}</span>
            </li>
            {i < steps.length - 1 && <li aria-hidden className={cx('mt-4 h-0.5 flex-1', i < current ? 'bg-brand-600' : 'bg-slate-200 dark:bg-slate-700')} />}
          </Fragment>
        );
      })}
    </ol>
  );
}
