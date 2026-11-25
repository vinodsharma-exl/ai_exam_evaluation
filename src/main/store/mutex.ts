/**
 * Per-key async mutex. All read-modify-write cycles on one file go through the same key, so two
 * IPC calls (e.g. a job progress write and a professor's edit) cannot interleave and lose an update.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      // Delete only if nobody queued behind us.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
