import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanRunLog, runLogFile } from '../src/run-log.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sonata-run-log-')); });

describe('runLogFile', () => {
  it('names harness.log for a non-interactive run whose log has content', () => {
    writeFileSync(join(dir, 'harness.log'), 'output\n');
    expect(runLogFile(dir, { interactive: false })).toEqual({ path: join(dir, 'harness.log'), source: 'harness' });
  });

  it('names events.jsonl for an interactive run, whatever harness.log holds', () => {
    // A TUI's log is its screen redraws; the screen diff is the better record.
    writeFileSync(join(dir, 'harness.log'), 'output\n');
    expect(runLogFile(dir, { interactive: true }).source).toBe('events');
  });

  it('names events.jsonl when harness.log is absent, empty, or only escapes and whitespace', () => {
    expect(runLogFile(dir, { interactive: false }).source).toBe('events');
    writeFileSync(join(dir, 'harness.log'), '');
    expect(runLogFile(dir, { interactive: false }).source).toBe('events');
    writeFileSync(join(dir, 'harness.log'), '\u001b[0m \n\t\u001b[?25h\n');
    expect(runLogFile(dir, { interactive: false }).source).toBe('events');
  });

  it('finds content that starts beyond the first read', () => {
    writeFileSync(join(dir, 'harness.log'), `${' '.repeat(200_000)}late\n`);
    expect(runLogFile(dir, { interactive: false }).source).toBe('harness');
  });
});

describe('cleanRunLog', () => {
  it('strips escapes and trailing space, and keeps every line of content', () => {
    expect(cleanRunLog('\u001b[1mbold\u001b[0m  \nplain\n')).toBe('bold\nplain');
  });

  it('reads CRLF as a line break and a bare CR as the terminal does', () => {
    // A progress bar redraws its line with \r; the terminal shows the last.
    expect(cleanRunLog('a\r\nprogress 10%\rprogress 100%\nb\n')).toBe('a\nprogress 100%\nb');
  });

  it('drops blank lines, as the event log does', () => {
    expect(cleanRunLog('a\n\n\nb\n')).toBe('a\nb');
  });
});

describe('cleanRunLog — terminal edge cases', () => {
  it('keeps text a trailing carriage return does not erase', () => {
    // A CR moves the cursor without erasing: `keep me\r` leaves "keep me".
    expect(cleanRunLog('keep me\r\r\nnext\n')).toBe('keep me\nnext');
    expect(cleanRunLog('only\r')).toBe('only');
    expect(cleanRunLog('50%\r100%\n')).toBe('100%');
  });

  it('strips OSC and charset escapes, not only CSI', () => {
    const osc = '\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\';
    expect(cleanRunLog(`${osc}\n\u001b(Bplain\u001b]0;title\u0007\n`)).toBe('link\nplain');
  });

  it('does not count a log of only OSC escapes as content', () => {
    writeFileSync(join(dir, 'harness.log'), '\u001b]0;title\u0007\n\u001b(B\n');
    expect(runLogFile(dir, { interactive: false }).source).toBe('events');
  });
});
