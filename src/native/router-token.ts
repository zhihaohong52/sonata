/**
 * The secret that authorises a request to *choose* which project's config
 * serves it.
 *
 * The router listens on loopback and authenticates nobody, which was fine when
 * every request got the one config the daemon started with. `x-sonata-project`
 * changed that: it lets a caller name the directory whose `sonata.toml` — and
 * therefore whose gateways, endpoints and stored credentials — will serve the
 * request. A caller could point it at a directory it controls, declare a
 * gateway reusing a name the machine holds a key for, and have that key sent to
 * an endpoint of its choosing.
 *
 * So the hint is only honoured when the request also carries this token. The
 * file is 0600, which draws the boundary exactly where it belongs: a process
 * running as the user can read it, but that process can already read
 * `~/.config/sonata/credentials` and needs no router to steal a key. A process
 * that cannot — a different local user, a sandbox — can still reach the port,
 * and now gets the ordinary session/machine resolution instead of its pick.
 *
 * Persisted rather than generated per run, because a settings file written once
 * has to keep working across restarts.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where the token travels. Stripped before forwarding, like the project header. */
export const SONATA_TOKEN_HEADER = 'x-sonata-token';

export function routerTokenPath(home: string): string {
  return join(home, '.config', 'sonata', 'router-token');
}

/** The stored token, or undefined when none has been written (or it cannot be read). */
export function readRouterToken(home: string): string | undefined {
  try {
    const token = readFileSync(routerTokenPath(home), 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/**
 * The stored token, creating one if there is none.
 *
 * A blank or unreadable file is replaced rather than trusted: an empty token
 * would otherwise match an absent header and authorise everything.
 */
export function ensureRouterToken(home: string): string {
  const existing = readRouterToken(home);
  if (existing !== undefined) {
    // `mode` applies only when a file is created, so a token file that
    // arrived some other way (a copy, a restore, an older writer) keeps
    // whatever mode it had. Owner-only is the whole defence.
    try { chmodSync(routerTokenPath(home), 0o600); } catch { /* unreadable dirs fail later, loudly */ }
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  const path = routerTokenPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Whether a request may choose its own project. A constant-time compare, length-checked first. */
export function projectHintAuthorised(presented: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined || expected === '' || presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Kept so a caller need not reimplement the existsSync check. */
export function routerTokenExists(home: string): boolean {
  return existsSync(routerTokenPath(home));
}
