import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KeySource {
  gateway: string;
  source: string;
  key: string;
}

export interface KeyReport {
  gateway: string;
  source: string | null;
}

/** A place keys are read from, in precedence order. Not the config's CredentialSource union. */
interface KeyStoreSource {
  name: string;
  read(home: string): Record<string, string>;
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

function sonataKeys(home: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readJson(sonataKeyStorePath(home))).flatMap(([gateway, key]) => {
      const usable = usableKey(key);
      return usable === undefined ? [] : [[gateway, usable]];
    }),
  );
}

function opencodeKeys(home: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readJson(join(home, '.local/share/opencode/auth.json'))).flatMap(([gateway, value]) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
      const credential = value as Record<string, unknown>;
      const key = usableKey(credential.key) ?? usableKey(credential.apiKey);
      return key === undefined ? [] : [[gateway, key]];
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

export function resolveKeys(gateways: string[], home: string): KeySource[] {
  const sources = SOURCES.map((source) => ({ name: source.name, keys: source.read(home) }));
  const resolved: KeySource[] = [];

  for (const gateway of new Set(gateways)) {
    for (const source of sources) {
      const key = source.keys[gateway];
      if (key !== undefined) {
        resolved.push({ gateway, source: source.name, key });
        break;
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
  writeFileSync(path, `${JSON.stringify({ ...sonataKeys(home), [gateway]: key }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeSonataKey(home: string, gateway: string): void {
  const path = sonataKeyStorePath(home);
  const keys = sonataKeys(home);
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
