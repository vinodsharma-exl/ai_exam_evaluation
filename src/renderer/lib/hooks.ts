import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppErrorData } from '../../shared/errors';
import type { AppEvents } from '../../shared/ipc';
import { api, errorData } from './api';

/** Loads data on mount and whenever deps change; reload() refetches. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<AppErrorData | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(errorData(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Runs an action with a busy flag and captured error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppErrorData | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      const d = errorData(e);
      if (d.code !== 'CANCELLED') setError(d);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function useAppEvent<E extends keyof AppEvents>(event: E, cb: (p: AppEvents[E]) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => api.on(event, (p) => ref.current(p)), [event]);
}

/** Seconds left until an epoch-ms time, updated every second. */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Global keyboard shortcuts. Keys are like "ctrl+s", "alt+arrowright", "]".
 * Single-character keys are ignored while typing in a field; ctrl/alt combinations always work.
 */
export function useShortcuts(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const parts = [e.ctrlKey || e.metaKey ? 'ctrl' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : '', e.key.toLowerCase()].filter(Boolean);
      const combo = parts.join('+');
      const handler = ref.current[combo];
      if (!handler) return;
      const el = e.target as HTMLElement;
      const typing = el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      if (typing && !(e.ctrlKey || e.metaKey || e.altKey)) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
