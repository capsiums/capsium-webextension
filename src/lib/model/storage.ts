import { z } from 'zod';
import { ModelError } from './index';

/**
 * storage.json — ARCHITECTURE.md §5 (optional, only when datasets exist).
 *
 * Canonical form: {storage: {dataSets: {<id>: {...}, ...}}}.
 * Legacy gem form {"datasets": [{name, source, format, schema}]} is accepted
 * on read and normalized. `layers` (overlay FS) is parsed if present but has
 * no behavior yet — layered storage is explicitly deferred.
 */

export const dataSetSchema = z
  .looseObject({
    /** Schema-backed file dataset: JSON/YAML/CSV/TSV path. */
    source: z.string().optional(),
    schemaFile: z.string().optional(),
    schemaType: z.string().optional(),
    /** SQLite dataset. */
    databaseFile: z.string().optional(),
    table: z.string().optional(),
  })
  .refine(
    (dataSet) =>
      dataSet.source !== undefined || dataSet.databaseFile !== undefined,
    {
      message: 'dataset needs either "source" or "databaseFile"',
    },
  );

export const storageSchema = z.object({
  storage: z.looseObject({
    dataSets: z.record(z.string(), dataSetSchema).default({}),
    /** Parsed, no behavior yet (deferred). */
    layers: z.unknown().optional(),
  }),
});

export type DataSet = z.infer<typeof dataSetSchema>;
export type StorageFile = z.infer<typeof storageSchema>;

const legacyDataSetSchema = z.looseObject({
  name: z.string().min(1),
  source: z.string().optional(),
  format: z.string().optional(),
  schema: z.string().optional(),
  databaseFile: z.string().optional(),
  table: z.string().optional(),
});

const legacyStorageSchema = z.object({
  datasets: z.array(legacyDataSetSchema),
});

export function parseStorage(input: unknown): StorageFile {
  const canonical = storageSchema.safeParse(input);
  if (canonical.success) return canonical.data;

  const legacy = legacyStorageSchema.safeParse(input);
  if (legacy.success) {
    const dataSets: Record<string, DataSet> = {};
    for (const dataSet of legacy.data.datasets) {
      const entry: Record<string, string> = {};
      if (dataSet.source !== undefined) entry['source'] = dataSet.source;
      if (dataSet.schema !== undefined) entry['schemaFile'] = dataSet.schema;
      if (dataSet.databaseFile !== undefined)
        entry['databaseFile'] = dataSet.databaseFile;
      if (dataSet.table !== undefined) entry['table'] = dataSet.table;
      if (entry['source'] === undefined && entry['databaseFile'] === undefined)
        continue;
      dataSets[dataSet.name] = entry as DataSet;
    }
    return { storage: { dataSets } };
  }

  throw new ModelError(
    'storage.json',
    canonical.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ),
  );
}
