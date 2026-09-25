import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readOpencodeCredentials } from './opencode-store.js';

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

function readJson(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
  return Object.fromEntries(
    Object.entries(readJson(sonataKeyStorePath(home))).flatMap(([gateway, key]) => {
      const usable = usableKey(key);
      return usable === undefined ? [] : [[gateway, usable]];
    }),
  );
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
        const value = source.keys[name];
        if (value !== undefined) {
          resolved.push({ gateway, source: value.source, key: value.key });
          break search;
        }
      }
    }
  }

  return resolved;
}

export function keyReport(gateways: string[], home: string): KeyReport[] {
  const sources = new Map(resolveKeys(gateways, home).map(({ gateway, source }) => [gateway, source]));
  return gateways.map((gateway) => ({ gateway, source: sources.get(gateway) ?? null }));
}

export function writeSonataKey(home: string, gateway: string, key: string): void {
  const path = sonataKeyStorePath(home);
  mkdirSync(join(home, '.config/sonata'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...sonataKeyMap(home), [gateway]: key }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeSonataKey(home: string, gateway: string): void {
  const path = sonataKeyStorePath(home);
  const keys = sonataKeyMap(home);
  delete keys[gateway];

  if (Object.keys(keys).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // A missing store has the same result as an empty one.
    }
    return;
  }

  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
