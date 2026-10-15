import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, configPath, parseConfig, type NativeConfig } from '../config.js';
import { readSessions } from '../sessions.js';
import { seedUpgradeTrust } from './host-bindings.js';

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
 * When this build was installed, in epoch milliseconds: the change time of the
 * package's own manifest. npm can carry a tarball's mtime over, but a change
 * time is set when the file lands on this machine. Unreadable answers 0, so no
 * project predates the install and none is seeded: fail closed.
 */
export function buildInstalledAt(): number {
  try {
    return statSync(new URL('../../package.json', import.meta.url)).ctimeMs;
  } catch {
    return 0;
  }
}

/** One config the seed reads: its file, and the gateways it names. */
type SeedConfig = { configPath: string; gateways: NativeConfig['gateways'] };

/** The machine config, the one config that is trusted by definition. */
function machineConfigs(home: string): SeedConfig[] {
  const file = join(home, GLOBAL_CONFIG_RELATIVE);
  if (!existsSync(file)) return [];
  try {
    return [{ configPath: file, gateways: parseConfig(readFileSync(file, 'utf8')).native?.gateways ?? {} }];
  } catch {
    return [];
  }
}

/**
 * The project configs a router already used before this build was installed.
 * A project counts only when a session in it started before the install (a
 * session with no readable start time does not count), and its config file
 * itself was last changed before the install: a config edited since is not the
 * one the user had. The working directory of the command running now is never
 * one of these: only what sonata recorded before the upgrade is.
 */
function predatingProjectConfigs(home: string, installedAt: number): SeedConfig[] {
  const { sessions } = readSessions(home);
  const seen = new Set<string>();
  const out: SeedConfig[] = [];
  for (const record of Object.values(sessions)) {
    const started = Date.parse(record.started);
    if (!Number.isFinite(started) || started >= installedAt) continue;
    const file = configPath(record.cwd, home);
    if (file === null || seen.has(file)) continue;
    seen.add(file);
    try {
      // The later of the two times: a change time cannot be set back by a tool
      // that rewrites mtime, so a config edited after the install is excluded
      // whatever its mtime says.
      const stat = statSync(file);
      if (Math.max(stat.mtimeMs, stat.ctimeMs) >= installedAt) continue;
      out.push({ configPath: file, gateways: parseConfig(readFileSync(file, 'utf8')).native?.gateways ?? {} });
    } catch {
      // Unreadable or unparseable: nothing there to trust.
    }
  }
  return out;
}

/**
 * The upgrade's one-time trust seed. It binds the hosts that the machine config
 * and the projects that predate this install already use, and nothing else:
 *
 * - the machine config, always;
 * - a project only if a session recorded before the install ran in it and its
 *   config was last changed before the install (`predatingProjectConfigs`).
 *
 * Never the working directory of the command running now, and never a project
 * merely noted or cloned since. The marker is written on the first run after
 * the upgrade whatever the stores hold, so the seed runs once and a fresh
 * install, with nothing predating it, seeds nothing. Serve and doctor run it
 * before their checks; `auth add` and `init` run it before they store a key.
 */
export function seedTrustOnUpgrade(home: string, installedAt: number = buildInstalledAt()): string[] {
  return seedUpgradeTrust(home, runningVersion(), [
    ...machineConfigs(home),
    ...predatingProjectConfigs(home, installedAt),
  ]);
}

/**
 * The same seed, run by a command about to store a key. A key written before
 * the first serve or doctor run must not change which configs count as
 * predating the install, so it runs first, unconditionally.
 */
export function seedTrustBeforeKeyWrite(home: string): void {
  seedTrustOnUpgrade(home);
}
