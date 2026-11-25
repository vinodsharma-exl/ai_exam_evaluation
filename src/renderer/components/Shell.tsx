/** App frame from the screenshot: navy sidebar with logo and nav, top bar with search and the professor's name. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileSearch, FileText, GraduationCap, LayoutDashboard, LogOut, Search, Settings, Users, BarChart3, CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { useRouter, type Route } from '../lib/router';
import { useApp } from '../lib/app-context';
import { useShortcuts } from '../lib/hooks';
import { cx, Kbd } from './ui';

const NAV: Array<{ label: string; icon: typeof LayoutDashboard; route: Route; match: Route['name'][] }> = [
  { label: 'Dashboard', icon: LayoutDashboard, route: { name: 'dashboard' }, match: ['dashboard'] },
  { label: 'Evaluate Answer Sheet', icon: FileSearch, route: { name: 'evaluate' }, match: ['evaluate', 'processing', 'results', 'question', 'finalize'] },
  { label: 'Question Paper & Model', icon: FileText, route: { name: 'exams' }, match: ['exams', 'exam-setup'] },
  { label: 'Students', icon: Users, route: { name: 'students' }, match: ['students'] },
  { label: 'Reports', icon: BarChart3, route: { name: 'reports' }, match: ['reports', 'report'] },
  { label: 'Settings', icon: Settings, route: { name: 'settings' }, match: ['settings'] },
];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <GraduationCap className={compact ? 'h-6 w-6' : 'h-7 w-7'} />
      <span className="text-[15px] font-semibold tracking-tight">AnswerEval AI</span>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { route, go } = useRouter();
  const { profile, setProfile } = useApp();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [q, setQ] = useState('');
  // Braces matter: in current Chromium, scrollTo() returns a Promise, and React must not get it as a cleanup.
  useEffect(() => {
    mainRef.current?.scrollTo(0, 0);
  }, [route]);

  useShortcuts({ 'ctrl+f': () => searchRef.current?.focus() });

  const initials = (profile?.name ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col bg-navy-900 text-navy-300">
        <div className="px-5 py-5 text-white">
          <Logo />
        </div>
        <nav className="flex-1 space-y-1 px-3" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            const Icon = n.icon;
            return (
              <button
                key={n.label}
                type="button"
                onClick={() => go(n.route)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors',
                  active ? 'bg-brand-600 font-medium text-white' : 'hover:bg-navy-800 hover:text-white',
                )}
              >
                <Icon className="h-4.5 w-4.5 shrink-0" />
                {n.label}
              </button>
            );
          })}
        </nav>
        <div className="border-t border-navy-800 px-5 py-4 text-[11px] leading-relaxed text-navy-300/80">
          AI marks are <span className="text-white">recommendations</span>. You decide the final marks.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-4 border-b border-slate-200 bg-white px-6 dark:border-slate-800 dark:bg-slate-900">
          <form
            className="relative w-full max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              go({ name: 'students', query: q.trim() });
            }}
          >
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search student ID or name…"
              aria-label="Search students"
              className="input pl-9 pr-16"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2">
              <Kbd>Ctrl F</Kbd>
            </span>
          </form>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">{initials}</div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{[profile?.title, profile?.name].filter(Boolean).join(' ')}</div>
              <div className="text-xs text-slate-500">{profile?.department || 'Professor'}</div>
            </div>
            <button type="button" title="Sign out" onClick={() => setProfile(null)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </header>
        <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-8 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

/* Toast stack, bottom-right. */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-96 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertTriangle : Info;
        return (
          <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-800">
            <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', t.kind === 'success' ? 'text-green-600' : t.kind === 'error' ? 'text-red-600' : 'text-brand-600')} />
            <p className="flex-1 text-sm">{t.text}</p>
            <button type="button" onClick={() => dismissToast(t.id)} className="text-slate-400 hover:text-slate-600" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Sets the window title to the current screen. */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · AnswerEval AI`;
  }, [title]);
}
