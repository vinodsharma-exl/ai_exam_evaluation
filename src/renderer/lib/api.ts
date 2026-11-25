/**
 * Typed access to the main process. call() unwraps Result<T>: it returns the data or throws an
 * ApiError that carries the AppErrorData (code, detail) for ErrorBanner.
 */
import type { AppApi, Result } from '../../shared/ipc';
import type { AppErrorData } from '../../shared/errors';

export const api: AppApi = (window as unknown as { api: AppApi }).api;

export class ApiError extends Error {
  constructor(public readonly data: AppErrorData) {
    super(data.detail ? `${data.code}: ${data.detail}` : data.code);
    this.name = 'ApiError';
  }
}

export async function call<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.data;
  throw new ApiError(r.error);
}

export function errorData(err: unknown): AppErrorData {
  if (err instanceof ApiError) return err.data;
  return { code: 'UNKNOWN', detail: String((err as Error)?.message ?? err), at: new Date().toISOString() };
}

export const isCancelled = (err: unknown) => err instanceof ApiError && err.data.code === 'CANCELLED';
