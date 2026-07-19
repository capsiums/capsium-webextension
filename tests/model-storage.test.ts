import { describe, expect, it } from 'vitest';
import { parseStorage, ModelError } from '../src/lib/model';

describe('parseStorage', () => {
  it('parses the canonical form (§5)', () => {
    const storage = parseStorage({
      storage: {
        dataSets: {
          animals: {
            source: 'data/animals.json',
            schemaFile: 'data/animals.schema.json',
            schemaType: 'json-schema',
          },
          sales: { databaseFile: 'data/sales.db', table: 'sales' },
        },
      },
    });
    expect(Object.keys(storage.storage.dataSets)).toEqual(['animals', 'sales']);
    expect(storage.storage.dataSets['animals']?.source).toBe(
      'data/animals.json',
    );
  });

  it('normalizes the legacy gem form', () => {
    const storage = parseStorage({
      datasets: [
        {
          name: 'animals',
          source: 'data/animals.json',
          format: 'json',
          schema: 'data/animals.schema.json',
        },
        { name: 'sales', databaseFile: 'data/sales.db', table: 'sales' },
      ],
    });
    expect(storage.storage.dataSets['animals']).toEqual({
      source: 'data/animals.json',
      schemaFile: 'data/animals.schema.json',
    });
    expect(storage.storage.dataSets['sales']?.table).toBe('sales');
  });

  it('accepts the empty legacy form shipped by the fixtures', () => {
    expect(parseStorage({ datasets: [] }).storage.dataSets).toEqual({});
  });

  it('rejects datasets without source or databaseFile', () => {
    expect(() => parseStorage({ storage: { dataSets: { bad: {} } } })).toThrow(
      ModelError,
    );
  });
});
