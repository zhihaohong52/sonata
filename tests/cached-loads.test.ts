import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadModelsDevCached } from '../src/tui-ink/cached-loads.js';
import { modelsDevPath } from '../src/modelsdev.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-cached-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('loadModelsDevCached', () => {
  it('returns one object while the file is unchanged and fresh data once it is rewritten', () => {
    const path = modelsDevPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fetchedAt: '2026-01-01T00:00:00Z', providers: { p: { m: { input: 1, output: 2 } } } }));
    const a = loadModelsDevCached(home);
    expect(a?.fetchedAt).toBe('2026-01-01T00:00:00Z');
    expect(loadModelsDevCached(home)).toBe(a);
    writeFileSync(path, JSON.stringify({ fetchedAt: '2026-02-02T00:00:00Z', providers: { p: { m: { input: 1, output: 2 } } } }));
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const b = loadModelsDevCached(home);
    expect(b).not.toBe(a);
    expect(b?.fetchedAt).toBe('2026-02-02T00:00:00Z');
  });
  it('is undefined when there is no file', () => {
    expect(loadModelsDevCached(home)).toBeUndefined();
  });
});
