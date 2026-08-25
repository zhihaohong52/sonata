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
import { homedir } from 'node:os';

const port = Number(process.argv[2]);
const global = process.argv[3] === '--global';
if (Number.isInteger(port) && port > 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1000);
  try {
    const res = await fetch(`http://localhost:${port}/__sonata_health`, { signal: ctrl.signal });
    if (res.ok) process.exit(0);
  } catch {
    // Fall through to starting the daemon below when the health probe fails.
  } finally {
    clearTimeout(timer);
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
  } catch {
    // A hook must never break the session it observes.
  }
}
process.exit(0);