/**
 * Small file logger: <userData>/logs/main.log, rotated at 1 MB (keeps main.1.log, main.2.log).
 * Every line goes through redactSecrets(). Never pass request bodies or headers to it.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../shared/errors';

const MAX_BYTES = 1024 * 1024;
const KEEP = 2;

export class Logger {
  private readonly file: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'main.log');
  }

  private rotate(): void {
    try {
      if (statSync(this.file).size < MAX_BYTES) return;
    } catch {
      return;
    }
    rmSync(join(this.dir, `main.${KEEP}.log`), { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        renameSync(join(this.dir, `main.${i}.log`), join(this.dir, `main.${i + 1}.log`));
      } catch {
        /* missing is fine */
      }
    }
    try {
      renameSync(this.file, join(this.dir, 'main.1.log'));
    } catch {
      /* ignore */
    }
  }

  write(level: 'info' | 'warn' | 'error', msg: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactSecrets(msg)}\n`;
    try {
      this.rotate();
      appendFileSync(this.file, line, 'utf8');
    } catch {
      /* logging must never crash the app */
    }
    if (process.env.NODE_ENV === 'development') console.log(line.trimEnd());
  }

  info = (m: string) => this.write('info', m);
  warn = (m: string) => this.write('warn', m);
  error = (m: string) => this.write('error', m);
}
