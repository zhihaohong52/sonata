import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { withSessionLockSync } from '../filelock.js';
import { readOpencodeCredentials } from './opencode-store.js';
import { readOnce } from './read-snapshot.js';
import { DECISION_PROVIDERS, SELF_HOSTED_DECISION_GATEWAY } from './decision-providers.js';

export interface KeySource {
  gateway: string;
  /** Concrete backing store (`opencode` means auth.json for compatibility). */
  source: string;
  key: string;
}

export interface KeyReport {
  gateway: string;
  source: string | null;
}

/** One gateway's key inside one store, and the store name to report it under. */
interface KeyStoreValue {
  key: string;
  source: string;
}

/** A place keys are read from, in precedence order. Not the config's CredentialSource union. */
interface KeyStoreSource {
  name: string;
  read(home: string): Record<string, KeyStoreValue>;
}

/**
 * What went wrong reading a JSON credential store, for writers that must
 * refuse rather than start from nothing.
 */
export type StoreReadProblem =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'invalid'; reason: string };

function errnoCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}

function readJsonStrict(path: string): { value?: Record<string, unknown>; problem?: StoreReadProblem } {
  let bytes: Buffer;
  try {
    bytes = readOnce(path);
  } catch (error) {
    const code = errnoCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { problem: { kind: 'missing' } }
      : { problem: { kind: 'unreadable', reason: `${path}: ${code}` } };
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { problem: { kind: 'invalid', reason: `${path} is not valid JSON (refusing to rewrite it)` } };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: { kind: 'invalid', reason: `${path} does not hold a JSON object (refusing to rewrite it)` } };
  }
  return { value: value as Record<string, unknown> };
}

function readJson(path: string): Record<string, unknown> {
  const { value } = readJsonStrict(path);
  return value ?? {};
}

function usableKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The sonata store as it is persisted: plain gateway → key strings. Writing
 * goes through this shape, never the resolved one — serializing `KeyStoreValue`
 * objects into keys.json silently corrupted the file on the second write.
 */
function sonataKeyMap(home: string): Record<string, string> {
  return sonataKeyStrings(readJson(sonataKeyStorePath(home)));
}

function sonataKeys(home: string): Record<string, KeyStoreValue> {
  return Object.fromEntries(
    Object.entries(sonataKeyMap(home)).map(([gateway, key]) => [gateway, { key, source: 'sonata' }]),
  );
}

function opencodeKeys(home: string): Record<string, KeyStoreValue> {
  return Object.fromEntries(
    Object.entries(readOpencodeCredentials(home)).flatMap(([gateway, credential]) => {
      const key = usableKey(credential.key);
      return key === undefined ? [] : [[gateway, {
        key,
        source: credential.origin === 'opencode.db' ? 'opencode.db' : 'opencode',
      }]];
    }),
  );
}

const SOURCES: KeyStoreSource[] = [
  { name: 'sonata', read: sonataKeys },
  { name: 'opencode', read: opencodeKeys },
];

export function sonataKeyStorePath(home: string): string {
  return join(home, '.config/sonata/keys.json');
}

/**
 * Gateways one key authenticates, beyond the gateway it is filed under.
 *
 * OpenCode Zen and OpenCode Go are two endpoints on one opencode.ai account
 * (measured: a key filed as `opencode-go` gets a 200 from Zen's
 * chat/completions), but opencode files the key under whichever one you
 * logged in to. Looked up by name alone, the other gateway had no key, so it
 * was never offered for import and never asked what models it serves.
 */
const SHARED_KEY_GATEWAYS: readonly (readonly string[])[] = [['opencode', 'opencode-go']];

/** The gateway itself first, then any gateway sharing its key. */
function keyNamesFor(gateway: string): string[] {
  const group = SHARED_KEY_GATEWAYS.find((names) => names.includes(gateway)) ?? [];
  return [gateway, ...group.filter((name) => name !== gateway)];
}

/**
 * The key one named store holds for a gateway: its own entry first, then a
 * gateway sharing its key. For a gateway pinned to a `credential_source`,
 * where the other stores must not be consulted.
 */
export function resolveKeyFromSource(
  gateway: string,
  home: string,
  source: 'sonata' | 'opencode',
): string | undefined {
  return resolveKeyDetail(gateway, home, source)?.key;
}

/** The resolved key plus its concrete store, for diagnostics that name v1/v2. */
export function resolveKeyDetail(
  gateway: string,
  home: string,
  source: 'sonata' | 'opencode',
): { key: string; source: string } | undefined {
  const keys = SOURCES.find((candidate) => candidate.name === source)?.read(home) ?? {};
  for (const name of keyNamesFor(gateway)) {
    const value = keys[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The key each gateway authenticates with, and the store it came from.
 *
 * Stores are searched in `SOURCES` order. A gateway with no key anywhere is
 * absent from the result, never present with an empty key.
 */
export function resolveKeys(gateways: string[], home: string): KeySource[] {
  const sources = SOURCES.map((source) => ({ name: source.name, keys: source.read(home) }));
  const resolved: KeySource[] = [];

  // Name before source: a key filed under the gateway itself, anywhere, beats
  // a shared one, so sharing only fills a gap and never overrides a choice.
  for (const gateway of new Set(gateways)) {
    search: for (const name of keyNamesFor(gateway)) {
      for (const source of sources) {
        // An own key only: a gateway named `constructor` must not read an inherited value.
        const value = Object.hasOwn(source.keys, name) ? source.keys[name] : undefined;
        if (value !== undefined) {
          resolved.push({ gateway, source: value.source, key: value.key });
          break search;
        }
      }
    }
  }

  return resolved;
}

/**
 * The key a decision server's gateway name resolves to, with its store — the
 * one policy serve, doctor, Setup and the Keys screen all use. A provider
 * gateway (`openrouter`, or a configured gateway that serves decisions) keeps
 * the provider lookup, honouring a pinned `credential_source`; `typesafe`,
 * `auto-route` and any other decision-only name live in sonata's own store,
 * never another harness's.
 */
export function resolveDecisionKey(
  gateway: string,
  home: string,
  configured?: { credentialSource?: string },
): { key: string; source: string } | undefined {
  const named = DECISION_PROVIDERS.find((p) => p.gateway === gateway);
  const decisionOnly = gateway === SELF_HOSTED_DECISION_GATEWAY || named?.keyStore === 'sonata';
  if (decisionOnly) return resolveKeyDetail(gateway, home, 'sonata');
  const pinned = configured?.credentialSource;
  if (pinned === 'sonata' || pinned === 'opencode') return resolveKeyDetail(gateway, home, pinned);
  const found = resolveKeys([gateway], home)[0];
  return found === undefined ? undefined : { key: found.key, source: found.source };
}

export function keyReport(gateways: string[], home: string): KeyReport[] {
  const sources = new Map(resolveKeys(gateways, home).map(({ gateway, source }) => [gateway, source]));
  return gateways.map((gateway) => ({ gateway, source: sources.get(gateway) ?? null }));
}

/**
 * The read-modify-write of keys.json, under its lock so two writers (an
 * `auth add` and an `init`, say) cannot each drop the other's key.
 */
export function writeSonataKey(home: string, gateway: string, key: string): void {
  const path = sonataKeyStorePath(home);
  withSessionLockSync(path, () => {
    const { value, problem } = readJsonStrict(path);
    if (problem !== undefined && problem.kind !== 'missing') {
      throw new Error(`cannot store the key for "${gateway}": ${problem.reason}`);
    }
    writeFileAtomic(path, `${JSON.stringify({ ...sonataKeyStrings(value ?? {}), [gateway]: key }, null, 2)}\n`);
  });
}

export function removeSonataKey(home: string, gateway: string): void {
  const path = sonataKeyStorePath(home);
  withSessionLockSync(path, () => {
    const { value, problem } = readJsonStrict(path);
    if (problem !== undefined && problem.kind !== 'missing') {
      throw new Error(`cannot remove the key for "${gateway}": ${problem.reason}`);
    }
    const keys = sonataKeyStrings(value ?? {});
    delete keys[gateway];

    if (Object.keys(keys).length === 0) {
      try {
        unlinkSync(path);
      } catch {
        // A missing store has the same result as an empty one.
      }
      return;
    }

    writeFileAtomic(path, `${JSON.stringify(keys, null, 2)}\n`);
  });
}

/**
 * Write a small credential JSON file atomically: a temp file in the same
 * directory (so the rename stays on one filesystem), then rename, 0600.
 *
 * Without this, a crash or kill between truncate and write left a half file —
 * and for keys.json the next read parsed it as empty and every stored key
 * silently vanished.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** The sonata store as persisted: plain gateway → key strings. */
function sonataKeyStrings(raw: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([gateway, key]) => {
      const usable = usableKey(key);
      return usable === undefined ? [] : [[gateway, usable]];
    }),
  );
}
