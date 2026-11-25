export * from './common';
export * from './config';
export * from './profile';
export * from './exam';
export * from './student';
export * from './extraction';
export * from './evaluation';
export * from './final';
export * from './jobs';
export * from './usage';
export * from './cache';
export * from './index-file';
export * from './ai-output';

import { ConfigFile, SecretsPayload } from './config';
import { ProfileFile } from './profile';
import { ExamFile, SourceExtractionFile } from './exam';
import { StudentFile } from './student';
import { ExtractionFile } from './extraction';
import { EvaluationFile } from './evaluation';
import { FinalFile } from './final';
import { JobsFile, GlobalQueueFile } from './jobs';
import { UsageFile } from './usage';
import { CacheEntry } from './cache';
import { StudentIndexFile } from './index-file';

/** Every on-disk JSON file, keyed by the name used in SCHEMA_VERSIONS and the generated /schemas folder. */
export const FILE_SCHEMAS = {
  config: ConfigFile,
  secrets: SecretsPayload,
  profile: ProfileFile,
  usage: UsageFile,
  globalQueue: GlobalQueueFile,
  cacheEntry: CacheEntry,
  studentIndex: StudentIndexFile,
  exam: ExamFile,
  sourceExtraction: SourceExtractionFile,
  student: StudentFile,
  extraction: ExtractionFile,
  evaluation: EvaluationFile,
  final: FinalFile,
  jobs: JobsFile,
} as const;
export type FileKind = keyof typeof FILE_SCHEMAS;
