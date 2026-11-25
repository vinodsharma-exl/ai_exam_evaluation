/**
 * Local profile and optional PIN. The PIN is hashed with scrypt and a random salt.
 * Five wrong attempts lock the PIN for 30 seconds (in memory; a restart clears it, which is fine for a
 * convenience lock).
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { ProfileFile } from '../../shared/schemas/profile';
import type { ProfilePublic } from '../../shared/ipc';
import { ROOT_FILES } from '../../shared/paths';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { AppError } from '../../shared/errors';
import type { FileStore } from './file-store';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MAX_ATTEMPTS = 5;
const LOCK_MS = 30_000;

async function hashPin(pin: string, saltHex?: string) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16);
  const hash = await scrypt(pin, salt, 32, SCRYPT_OPTS);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

function validatePin(pin: string): void {
  if (!/^[0-9]{4,8}$/.test(pin)) throw new AppError('VALIDATION', 'PIN must be 4 to 8 digits.');
}

export class ProfileService {
  private failed = 0;
  private lockedUntil = 0;
  private loggedIn = false;

  constructor(
    private readonly store: FileStore,
    private readonly now: () => number = Date.now,
  ) {}

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  async get(): Promise<ProfileFile | null> {
    return this.store.read('profile', ROOT_FILES.profile);
  }

  /** What the renderer may see: no hash, no salt. */
  static publicView(p: ProfileFile): ProfilePublic {
    const { pin, ...rest } = p;
    return { ...rest, hasPin: pin !== null };
  }

  async create(input: { name: string; title?: string; department?: string; pin?: string }): Promise<ProfileFile> {
    if (await this.get()) throw new AppError('ALREADY_EXISTS', 'A profile already exists on this computer.');
    const name = input.name.trim();
    if (!name) throw new AppError('VALIDATION', 'Enter your name.');
    let pin: ProfileFile['pin'] = null;
    if (input.pin) {
      validatePin(input.pin);
      pin = await hashPin(input.pin);
    }
    const now = new Date(this.now()).toISOString();
    const profile: ProfileFile = {
      schemaVersion: SCHEMA_VERSIONS.profile,
      name,
      title: input.title?.trim() ?? '',
      department: input.department?.trim() ?? '',
      pin,
      createdAt: now,
      lastLoginAt: now,
    };
    const saved = await this.store.write('profile', ROOT_FILES.profile, profile);
    this.loggedIn = true;
    return saved;
  }

  async login(pin?: string): Promise<ProfileFile> {
    const profile = await this.get();
    if (!profile) throw new AppError('NOT_FOUND', 'No profile yet.');
    if (profile.pin) {
      if (this.now() < this.lockedUntil) throw new AppError('PIN_LOCKED');
      const { hash } = await hashPin(pin ?? '', profile.pin.salt);
      const ok = timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(profile.pin.hash, 'hex'));
      if (!ok) {
        this.failed++;
        if (this.failed >= MAX_ATTEMPTS) {
          this.failed = 0;
          this.lockedUntil = this.now() + LOCK_MS;
          throw new AppError('PIN_LOCKED');
        }
        throw new AppError('PIN_INCORRECT');
      }
    }
    this.failed = 0;
    this.loggedIn = true;
    const updated = await this.store.update('profile', ROOT_FILES.profile, (cur) =>
      cur ? { ...cur, lastLoginAt: new Date(this.now()).toISOString() } : undefined,
    );
    return updated ?? profile;
  }

  async update(patch: { name?: string; title?: string; department?: string }): Promise<ProfileFile> {
    const updated = await this.store.update('profile', ROOT_FILES.profile, (cur) => {
      if (!cur) throw new AppError('NOT_FOUND', 'No profile yet.');
      return {
        ...cur,
        name: patch.name?.trim() || cur.name,
        title: patch.title?.trim() ?? cur.title,
        department: patch.department?.trim() ?? cur.department,
      };
    });
    return updated!;
  }

  /** Sets, changes or removes (newPin empty) the PIN. The current PIN is required if one is set. */
  async changePin(currentPin: string | undefined, newPin: string | undefined): Promise<void> {
    const profile = await this.get();
    if (!profile) throw new AppError('NOT_FOUND');
    if (profile.pin) await this.login(currentPin); // reuses the lockout logic
    let pin: ProfileFile['pin'] = null;
    if (newPin) {
      validatePin(newPin);
      pin = await hashPin(newPin);
    }
    await this.store.update('profile', ROOT_FILES.profile, (cur) => (cur ? { ...cur, pin } : undefined));
  }
}
