/**
 * Writes JSON Schema (draft 2020-12) files for every on-disk file and AI output into /schemas.
 * zod is the source of truth. Run `npm run schemas` after changing any schema.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FILE_SCHEMAS, AI_OUTPUT_SCHEMAS } from '../src/shared/schemas/index';

const outDir = join(process.cwd(), 'schemas');
mkdirSync(outDir, { recursive: true });

const entries: Array<[string, z.ZodType]> = [
  ...Object.entries(FILE_SCHEMAS).map(([k, s]) => [`file.${k}`, s] as [string, z.ZodType]),
  ...Object.entries(AI_OUTPUT_SCHEMAS).map(([k, s]) => [`ai.${k}`, s] as [string, z.ZodType]),
];

for (const [name, schema] of entries) {
  // io:'input' describes what may be ON DISK or IN THE RESPONSE (defaults make fields optional).
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' });
  const withMeta = { $id: `answereval-ai/${name}.schema.json`, title: name, ...json };
  writeFileSync(join(outDir, `${name}.schema.json`), JSON.stringify(withMeta, null, 2) + '\n', 'utf8');
  console.log(`wrote schemas/${name}.schema.json`);
}
