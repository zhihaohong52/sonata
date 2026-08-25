import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCatalogUpdate } from '../../src/commands/catalog.js';
import { aaCatalogPath } from '../../src/catalog.js';
import { cmdAuthAdd } from '../../src/commands/auth.js';

// The AA response fixture is synthetic, with invented values; it is not a redistribution of AA data.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-catalog-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fixture = () => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/aa/models.json'), 'utf8'));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('cmdCatalogUpdate', () => {
  it('fetches and caches normalized model scores', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    const result = await cmdCatalogUpdate(home, {
      fetch: async (input, init) => {
        expect(input).toBe('https://artificialanalysis.ai/api/v2/data/llms/models');
        expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-key');
        return response(fixture());
      },
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });

    expect(result).toEqual({ models: 3, path: aaCatalogPath(home), fetchedAt: '2026-08-25T12:00:00.000Z' });
    expect(JSON.parse(readFileSync(aaCatalogPath(home), 'utf8'))).toEqual({
      fetchedAt: '2026-08-25T12:00:00.000Z',
      models: {
        'gpt-5.6-luna': { codingIndex: 72.5, blendedPriceUsd: 0.42 },
        'deepseek-v4-flash': { codingIndex: 48, blendedPriceUsd: 0.18 },
        'example-model': { codingIndex: 31, blendedPriceUsd: 2.75 },
      },
    });
  });

  it('reports a missing key without making a request', async () => {
    await expect(cmdCatalogUpdate(home)).rejects.toThrow(
      'sonata catalog update: no key stored — run `sonata auth add artificialanalysis` (free key at https://artificialanalysis.ai)',
    );
  });

  it('names a rejected key on 403', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await expect(cmdCatalogUpdate(home, { fetch: async () => response({ error: 'nope' }, 403) }))
      .rejects.toThrow(/key rejected.*403/i);
  });

  it('rejects a malformed response body', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await expect(cmdCatalogUpdate(home, { fetch: async () => response({ models: [] }) }))
      .rejects.toThrow(/malformed/i);
  });

  it('rejects an empty data array rather than overwriting the existing cache', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await cmdCatalogUpdate(home, {
      fetch: async () => response(fixture()),
      now: () => new Date('2026-08-25T12:00:00.000Z'),
    });
    const before = readFileSync(aaCatalogPath(home), 'utf8');

    await expect(cmdCatalogUpdate(home, { fetch: async () => response({ data: [] }) }))
      .rejects.toThrow(/no usable model/i);
    expect(readFileSync(aaCatalogPath(home), 'utf8')).toBe(before);
  });

  it('rejects a data array whose entries all lack a scoring field', async () => {
    cmdAuthAdd({ home, gateway: 'artificialanalysis', key: 'synthetic-key' });
    await expect(cmdCatalogUpdate(home, {
      fetch: async () => response({ data: [{ slug: 'no-score/model' }] }),
    })).rejects.toThrow(/no usable model/i);
  });
});
