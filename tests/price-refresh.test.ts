import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { modelsDevPath } from '../src/modelsdev.js';
import {
  PRICE_CHECK_INTERVAL_MS,
  PRICE_MAX_AGE_MS,
  priceCacheIsStale,
  refreshPricesIfStale,
  startPriceRefresh,
} from '../src/price-refresh.js';

let home: string;
const NOW = Date.parse('2026-09-10T12:00:00.000Z');

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'sonata-price-refresh-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function writeCache(fetchedAt: string): void {
  const path = modelsDevPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    fetchedAt,
    providers: { openai: { 'gpt-5.6-terra': { input: 2, output: 12 } } },
  }));
}

describe('priceCacheIsStale', () => {
  it('treats an absent cache as stale', () => {
    expect(priceCacheIsStale(home, NOW)).toBe(true);
  });

  it('treats a cache younger than the max age as fresh', () => {
    writeCache(new Date(NOW - PRICE_MAX_AGE_MS + 60_000).toISOString());
    expect(priceCacheIsStale(home, NOW)).toBe(false);
  });

  it('treats a cache at exactly the max age as stale', () => {
    writeCache(new Date(NOW - PRICE_MAX_AGE_MS).toISOString());
    expect(priceCacheIsStale(home, NOW)).toBe(true);
  });

  // An unreadable timestamp is not evidence of freshness. Reading it as fresh
  // would pin a broken cache in place permanently.
  it('treats an unparseable fetchedAt as stale', () => {
    writeCache('not a date');
    expect(priceCacheIsStale(home, NOW)).toBe(true);
  });
});

describe('refreshPricesIfStale', () => {
  it('does not fetch when the cache is fresh', async () => {
    writeCache(new Date(NOW - 60_000).toISOString());
    let calls = 0;
    const result = await refreshPricesIfStale(home, {
      update: async () => { calls += 1; },
      now: () => NOW,
    });
    expect(result).toBe('fresh');
    expect(calls).toBe(0);
  });

  it('fetches when the cache is stale', async () => {
    writeCache(new Date(NOW - PRICE_MAX_AGE_MS - 1).toISOString());
    let calls = 0;
    const result = await refreshPricesIfStale(home, {
      update: async () => { calls += 1; },
      now: () => NOW,
    });
    expect(result).toBe('updated');
    expect(calls).toBe(1);
  });

  // The property that keeps a healthy router healthy: this runs detached on a
  // timer, so a rejection escaping here would be an unhandled rejection in a
  // process that is otherwise serving requests perfectly well.
  it('never throws when the fetch fails, and says what it kept', async () => {
    writeCache(new Date(NOW - PRICE_MAX_AGE_MS - 1).toISOString());
    const lines: string[] = [];
    const result = await refreshPricesIfStale(home, {
      update: async () => { throw new Error('getaddrinfo ENOTFOUND models.dev'); },
      now: () => NOW,
      log: (line) => lines.push(line),
    });
    expect(result).toBe('failed');
    expect(lines.join('\n')).toContain('keeping the existing cache');
  });
});

describe('startPriceRefresh', () => {
  it('checks immediately rather than waiting a full interval', async () => {
    let calls = 0;
    const stop = startPriceRefresh(home, {
      update: async () => { calls += 1; },
      now: () => NOW,
      setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    // A daemon restarted after a long gap must not serve a whole interval of
    // requests on months-old prices when a refresh was available at startup.
    expect(calls).toBe(1);
  });

  it('schedules the recurring check and unrefs it', () => {
    let unreffed = false;
    let scheduled: number | undefined;
    const stop = startPriceRefresh(home, {
      update: async () => {},
      now: () => NOW,
      setInterval: ((_fn: () => void, ms: number) => {
        scheduled = ms;
        return { unref() { unreffed = true; } };
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    stop();
    expect(scheduled).toBe(PRICE_CHECK_INTERVAL_MS);
    // A refresh timer must never be the reason the process stays alive.
    expect(unreffed).toBe(true);
  });

  it('stop() clears the interval', () => {
    let cleared = false;
    const handle = { unref() {} };
    const stop = startPriceRefresh(home, {
      update: async () => {},
      now: () => NOW,
      setInterval: (() => handle) as unknown as typeof setInterval,
      clearInterval: ((h: unknown) => { cleared = h === handle; }) as unknown as typeof clearInterval,
    });
    stop();
    expect(cleared).toBe(true);
  });
});
