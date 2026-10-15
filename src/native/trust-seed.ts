import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE } from '../config.js';
import { sessionsPath } from '../sessions.js';
import { sonataKeyStorePath } from './credentials.js';
import { seedUpgradeTrust } from './host-bindings.js';
import { TenantRegistry } from './tenants.js';

/** The running sonata version, recorded in the seed's marker. `unknown` when the manifest is unreadable. */
function runningVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The upgrade's one-time trust seed over every config the router would serve:
 * the machine config, each project in sessions.json, and each noted project.
 * Serve runs it before its first credential check and doctor before its own
 * credential-host check, so both read the same bindings. One line per binding
 * written; an empty list once the marker is there.
 */
export function seedTrustOnUpgrade(home: string, registry: TenantRegistry): string[] {
  // A fresh install has no configs that predate it, so nothing is seeded: a
  // repo cloned into a machine that never ran sonata must not be trusted by
  // the first run. The marker is still written, so that holds for every
  // later run too.
  const predates = [sonataKeyStorePath(home), sessionsPath(home), join(home, GLOBAL_CONFIG_RELATIVE)].some((path) => existsSync(path));
  return seedUpgradeTrust(
    home,
    runningVersion(),
    predates ? registry.loadable().map(({ configPath, config }) => ({ configPath, gateways: config.native?.gateways ?? {} })) : [],
  );
}

/**
 * The same seed, run by a command about to store a key. A key written before
 * the first serve or doctor run would otherwise make the configs that run
 * finds count as predating the upgrade; running it first records the state
 * as it was, so that a fresh install is never seeded.
 */
export function seedTrustBeforeKeyWrite(home: string, cwd: string): void {
  const registry = new TenantRegistry(home);
  registry.noteProject(cwd);
  seedTrustOnUpgrade(home, registry);
}
