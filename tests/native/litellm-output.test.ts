import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  LITELLM_CHATGPT_LOGIN_REFUSED, lineSplitter, pipeLitellmOutput, redactDeviceCode,
} from '../../src/native/litellm-output.js';

// Captured from LiteLLM 1.98.0's own chatgpt authenticator, driven with a
// refresh token OpenAI refuses (`refresh_token_reused`): its stderr warning
// and the device-code prompt it then prints to stdout.
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'litellm');
const refusedStderr = readFileSync(join(FIXTURES, 'chatgpt-refresh-refused.txt'), 'utf8');
const deviceCodeStdout = readFileSync(join(FIXTURES, 'chatgpt-device-code.txt'), 'utf8');

const collect = (feed: (push: (chunk: string | Buffer) => void) => void): string[] => {
  const lines: string[] = [];
  const splitter = lineSplitter((line) => lines.push(line));
  feed((chunk) => splitter.push(chunk));
  splitter.end();
  return lines;
};

describe('LITELLM_CHATGPT_LOGIN_REFUSED', () => {
  it('matches the line LiteLLM logs when its refresh token is refused', () => {
    const lines = refusedStderr.split('\n');
    expect(lines.filter((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line))).toHaveLength(1);
    expect(lines.find((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line))).toContain('re-login required');
  });

  it('matches the device-code prompt it falls back to, and nothing else in it', () => {
    const lines = deviceCodeStdout.split('\n');
    expect(lines.filter((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line)))
      .toEqual(['Sign in with ChatGPT using device code:']);
  });

  it('does not match an ordinary LiteLLM line', () => {
    expect(LITELLM_CHATGPT_LOGIN_REFUSED.test('INFO:     127.0.0.1:52100 - "POST /v1/messages HTTP/1.1" 200 OK')).toBe(false);
  });
});

describe('redactDeviceCode', () => {
  it('masks the user code a device-code login prints, and only that', () => {
    const redacted = deviceCodeStdout.split('\n').map(redactDeviceCode);
    expect(redacted).toContain('2) Enter code: ****');
    expect(redacted.join('\n')).not.toMatch(/Enter code: U\b/);
    expect(redacted.filter((line, k) => line !== deviceCodeStdout.split('\n')[k])).toHaveLength(1);
  });
});

describe('lineSplitter', () => {
  it('rejoins lines split across chunks, and delivers a final line with no newline', () => {
    const text = `${refusedStderr}partial final line`;
    const bytes = Buffer.from(text);
    const chunked = collect((push) => { for (let at = 0; at < bytes.length; at += 7) push(bytes.subarray(at, at + 7)); });
    expect(chunked).toEqual(text.split('\n'));
  });

  it('does not split a multi-byte character across chunks', () => {
    const bytes = Buffer.from('LiteLLM — ready\n');
    expect(collect((push) => { push(bytes.subarray(0, 9)); push(bytes.subarray(9)); })).toEqual(['LiteLLM — ready']);
  });
});

describe('pipeLitellmOutput', () => {
  const run = async (input: string, chunk = 5) => {
    const source = new PassThrough();
    const sink = new PassThrough();
    const forwarded: Buffer[] = [];
    sink.on('data', (data: Buffer) => forwarded.push(data));
    const seen: string[] = [];
    pipeLitellmOutput(source, sink, (line) => seen.push(line));
    const bytes = Buffer.from(input);
    for (let at = 0; at < bytes.length; at += chunk) source.write(bytes.subarray(at, at + chunk));
    source.end();
    await new Promise((resolve) => setImmediate(resolve));
    return { out: Buffer.concat(forwarded).toString('utf8'), seen };
  };

  it('forwards LiteLLM\'s stderr unchanged, line by line, and hands each line on', async () => {
    const { out, seen } = await run(refusedStderr);
    expect(out).toBe(refusedStderr);
    expect(seen.some((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line))).toBe(true);
  });

  it('forwards the device-code prompt with its code masked, but hands on the line as written', async () => {
    const { out, seen } = await run(deviceCodeStdout);
    expect(out).toBe(deviceCodeStdout.replace('Enter code: U', 'Enter code: ****'));
    expect(seen).toContain('2) Enter code: U');
  });

  it('still forwards a partial final line when the stream ends', async () => {
    const { out, seen } = await run('first\nno newline at exit');
    expect(out).toBe('first\nno newline at exit\n');
    expect(seen).toEqual(['first', 'no newline at exit']);
  });
});
