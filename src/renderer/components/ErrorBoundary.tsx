/** Keeps one broken screen from blanking the whole app. Shows the error and a way back. */
import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: unknown; onHome: () => void }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900 dark:bg-red-950/40">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-6 w-6 text-red-600" />
          <div className="min-w-0">
            <p className="font-semibold">This screen hit a problem</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Your data is safe: it's saved on disk after every step. Go back and try again; if it keeps happening, the details below help with a fix.</p>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 font-mono text-xs dark:bg-black/30">{this.state.error.message}</pre>
            <button type="button" className="mt-3 rounded-lg bg-brand-600 px-4 py-2 text-sm text-white" onClick={() => { this.setState({ error: null }); this.props.onHome(); }}>
              Go to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
