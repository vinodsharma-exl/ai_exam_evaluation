/**
 * A tiny in-memory router (no URLs: it's a desktop app). Keeps a back stack for "Back" buttons.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'evaluate'; examId?: string; studentId?: string; step?: 1 | 2 }
  | { name: 'exams' }
  | { name: 'exam-setup'; examId: string; returnTo?: Route }
  | { name: 'processing'; examId: string; studentId: string }
  | { name: 'results'; examId: string; studentId: string }
  | { name: 'students'; query?: string }
  | { name: 'reports'; examId?: string }
  | { name: 'settings'; tab?: SettingsTab }
  // Phase 5 screens
  | { name: 'question'; examId: string; studentId: string; questionNumber: string }
  | { name: 'finalize'; examId: string; studentId: string }
  | { name: 'report'; examId: string; studentId: string };

export type SettingsTab = 'models' | 'providers' | 'grading' | 'images' | 'data' | 'appearance' | 'profile' | 'privacy';

interface RouterValue {
  route: Route;
  go(r: Route): void;
  back(): void;
  canGoBack: boolean;
}

const Ctx = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'dashboard' }]);
  const go = useCallback((r: Route) => setStack((s) => [...s.slice(-30), r]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const value = useMemo(() => ({ route: stack[stack.length - 1]!, go, back, canGoBack: stack.length > 1 }), [stack, go, back]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRouter outside RouterProvider');
  return v;
}
