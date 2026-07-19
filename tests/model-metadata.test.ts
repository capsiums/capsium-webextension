import { describe, expect, it } from 'vitest';
import { parseMetadata, ModelError } from '../src/lib/model';

describe('parseMetadata', () => {
  it('parses the canonical form (ARCHITECTURE.md §2)', () => {
    const metadata = parseMetadata({
      name: 'story-of-claire',
      version: '1.0.0',
      description: 'A story',
      guid: 'https://github.com/capsiums/cap-story',
      uuid: '123e4567-e89b-12d3-a456-426614174000',
      author: 'Ribose',
      license: 'MIT',
      repository: { type: 'git', url: 'https://example.com/repo' },
      dependencies: { 'capsium://example.com/other-pkg': '>=1.0.0' },
      readOnly: true,
    });
    expect(metadata.name).toBe('story-of-claire');
    expect(metadata.dependencies).toEqual({
      'capsium://example.com/other-pkg': '>=1.0.0',
    });
  });

  it('normalizes legacy array dependencies to the object form', () => {
    const metadata = parseMetadata({
      name: 'bare_package',
      version: '0.1.0',
      dependencies: [
        { name: 'capsium://example.com/dep', version: '1.2.3' },
        { name: 'other' },
      ],
    });
    expect(metadata.dependencies).toEqual({
      'capsium://example.com/dep': '1.2.3',
      other: '*',
    });
  });

  it('defaults missing dependencies to an empty object', () => {
    expect(parseMetadata({ name: 'x', version: '1.0.0' }).dependencies).toEqual(
      {},
    );
  });

  it('rejects when name or version is missing', () => {
    expect(() => parseMetadata({ version: '1.0.0' })).toThrow(ModelError);
    expect(() => parseMetadata({ name: 'x' })).toThrow(/metadata\.json/);
  });
});
