import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WELL_KNOWN_PROVIDER_URLS, detectOpenCode } from '../src/detect.js';

describe('detectOpenCode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports an absent opencode without a blocking problem', async () => {
    // An empty PATH plus a home holding no `.opencode/bin` is the zero-harness
    // machine. Reporting that as an error was the one blocking problem in
    // `sonata init`'s preflight there, so the BYOK path it exists for could
    // never be reached — asserting on the severity rather than the message
    // keeps this about "does init proceed", which is the actual contract.
    vi.stubEnv('PATH', '');
    const home = mkdtempSync(join(tmpdir(), 'sonata-detect-'));

    const status = await detectOpenCode({ home, supportedVersions: '>=1.0.0' });

    expect(status.installed).toBe(false);
    expect(status.problems).toEqual([]);
  });
});

describe('OpenCode gateway URLs', () => {
  it('points Zen at opencode.ai/zen, beside Go', () => {
    // api.opencode.ai answers /models with a 200 "Not Found" text body, so a
    // Zen gateway added by hand fetched no models while Go's listed fine.
    expect(WELL_KNOWN_PROVIDER_URLS['opencode']).toBe('https://opencode.ai/zen/v1');
    expect(WELL_KNOWN_PROVIDER_URLS['opencode-go']).toBe('https://opencode.ai/zen/go/v1');
  });
});
