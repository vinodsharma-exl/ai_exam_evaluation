import { z } from 'zod';
import { SCHEMA_VERSIONS } from '../constants';
import { IsoDate, IsoDateTime, Marks, SafeId } from './common';
import { StudentFile } from './student';

/**
 * index/students.json: a derived search index. It is safe to delete, and is rebuilt by scanning
 * exams/{examId}/students/{studentId}/{student,final,evaluation}.json when missing or invalid.
 */
export const StudentIndexEntry = z.object({
  /** Search key: lower-cased displayId with separators removed ("21cs045"), so "21-CS-045" and "21/cs/045" match. */
  searchKey: z.string(),
  displayId: z.string(),
  name: z.string(),
  rollNo: z.string(),
  exams: z.array(
    z.object({
      examId: SafeId,
      studentId: SafeId,
      examTitle: z.string(),
      examDate: IsoDate.nullable(),
      status: StudentFile.shape.status,
      /** Final total if finalized, otherwise the recommended total, otherwise null. */
      total: Marks.nullable(),
      maxTotal: Marks,
      isFinal: z.boolean(),
      needsReviewCount: z.number().int().min(0),
      updatedAt: IsoDateTime,
    }),
  ),
});
export type StudentIndexEntry = z.infer<typeof StudentIndexEntry>;

export const StudentIndexFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.studentIndex),
  builtAt: IsoDateTime,
  /** Grouped by searchKey, so one student's exams across the year appear together. */
  students: z.array(StudentIndexEntry),
});
export type StudentIndexFile = z.infer<typeof StudentIndexFile>;

export function toSearchKey(displayId: string): string {
  return displayId.toLowerCase().replace(/[^a-z0-9]/g, '');
}
