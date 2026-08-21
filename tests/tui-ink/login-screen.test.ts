import { describe, expect, it } from 'vitest';
import { latestCode } from '../../src/tui-ink/components/login-screen.js';

describe('latestCode', () => {
  it('extracts the ChatGPT url and code from the printed block', () => {
    const got = latestCode([
      'Sign in with ChatGPT using device code:',
      '1) Visit https://auth.openai.com/codex/device',
      '2) Enter code: WDJB-MJHT',
    ]);
    expect(got).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'WDJB-MJHT' });
  });

  it('extracts the Copilot one-line form', () => {
    const got = latestCode(['Please visit https://github.com/login/device and enter code B524-A3C4 to authenticate.']);
    expect(got).toEqual({ url: 'https://github.com/login/device', code: 'B524-A3C4' });
  });

  it('returns the newest code, never an accumulation', () => {
    // Copilot retries three times, each with a fresh code. Showing the first
    // one strands the user on a code that is no longer polled.
    const got = latestCode([
      'Please visit https://github.com/login/device and enter code AAAA-1111 to authenticate.',
      'Please visit https://github.com/login/device and enter code BBBB-2222 to authenticate.',
    ]);
    expect(got.code).toBe('BBBB-2222');
  });

  it('is empty before any code is printed', () => {
    expect(latestCode(['Logging in…'])).toEqual({});
  });
});
