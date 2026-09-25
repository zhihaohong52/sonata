import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeAdapter, claudeUsage } from '../../src/adapters/claude.js';
import { codexUsage } from '../../src/adapters/codex.js';
import { openCodeUsage } from '../../src/adapters/opencode.js';
import { piUsage } from '../../src/adapters/pi.js';
import { reasonixUsage } from '../../src/adapters/reasonix.js';
import type { UsageQuery } from '../../src/adapters/types.js';
import { sqliteAvailable } from '../opencode-db-fixture.js';

// Every value below is invented. The FIELD NAMES are the ones observed on a
// real machine's stores (2026-09-25) — the thing these tests pin down.

let home: string;
let cwd: string;
const START = Date.parse('2026-09-25T04:00:00.000Z');
const END = Date.parse('2026-09-25T04:10:00.000Z');
const DURING = '2026-09-25T04:01:00.000Z';

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'sonata-usage-home-')));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sonata-usage-cwd-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function query(extra: Partial<UsageQuery> = {}): UsageQuery {
  return { home, cwd, runDir: join(cwd, '.sonata', 'runs', 'r1'), startMs: START, endMs: END, modelId: 'm', ...extra };
}

function jsonl(path: string, lines: unknown[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('codex usage', () => {
  function rollout(name: string, dir: string, events: unknown[]): void {
    jsonl(join(home, '.codex', 'sessions', '2026', '09', '25', name), [
      { type: 'session_meta', timestamp: DURING, payload: { id: `thread-${name}`, cwd: dir, timestamp: DURING } },
      ...events,
    ]);
  }
  const tokenCount = (input: number, cached: number, output: number) => ({
    type: 'event_msg', timestamp: DURING,
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 3, total_tokens: input + output } } },
  });

  it('takes the LAST cumulative total and moves cached input out of input', () => {
    rollout('rollout-a.jsonl', cwd, [
      { type: 'turn_context', payload: { model: 'gpt-x' } },
      tokenCount(100, 40, 5),
      tokenCount(300, 200, 20),
    ]);
    const result = codexUsage(query());
    expect(result).toEqual({
      kind: 'observed',
      session: 'thread-rollout-a.jsonl',
      records: [{ ts: DURING, model: 'gpt-x', tokens: { input: 100, output: 20, cacheRead: 200, cacheCreation: 0 } }],
    });
  });

  it('tells two concurrent runs in one directory apart by the run marker in the prompt', () => {
    const marked = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `do it\n<!-- sonata run: ${query().runDir} -->` }] } };
    rollout('rollout-mine.jsonl', cwd, [marked, tokenCount(50, 0, 5)]);
    rollout('rollout-theirs.jsonl', cwd, [tokenCount(999, 0, 999)]);
    const result = codexUsage(query());
    expect(result.kind === 'observed' && result.session).toBe('thread-rollout-mine.jsonl');
  });

  it('ignores a session in another directory, and refuses to guess between two here', () => {
    rollout('rollout-other.jsonl', join(cwd, 'elsewhere'), [tokenCount(1, 0, 1)]);
    expect(codexUsage(query()).kind).toBe('unobservable');
    rollout('rollout-a.jsonl', cwd, [tokenCount(1, 0, 1)]);
    rollout('rollout-b.jsonl', cwd, [tokenCount(1, 0, 1)]);
    const result = codexUsage(query());
    expect(result.kind).toBe('unobservable');
    expect(result.kind === 'unobservable' && result.reason).toMatch(/2 codex sessions/);
  });
});

describe.skipIf(!sqliteAvailable())('opencode usage', () => {
  function db(sessions: Array<[string, string | null, string, number]>, messages: Array<[string, string, unknown]>): void {
    const path = join(home, '.local', 'share', 'opencode', 'opencode.db');
    mkdirSync(join(path, '..'), { recursive: true });
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
    };
    const handle = new DatabaseSync(path);
    handle.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, time_created integer NOT NULL)');
    handle.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL)');
    for (const row of sessions) handle.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run(...row);
    for (const [id, session, data] of messages) {
      handle.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, START, JSON.stringify(data));
    }
    handle.close();
  }
  const assistant = (tokens: object, extra: object = {}) => ({
    role: 'assistant', modelID: 'kimi', time: { created: START + 1000, completed: START + 2000 }, tokens, ...extra,
  });

  it('sums the root session and its subagent children, skipping unfinished messages', () => {
    db(
      [['ses_root', null, cwd, START + 500], ['ses_child', 'ses_root', cwd, START + 900], ['ses_other', null, '/nowhere', START + 500]],
      [
        ['m1', 'ses_root', assistant({ input: 10, output: 5, reasoning: 2, cache: { read: 7, write: 1 } }, { cost: 0.5 })],
        ['m2', 'ses_child', assistant({ input: 3, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, { cost: 0.25 })],
        ['m3', 'ses_root', { ...assistant({ input: 99, output: 99 }), time: { created: START } }],
        ['m4', 'ses_other', assistant({ input: 1000, output: 1000 })],
      ],
    );
    const result = openCodeUsage(query());
    expect(result.kind).toBe('observed');
    if (result.kind !== 'observed') return;
    expect(result.session).toBe('ses_root');
    expect(result.records.map((r) => r.tokens)).toEqual([
      { input: 10, output: 7, cacheRead: 7, cacheCreation: 1 },
      { input: 3, output: 1, cacheRead: 0, cacheCreation: 0 },
    ]);
    expect(result.records.map((r) => r.costUsd)).toEqual([0.5, 0.25]);
  });

  it('tells two concurrent runs apart by the run marker opencode stored in `part`', () => {
    db([['ses_mine', null, cwd, START + 500], ['ses_theirs', null, cwd, START + 600]], [
      ['m1', 'ses_mine', assistant({ input: 1, output: 1 })],
      ['m2', 'ses_theirs', assistant({ input: 999, output: 999 })],
    ]);
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
    };
    const handle = new DatabaseSync(join(home, '.local', 'share', 'opencode', 'opencode.db'));
    handle.exec('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
    handle.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'u1', 'ses_mine', START, START, JSON.stringify({ type: 'text', text: `<!-- sonata run: ${query().runDir} -->` }));
    handle.close();
    const result = openCodeUsage(query());
    expect(result.kind === 'observed' && result.session).toBe('ses_mine');
  });

  it('does not trust a zero cost — opencode writes 0 for a model it cannot price', () => {
    db([['ses_root', null, cwd, START + 500]], [['m1', 'ses_root', assistant({ input: 10, output: 5 }, { cost: 0 })]]);
    const result = openCodeUsage(query());
    expect(result.kind === 'observed' && result.records[0]!.costUsd).toBeUndefined();
  });

  it('is unobservable with no database', () => {
    expect(openCodeUsage(query()).kind).toBe('unobservable');
  });
});

describe('pi usage', () => {
  it('reads per-message usage from the session whose header names this directory', () => {
    const dir = join(home, '.pi', 'agent', 'sessions', '--flat--');
    jsonl(join(dir, 'a.jsonl'), [
      { type: 'session', id: 'pi-1', cwd, timestamp: DURING, version: 3 },
      { type: 'message', timestamp: DURING, message: { role: 'user' } },
      { type: 'message', timestamp: DURING, message: { role: 'assistant', model: 'glm', usage: { input: 4, output: 2, cacheRead: 8, cacheWrite: 1, cost: { total: 0.01 } } } },
    ]);
    jsonl(join(dir, 'b.jsonl'), [{ type: 'session', id: 'pi-2', cwd: '/nowhere', timestamp: DURING, version: 3 }]);
    const result = piUsage(query());
    expect(result).toEqual({
      kind: 'observed',
      session: 'pi-1',
      records: [{ ts: DURING, model: 'glm', tokens: { input: 4, output: 2, cacheRead: 8, cacheCreation: 1 }, costUsd: 0.01 }],
    });
  });
});

describe('reasonix usage', () => {
  function session(project: string, name: string): void {
    const path = join(home, '.reasonix', 'projects', project, 'sessions', name);
    jsonl(path, [{}]);
    utimesSync(path, new Date(END), new Date(END));
  }
  const local = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.000000000-flash.jsonl`;
  };
  const stats = () => jsonl(join(home, '.reasonix', 'stats', '2026-09-25.jsonl'), [
    { ts: DURING, model: 'p/flash', prompt: 100, completion: 9, cache_hit: 60, cache_miss: 40 },
    { ts: DURING, source: 'cli', turn: true },
    { ts: '2026-09-25T09:00:00.000Z', model: 'p/flash', prompt: 5, completion: 5, cache_miss: 5 },
  ]);

  it('attributes the stats rows in the window when this was the only reasonix session', () => {
    session(cwd.replace(/[/.]/g, '-'), local(START + 1000));
    stats();
    const result = reasonixUsage(query());
    expect(result).toEqual({
      kind: 'observed',
      records: [{ ts: DURING, model: 'p/flash', tokens: { input: 40, output: 9, cacheRead: 60, cacheCreation: 0 } }],
    });
  });

  it('refuses when another reasonix session anywhere ran at the same time', () => {
    session(cwd.replace(/[/.]/g, '-'), local(START + 1000));
    session('-some-other-project', local(START + 2000));
    stats();
    const result = reasonixUsage(query());
    expect(result.kind).toBe('unobservable');
    expect(result.kind === 'unobservable' && result.reason).toMatch(/name no session/);
  });
});

describe('claude usage', () => {
  it('passes the session id sonata chose', () => {
    const plan = claudeAdapter.plan({
      modelId: 'm', role: 'code', mode: 'acceptEdits', cwd, runDir: join(cwd, 'r'), instructionsPath: join(cwd, 'i'),
      sessionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(plan.script).toContain("--session-id '00000000-0000-4000-8000-000000000001'");
  });

  it('answers "router" for a routed run, so its requests are not counted twice', () => {
    writeFileSync(join(cwd, 'sonata.toml'), [
      '[native.gateways."g"]', 'base_url = "https://g.example/v1"', '',
      '[models."k"]', 'gateway = "g"', 'id = "k"', 'context_window = 128000', '',
    ].join('\n'));
    expect(claudeUsage(query({ sessionId: 's-1' }))).toEqual({ kind: 'router', session: 's-1' });
  });

  it('reads an unrouted transcript by session id, keeping the last copy of each message', () => {
    jsonl(join(home, '.claude', 'projects', '-flat-', 's-1.jsonl'), [
      { type: 'user', timestamp: DURING },
      { type: 'assistant', timestamp: DURING, message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'assistant', timestamp: DURING, message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 1, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
    ]);
    const result = claudeUsage(query({ sessionId: 's-1' }));
    expect(result).toEqual({
      kind: 'observed',
      session: 's-1',
      records: [{ ts: DURING, model: 'claude-x', tokens: { input: 1, output: 9, cacheRead: 5, cacheCreation: 2 } }],
    });
  });
});
