#!/usr/bin/env node
// SessionStart hook: makes sure the sonata router is up when a session is
// configured (via `sonata route on`) to route through it. The hook and the
// router are launched by the same install, so it knows the port directly.
//
// Unlike `sonata code`, which auto-starts the daemon as part of launching
// claude, a routed session is just `claude` — nothing of sonata runs to start
// the router. Without this hook the first thing such a session does is cache
// the connection error from a router that is not there.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.argv[2]);
const global = process.argv[3] === '--global';

/**
 * The sonata.toml this session should be routed through, mirroring
 * `configPath()` in src/config.ts (project config wins outright over the
 * machine one) — duplicated here in plain JS because this hook runs
 * standalone, not through the built TypeScript.
 */
function expectedConfigPath() {
  const home = homedir();
  if (global) {
    const globalPath = join(home, '.config', 'sonata', 'sonata.toml');
    return existsSync(globalPath) ? globalPath : null;
  }
  const localPath = join(process.cwd(), 'sonata.toml');
  if (existsSync(localPath)) return localPath;
  const globalPath = join(home, '.config', 'sonata', 'sonata.toml');
  return existsSync(globalPath) ? globalPath : null;
}

if (Number.isInteger(port) && port > 0) {
  const probeHealth = async (timeoutMs) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`http://localhost:${port}/__sonata_health`, { signal: ctrl.signal });
      if (!res.ok) return null;
      const body = await res.json();
      return body?.sonata === true ? body : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const existing = await probeHealth(1000);
  if (existing) {
    const expected = expectedConfigPath();
    // A router that reports no configPath (an older sonata build) or whose
    // config this session cannot resolve at all is not something this hook
    // can safely compare against — proceed as before rather than failing on
    // a check that has nothing to check against.
    if (expected !== null && typeof existing.configPath === 'string' && existing.configPath !== expected) {
      console.error(
        `sonata: router port ${port} is already serving a different sonata configuration ` +
        `(${existing.configPath}) than this session resolves to (${expected}). Two ` +
        'projects cannot share one router port — set a different [native.ports].router ' +
        'in one of the two configs, then restart the router with `sonata restart`.',
      );
      process.exit(1);
    }
    process.exit(0);
  }

  try {
    // Global routing is one shared router for every project — it has to
    // resolve the *machine* config, not whichever project's session happens
    // to trigger this hook first. Starting it from `home` (which has no
    // project sonata.toml of its own) forces that fallback deterministically;
    // a plain (project-scoped) install keeps inheriting this hook's own cwd.
    const daemon = spawn('sonata', ['serve', '--daemon'], {
      detached: true,
      stdio: 'ignore',
      ...(global ? { cwd: homedir() } : {}),
    });
    daemon.unref();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await probeHealth(1000)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  } catch {
    // A hook must never break the session it observes.
  }
}
process.exit(0);