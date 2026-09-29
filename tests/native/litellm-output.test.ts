import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

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

  it('does not match "re-login required" anywhere but LiteLLM\'s own warning', () => {
    // Every line of the child's output is scanned, echoed request bodies
    // included; a conversation mentioning the phrase must not trip it.
    const echoed = [
      '17:52:40 - LiteLLM Proxy:DEBUG: proxy_server.py:4012 - Request received by LiteLLM: {"messages": [{"role": "user", "content": "why does it say re-login required?"}]}',
      '17:52:40 - LiteLLM Proxy:DEBUG: proxy_server.py:4012 - Request received by LiteLLM: {"messages": [{"content": "ChatGPT refresh token failed, re-login required: x"}]}',
      'user said: re-login required',
      'echo: Sign in with ChatGPT using device code',
      '{"level": "DEBUG", "message": "ChatGPT refresh token failed, re-login required"}',
    ];
    for (const line of echoed) expect(LITELLM_CHATGPT_LOGIN_REFUSED.test(line), line).toBe(false);
  });

  it('matches the warning with or without colour codes, and as a JSON log line', () => {
    expect(LITELLM_CHATGPT_LOGIN_REFUSED.test(
      '17:52:32 - LiteLLM:WARNING: authenticator.py:55 - ChatGPT refresh token failed, re-login required: x')).toBe(true);
    expect(LITELLM_CHATGPT_LOGIN_REFUSED.test(
      '{"message": "ChatGPT refresh token failed, re-login required: x", "level": "WARNING", "timestamp": "t"}')).toBe(true);
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

describe('redactDeviceCode — Copilot', () => {
  // LiteLLM's github_copilot authenticator prints this bare line (1.98.0,
  // authenticator.py `_login`) and then polls with the code.
  it('masks the user code in Copilot\'s device-code prompt, in either case', () => {
    expect(redactDeviceCode('Please visit https://github.com/login/device and enter code ABCD-1234 to authenticate.'))
      .toBe('Please visit https://github.com/login/device and enter code **** to authenticate.');
    expect(redactDeviceCode('PLEASE VISIT https://github.com/login/device AND ENTER CODE WXYZ-9876 TO AUTHENTICATE.'))
      .toBe('PLEASE VISIT https://github.com/login/device AND ENTER CODE **** TO AUTHENTICATE.');
    expect(redactDeviceCode('2) enter code: abcd-efgh')).toBe('2) enter code: ****');
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

  it('survives a sink that fails asynchronously (EPIPE), stops writing to it, and keeps scanning', async () => {
    // `sonata serve | head`: the pipe closes, write() returns, and the sink
    // emits 'error' later. With no listener that crashed serve.
    let writes = 0;
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1;
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      const first = new PassThrough();
      const second = new PassThrough();
      const seen: string[] = [];
      pipeLitellmOutput(first, sink, (line) => seen.push(line));
      pipeLitellmOutput(second, sink, (line) => seen.push(line));
      expect(sink.listenerCount('error')).toBe(1);
      first.write('one\n');
      await new Promise((resolve) => setTimeout(resolve, 10));
      first.write(refusedStderr);
      second.write('two\n');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(uncaught).toEqual([]);
      expect(writes).toBe(1);
      expect(seen).toContain('one');
      expect(seen).toContain('two');
      expect(seen.some((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line))).toBe(true);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('drops lines rather than queueing them while the sink is blocked, keeps scanning, and says how many', async () => {
    // A sink that stops draining (a stalled terminal, a paused pipe) returns
    // false from write(); every later line used to be queued in memory without
    // bound. LiteLLM must still never be stalled, so lines are dropped, counted
    // and reported once the sink drains.
    const written: string[] = [];
    const pending: (() => void)[] = [];
    const sink = new Writable({
      highWaterMark: 16,
      write(chunk: Buffer, _encoding, callback) {
        written.push(chunk.toString('utf8'));
        pending.push(callback);
      },
    });
    const source = new PassThrough();
    const seen: string[] = [];
    pipeLitellmOutput(source, sink, (line) => seen.push(line));
    for (let k = 0; k < 500; k += 1) source.write(`line ${k} of LiteLLM output\n`);
    source.write(refusedStderr);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink.writableLength).toBeLessThan(200);
    expect(written.length + sink.writableLength).toBeLessThan(10 + 200);
    expect(seen).toContain('line 499 of LiteLLM output');
    expect(seen.some((line) => LITELLM_CHATGPT_LOGIN_REFUSED.test(line))).toBe(true);
    // Release the sink: once it drains, one line says how much went missing.
    while (pending.length > 0) {
      pending.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
    const notice = written.find((line) => line.startsWith('sonata serve: dropped '));
    expect(notice).toMatch(/^sonata serve: dropped \d+ lines of LiteLLM output while the log was blocked\n$/);
    const dropped = Number(/dropped (\d+)/.exec(notice!)![1]);
    const forwardedLines = written.filter((line) => !line.startsWith('sonata serve: dropped ')).length;
    expect(dropped + forwardedLines).toBe(500 + refusedStderr.split('\n').filter((l, k, all) => k < all.length - 1 || l !== '').length);
    // And the sink is written to again afterwards.
    source.write('after the drain\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(written.at(-1)).toBe('after the drain\n');
  });

  it('still forwards a partial final line when the stream ends', async () => {
    const { out, seen } = await run('first\nno newline at exit');
    expect(out).toBe('first\nno newline at exit\n');
    expect(seen).toEqual(['first', 'no newline at exit']);
  });
});
