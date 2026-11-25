import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '../src/main/store/file-store';
import { SecretStore, describeKey } from '../src/main/store/secret-store';
import { ProfileService } from '../src/main/store/profile-service';
import { tempDir, fakeEncryptor } from './helpers';

let t: ReturnType<typeof tempDir>;
let store: FileStore;
beforeEach(() => {
  t = tempDir();
  store = new FileStore(t.dir);
});
afterEach(() => t.cleanup());

describe('SecretStore', () => {
  it('stores keys encrypted, never in plain text', async () => {
    const s = new SecretStore(store, fakeEncryptor());
    await s.setKey('gemini', '  AIzaSyTESTKEY1234567890abcdef  ');
    expect(await s.getKey('gemini')).toBe('AIzaSyTESTKEY1234567890abcdef');
    const raw = await fs.readFile(join(t.dir, 'secrets.bin'));
    expect(raw.toString('utf8')).not.toContain('AIzaSy');
    // A fresh instance decrypts from disk.
    const s2 = new SecretStore(store, fakeEncryptor());
    expect(await s2.hasKey('gemini')).toBe(true);
    await s2.deleteKey('gemini');
    expect(await s2.getKey('gemini')).toBeNull();
  });

  it('rejects keys with spaces inside', async () => {
    const s = new SecretStore(store, fakeEncryptor());
    await expect(s.setKey('groq', 'gsk_abc def')).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses to save when encryption is unavailable (no plaintext fallback)', async () => {
    const s = new SecretStore(store, fakeEncryptor(false));
    await expect(s.setKey('groq', 'gsk_abc')).rejects.toMatchObject({ code: 'ENCRYPTION_UNAVAILABLE' });
    expect(readdirSync(t.dir)).not.toContain('secrets.bin');
  });

  it('sets aside a secrets file that cannot be decrypted (other PC) and starts empty', async () => {
    const enc = fakeEncryptor();
    await new SecretStore(store, enc).setKey('groq', 'gsk_abc');
    enc.broken = true;
    const s = new SecretStore(store, enc);
    expect(await s.getKey('groq')).toBeNull();
    expect(readdirSync(t.dir).some((f) => f.startsWith('secrets.bin.unreadable-'))).toBe(true);
  });

  it('describeKey never reveals the key', () => {
    expect(describeKey('gsk_abcdefghijklmnop')).toBe('gsk_…(20 chars)');
  });
});

describe('ProfileService', () => {
  it('creates a profile without PIN and logs in', async () => {
    const p = new ProfileService(store);
    await p.create({ name: 'Dr. Rao' });
    const fresh = new ProfileService(store);
    expect(fresh.isLoggedIn).toBe(false);
    await fresh.login();
    expect(fresh.isLoggedIn).toBe(true);
  });

  it('hashes the PIN, rejects wrong PINs and locks after 5 attempts', async () => {
    let now = 1_000_000;
    const p = new ProfileService(store, () => now);
    await p.create({ name: 'Prof', pin: '4821' });
    const raw = await fs.readFile(join(t.dir, 'profile.json'), 'utf8');
    expect(raw).not.toContain('4821');
    expect(ProfileService.publicView((await p.get())!)).not.toHaveProperty('pin');

    const fresh = new ProfileService(store, () => now);
    for (let i = 0; i < 4; i++) await expect(fresh.login('0000')).rejects.toMatchObject({ code: 'PIN_INCORRECT' });
    await expect(fresh.login('0000')).rejects.toMatchObject({ code: 'PIN_LOCKED' });
    await expect(fresh.login('4821')).rejects.toMatchObject({ code: 'PIN_LOCKED' });
    now += 31_000;
    await expect(fresh.login('4821')).resolves.toMatchObject({ name: 'Prof' });
  });

  it('validates PIN format and changes PIN', async () => {
    const p = new ProfileService(store);
    await expect(p.create({ name: 'X', pin: '12' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await p.create({ name: 'X', pin: '1234' });
    await p.changePin('1234', '987654');
    await expect(new ProfileService(store).login('987654')).resolves.toBeTruthy();
    await p.changePin('987654', undefined);
    expect((await p.get())!.pin).toBeNull();
  });
});
