import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionDetail, runDetail, MAX_TRANSCRIPT_BYTES } from '../../src/native/ui-detail.js';
import { handleUiRequest } from '../../src/native/ui.js';
import { clearProjectDirCache } from '../../src/native/ui-runs.js';

let home: string;
let proj: string;
let outside: string;

beforeEach(() => {
  clearProjectDirCache();
  home = mkdtempSync(join(tmpdir(), 'sonata-uid-'));
  proj = mkdtempSync(join(tmpdir(), 'projD-'));
  outside = mkdtempSync(join(tmpdir(), 'outsideD-'));
  const usage = join(home, '.config', 'sonata', 'usage');
  mkdirSync(usage, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join(usage, `${day}.jsonl`), [
    JSON.stringify({
      ts: new Date().toISOString(), ms: 5, session: 's1', alias: 'sonata-code-simple', key: 'flash',
      upstream: 'litellm', status: 200, complete: true, tokens: { input: 10, output: 2 },
      price: { source: 'models-dev', totalUsd: 0.1 },
      attempts: [{ key: 'terra', status: 503 }],
    }),
    JSON.stringify({
      ts: new Date().toISOString(), ms: 5, session: 's2', alias: 'sonata-review-simple', key: 'terra',
      upstream: 'litellm', status: 200, complete: true, tokens: { input: 1, output: 1 },
      price: { source: 'none' }, attempts: [],
    }),
  ].join('\n') + '\n');
  mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
  writeFileSync(join(home, '.config', 'sonata', 'sessions.json'), JSON.stringify({
    s1: { session: 's1', cwd: proj, started: '2026-09-15T00:00:00.000Z' },
  }));

  const dir = join(proj, '.sonata', 'runs', 'aaa111');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'aaa111', session: 'sonata-aaa111', cwd: proj, role: 'code' }));
  writeFileSync(join(dir, 'events.jsonl'), 'line one\nline two\n');
  writeFileSync(join(dir, 'report.md'), '# done\n');
});

afterEach(() => {
  for (const d of [home, proj, outside]) rmSync(d, { recursive: true, force: true });
});

const deps = () => ({ home, port: 4100, tenants: () => [{ id: 't', configPath: join(proj, 'sonata.toml') }] });

function body(res: { body: unknown }): any {
  return JSON.parse((res.body as Buffer).toString());
}

function makeRun(cwd: string, id: string, events = 'line one\nline two\n', report = '# done\n'): void {
  const dir = join(cwd, '.sonata', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, session: `sonata-${id}`, cwd }));
  writeFileSync(join(dir, 'events.jsonl'), events);
  writeFileSync(join(dir, 'report.md'), report);
}

describe('sessionDetail', () => {
  it('returns only that session’s request stream', () => {
    const detail = sessionDetail(deps(), 's1', new URLSearchParams('since=30d'));
    expect(detail.routes).toHaveLength(1);
    expect(detail.routes[0].served).toBe('flash');
  });

  it('carries the candidates the request fell past', () => {
    const detail = sessionDetail(deps(), 's1', new URLSearchParams('since=30d'));
    expect(detail.routes[0].attempts).toEqual([{ key: 'terra', status: 503 }]);
  });

  it('returns an empty stream for an unknown session rather than throwing', () => {
    expect(sessionDetail(deps(), 'nope', new URLSearchParams('since=30d')).routes).toEqual([]);
  });

  it('serves a session detail through the HTTP handler', () => {
    const ok = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/session/s1?since=30d', headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(ok?.status).toBe(200);
    expect(body(ok!).id).toBe('s1');
  });
});

describe('runDetail', () => {
  it('returns the transcript and the report', () => {
    const detail = runDetail(deps(), 'aaa111', proj)!;
    expect(detail.transcript).toContain('line two');
    expect(detail.report).toBe('# done\n');
    expect(detail.truncated).toBe(false);
  });

  it('finds the run without a cwd hint by searching discovered projects', () => {
    expect(runDetail(deps(), 'aaa111', undefined)!.cwd).toBeTruthy();
  });

  it('refuses a cwd that is not a discovered project, so the param cannot read arbitrary paths', () => {
    expect(runDetail(deps(), 'aaa111', '/etc')).toBeUndefined();
  });

  it('does not read a well-formed run outside discovered projects', () => {
    makeRun(outside, 'bbb222', 'secret\n');
    expect(runDetail(deps(), 'bbb222', outside)).toBeUndefined();
  });

  it.each([
    '..', '../aaa111', '../../etc/passwd', '/aaa111', 'aaa111/extra', 'AAA111',
  ])('rejects unsafe run id %s before path access', (id) => {
    expect(runDetail(deps(), id, proj)).toBeUndefined();
  });

  it('rejects a percent-encoded traversal id through the HTTP handler', () => {
    const res = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/run/%2e%2e%2f%2e%2e%2fetc%2fpasswd?project=' + encodeURIComponent(proj), headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(res?.status).toBe(404);
  });

  it('serves a run detail through the HTTP handler and 404s unknown ids', () => {
    const ok = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/run/aaa111?project=' + encodeURIComponent(proj), headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(ok?.status).toBe(200);
    expect(body(ok!).report).toBe('# done\n');
    const missing = handleUiRequest(
      { method: 'GET', url: '/__sonata/api/run/zzz999?project=' + encodeURIComponent(proj), headers: { host: 'localhost:4100' } },
      deps(),
    );
    expect(missing?.status).toBe(404);
  });

  it('round-trips emoji transcript content through JSON without change', () => {
    makeRun(proj, 'ccc333', 'before\n😀🚀\nafter\n');
    const detail = runDetail(deps(), 'ccc333', proj)!;
    expect(JSON.parse(JSON.stringify(detail)).transcript).toBe(detail.transcript);
  });

  it('caps multibyte transcripts in UTF-8 bytes without losing the tail', () => {
    const dir = join(proj, '.sonata', 'runs', 'ddd444');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'ddd444', session: 'sonata-ddd444', cwd: proj }));
    writeFileSync(join(dir, 'events.jsonl'), `START\n${'é'.repeat(MAX_TRANSCRIPT_BYTES / 2 + 1000)}\nEND\n`);
    const detail = runDetail(deps(), 'ddd444', proj)!;
    expect(detail.truncated).toBe(true);
    expect(Buffer.byteLength(detail.transcript, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(detail.transcript).toContain('END');
    expect(detail.transcript).not.toContain('START');
    expect(JSON.parse(JSON.stringify(detail)).transcript).toBe(detail.transcript);
  });

  it('truncates a long transcript tail-first and says so', () => {
    const dir = join(proj, '.sonata', 'runs', 'bee999');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id: 'bee999', session: 'sonata-bee999', cwd: proj }));
    writeFileSync(join(dir, 'events.jsonl'), `START\n${'x'.repeat(MAX_TRANSCRIPT_BYTES + 1000)}\nEND\n`);
    const detail = runDetail(deps(), 'bee999', proj)!;
    expect(detail.truncated).toBe(true);
    expect(Buffer.byteLength(detail.transcript, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(detail.transcript).toContain('END');
    expect(detail.transcript).not.toContain('START');
  });
});
