/**
 * Schema migrations, keyed by file kind and SOURCE version: migrations.exam[1] turns a v1 exam into v2.
 * When you bump SCHEMA_VERSIONS.x, add the step here and a test with a real v(n-1) fixture.
 * Migrations receive plain JSON (unvalidated) and must set schemaVersion on the result.
 */
import type { FileKind } from '../../shared/schemas/index';
import { SCHEMA_VERSIONS } from '../../shared/constants';
import { AppError } from '../../shared/errors';

type Doc = Record<string, unknown>;
type Migration = (doc: Doc) => Doc;

export const MIGRATIONS: Partial<Record<FileKind, Record<number, Migration>>> = {
  // Example for the future:
  // exam: { 1: (d) => ({ ...d, schemaVersion: 2, newField: [] }) },
};

/** Brings `doc` up to the current version. Throws NEWER_FILE_VERSION for files from a newer app. */
export function migrate(kind: FileKind, doc: unknown): { doc: unknown; migrated: boolean } {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc, migrated: false };
  const target = SCHEMA_VERSIONS[kind];
  let current = doc as Doc;
  let v = typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;
  if (v > target) throw new AppError('NEWER_FILE_VERSION', `${kind} v${v} > supported v${target}`);
  let migrated = false;
  while (v < target) {
    const step = MIGRATIONS[kind]?.[v];
    if (!step) throw new Error(`No migration for ${kind} v${v} → v${v + 1}`);
    current = step(current);
    v = current.schemaVersion as number;
    migrated = true;
  }
  return { doc: current, migrated };
}
