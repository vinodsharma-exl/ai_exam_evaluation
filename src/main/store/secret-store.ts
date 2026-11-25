/**
 * API keys, encrypted with Electron safeStorage (Windows DPAPI, tied to the Windows user account).
 *
 * - secrets.bin = encrypt(JSON SecretsPayload). Written atomically.
 * - Keys are decrypted lazily, kept in main-process memory only, and never sent to the renderer.
 * - If the file can't be decrypted (e.g. a backup restored on another PC or Windows account), it is
 *   renamed aside and the app asks for the keys again. The keys cannot be recovered on that machine.
 * - Never log a key. Use describeKey() for diagnostics.
 */
import { promises as fs } from 'node:fs';
import { SecretsPayload } from '../../shared/schemas/config';
import type { ProviderId } from '../../shared/schemas/common';
import { ROOT_FILES } from '../../shared/paths';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { AppError } from '../../shared/errors';
import type { FileStore } from './file-store';
import { KeyedMutex } from './mutex';

/** The subset of Electron's safeStorage we use. Injected so tests can run without Electron. */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SecretStore {
  private cache: SecretsPayload | null = null;
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly store: FileStore,
    private readonly enc: Encryptor,
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  private async load(): Promise<SecretsPayload> {
    if (this.cache) return this.cache;
    const empty: SecretsPayload = { schemaVersion: SCHEMA_VERSIONS.secrets, apiKeys: {} };
    let buf: Buffer;
    try {
      buf = await this.store.readBytes(ROOT_FILES.secrets);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return (this.cache = empty);
      throw err;
    }
    if (!this.enc.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    try {
      const parsed = SecretsPayload.parse(JSON.parse(this.enc.decryptString(buf)));
      return (this.cache = parsed);
    } catch {
      // Unreadable on this machine or account. Keep the file aside and start empty.
      await fs
        .rename(this.store.abs(ROOT_FILES.secrets), this.store.abs(`${ROOT_FILES.secrets}.unreadable-${Date.now()}`))
        .catch(() => undefined);
      return (this.cache = empty);
    }
  }

  private async save(payload: SecretsPayload): Promise<void> {
    if (!this.enc.isEncryptionAvailable()) throw new AppError('ENCRYPTION_UNAVAILABLE');
    const encrypted = this.enc.encryptString(JSON.stringify(SecretsPayload.parse(payload)));
    await this.store.writeBytes(ROOT_FILES.secrets, encrypted);
    this.cache = payload;
  }

  async getKey(providerId: ProviderId): Promise<string | null> {
    const p = await this.load();
    return p.apiKeys[providerId] ?? null;
  }

  async hasKey(providerId: ProviderId): Promise<boolean> {
    return (await this.getKey(providerId)) !== null;
  }

  async listProvidersWithKeys(): Promise<ProviderId[]> {
    const p = await this.load();
    return Object.keys(p.apiKeys) as ProviderId[];
  }

  async setKey(providerId: ProviderId, key: string): Promise<void> {
    const clean = key.trim();
    if (!clean || clean.length > 500 || /\s/.test(clean)) {
      throw new AppError('VALIDATION', 'The key looks wrong: it is empty, too long, or contains spaces.');
    }
    await this.mutex.run('secrets', async () => {
      const p = await this.load();
      await this.save({ ...p, apiKeys: { ...p.apiKeys, [providerId]: clean } });
    });
  }

  async deleteKey(providerId: ProviderId): Promise<void> {
    await this.mutex.run('secrets', async () => {
      const p = await this.load();
      const apiKeys = { ...p.apiKeys };
      delete apiKeys[providerId];
      await this.save({ ...p, apiKeys });
    });
  }
}

/** Safe description for logs: "gsk_…(56 chars)". */
export function describeKey(key: string | null): string {
  if (!key) return '(none)';
  return `${key.slice(0, 4)}…(${key.length} chars)`;
}
