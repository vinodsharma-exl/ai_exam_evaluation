import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDateTime, SafeId } from './common';

/** exams/<examId>/students/<studentId>/student.json */
export const StudentFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.student),
  /** Folder-safe id (folder name). */
  id: SafeId,
  /** ID exactly as the professor typed it, e.g. "21/CS/045". Used for display and search. */
  displayId: z.string().min(1).max(64),
  name: z.string().max(120).default(''),
  rollNo: z.string().max(40).default(''),
  section: z.string().max(40).default(''),
  /** Files as uploaded, in the order the professor arranged them. */
  uploads: z
    .array(
      z.object({
        originalName: z.string(),
        kind: z.enum(['pdf', 'jpg', 'png']),
        sha256: z.string(),
        pageCount: z.number().int().min(1),
      }),
    )
    .default([]),
  /**
   * Overall status shown in tables and the search index:
   * draft (uploaded only), processing, needs_review (one or more questions flagged),
   * evaluated (all recommended, nothing flagged), finalized (professor saved final marks).
   */
  status: z.enum(['draft', 'processing', 'paused', 'needs_review', 'evaluated', 'finalized', 'failed']),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type StudentFile = z.infer<typeof StudentFile>;
export type StudentStatus = StudentFile['status'];
