import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDateTime } from './common';

/**
 * Local profile. This is NOT an account and nothing is synced.
 * The PIN is a convenience lock against casual access, not strong security.
 * The real protection for student data is the Windows user account.
 */
export const ProfileFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.profile),
  name: z.string().min(1).max(120),
  title: z.string().max(60).default(''), // e.g. "Dr.", "Prof."
  department: z.string().max(200).default(''),
  pin: z
    .object({
      /** scrypt(N=16384, r=8, p=1, keylen=32), hex. */
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      salt: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .nullable()
    .default(null),
  createdAt: IsoDateTime,
  lastLoginAt: IsoDateTime.nullable().default(null),
});
export type ProfileFile = z.infer<typeof ProfileFile>;
