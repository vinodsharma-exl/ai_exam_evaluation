import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Encryptor } from '../src/main/store/secret-store';

export function tempDir(prefix = 'aeai-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Reversible stand-in for safeStorage: XOR plus a magic header. Good enough to show the file isn't plaintext. */
export function fakeEncryptor(available = true): Encryptor & { broken: boolean } {
  const enc = {
    broken: false,
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.concat([Buffer.from('ENC1'), Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)]),
    decryptString: (b: Buffer) => {
      if (enc.broken || b.subarray(0, 4).toString() !== 'ENC1') throw new Error('Error while decrypting the ciphertext');
      return Buffer.from(b.subarray(4).map((x) => x ^ 0x5a)).toString('utf8');
    },
  };
  return enc;
}

export const iso = '2026-11-25T10:00:00.000Z';
