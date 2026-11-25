/**
 * App-wide state: signed-in profile, config (kept fresh through 'config:changed'), theme, and toasts.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ConfigFile } from '../../shared/schemas/config';
import type { ProfilePublic } from '../../shared/ipc';
import { api, call } from './api';
import { useAppEvent } from './hooks';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

interface AppValue {
  profile: ProfilePublic | null;
  setProfile(p: ProfilePublic | null): void;
  config: ConfigFile | null;
  refreshConfig(): Promise<void>;
  updateConfig(patch: unknown): Promise<ConfigFile>;
  toasts: Toast[];
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;
}

const Ctx = createContext<AppValue | null>(null);
let toastId = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<ProfilePublic | null>(null);
  const [config, setConfig] = useState<ConfigFile | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refreshConfig = useCallback(async () => {
    setConfig(await call(api.getConfig()));
  }, []);

  const updateConfig = useCallback(async (patch: unknown) => {
    const c = await call(api.updateConfig(patch as Partial<ConfigFile>));
    setConfig(c);
    return c;
  }, []);

  useAppEvent('config:changed', (c) => setConfig(c));

  useEffect(() => {
    if (profile) void refreshConfig().catch(() => undefined);
  }, [profile, refreshConfig]);

  // Theme: explicit light/dark, or follow Windows.
  useEffect(() => {
    const theme = config?.ui.theme ?? 'system';
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [config?.ui.theme]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, kind: Toast['kind'] = 'success') => {
      const id = ++toastId;
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4000);
    },
    [dismissToast],
  );

  const value = useMemo(
    () => ({ profile, setProfile, config, refreshConfig, updateConfig, toasts, toast, dismissToast }),
    [profile, config, refreshConfig, updateConfig, toasts, toast, dismissToast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}
