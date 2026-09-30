/**
 * Harness update check for `sonata init`, run before any model is listed.
 *
 * A harness's model catalogue can be version-gated. Reported 2026-09-30:
 * `gpt-6.1-sol` was out, and sonata did not offer it, because codex's
 * `model/list` is answered for the client version asking — codex 0.156.1 got
 * seven models, 0.159.2 got eight. Nothing in sonata was wrong, and nothing
 * said why. So init now compares each installed harness with its latest npm
 * release and, interactively, offers to run the harness's own updater before
 * detection lists models.
 *
 * Three rules keep this from getting in the way:
 * - **Unknown is never a prompt.** Not installed, a registry lookup that fails
 *   or times out, a version that will not parse: that harness is skipped, and
 *   init goes on offline exactly as before.
 * - **Unattended never updates.** A `--yes` or non-TTY run prints the command
 *   and leaves the toolchain alone — a scripted init changing what is
 *   installed is not something its author asked for.
 * - **A failed update is a warning.** Init continues on the version that is
 *   still there.
 */
import { spawn } from 'node:child_process';
import { getAdapter } from '../adapters/index.js';
import { checkVersion, cmp, triple } from '../commands/doctor.js';
import { probeVersion } from '../detect.js';

/** The harnesses `detectHarnesses` probes — claude is the host, not offered. */
export const UPDATABLE_HARNESSES = ['opencode', 'pi', 'codex', 'reasonix'] as const;

/** How long a registry lookup may take before that harness is treated as unknown. */
export const REGISTRY_TIMEOUT_MS = 5_000;

/** How long a harness's own updater may run before it is killed. */
export const UPDATE_TIMEOUT_MS = 5 * 60_000;

export interface HarnessUpdate {
  harness: string;
  installed: string;
  latest: string;
  command: string[];
  /** The adapter's tested range, when `latest` falls outside it. */
  outsideTested: string | undefined;
}

/** Everything that touches the machine or the network, so tests need neither. */
export interface UpdateDeps {
  /** The installed version string, or undefined when missing or broken. */
  installedVersion(harness: string): Promise<string | undefined>;
  /** npm's `latest` for a package, or undefined when it cannot be learned. */
  latestVersion(npmPackage: string): Promise<string | undefined>;
  /** Run an updater, forwarding its output; true when it exited 0. */
  run(command: string[], out: (line: string) => void): Promise<boolean>;
}

/** A clean `x.y.z`, or undefined when the string carries none. */
function cleanVersion(v: string | undefined): string | undefined {
  return v === undefined ? undefined : /(\d+\.\d+\.\d+)/.exec(v)?.[1];
}

/** Every installed harness whose latest npm release is newer than what is installed. */
export async function findHarnessUpdates(deps: UpdateDeps): Promise<HarnessUpdate[]> {
  const found = await Promise.all(UPDATABLE_HARNESSES.map(async (harness) => {
    const adapter = getAdapter(harness);
    if (adapter.update === undefined) return undefined;
    const [installedRaw, latestRaw] = await Promise.all([
      deps.installedVersion(harness).catch(() => undefined),
      deps.latestVersion(adapter.update.npmPackage).catch(() => undefined),
    ]);
    const installed = cleanVersion(installedRaw);
    const latest = cleanVersion(latestRaw);
    if (installed === undefined || latest === undefined) return undefined;
    if (cmp(triple(latest), triple(installed)) <= 0) return undefined;
    const update: HarnessUpdate = {
      harness,
      installed,
      latest,
      command: adapter.update.command,
      outsideTested: checkVersion(latest, adapter.supportedVersions) ? undefined : adapter.supportedVersions,
    };
    return update;
  }));
  return found.filter((u): u is HarnessUpdate => u !== undefined);
}

/**
 * Offer each outdated harness's update, one Yes/No at a time, then return so
 * detection can list models from whatever is now installed.
 */
export async function offerHarnessUpdates(opts: {
  interactive: boolean;
  ask: (question: string, initial: boolean) => Promise<boolean>;
  out: (line: string) => void;
  deps: UpdateDeps;
}): Promise<void> {
  const { interactive, ask, out, deps } = opts;
  const updates = await findHarnessUpdates(deps);
  if (updates.length === 0) return;

  if (!interactive) {
    for (const u of updates) {
      out(`  ! ${u.harness} ${u.installed} → ${u.latest} available — run \`${u.command.join(' ')}\``);
    }
    out('');
    return;
  }

  for (const u of updates) {
    // The prompt draws on the alternate screen, so it carries everything the
    // user needs to decide — the same reason the write confirmation does.
    const lines = [
      `${u.harness} ${u.installed} → ${u.latest} is available.`,
      'Newer versions can serve models this one does not list.',
      ...(u.outsideTested === undefined ? [] : [
        `${u.latest} is outside the range sonata has tested (${u.outsideTested}); its prompt detection may misbehave.`,
      ]),
      '',
      `Update now? (runs \`${u.command.join(' ')}\`)`,
    ];
    if (!(await ask(lines.join('\n'), true))) {
      out(`  · ${u.harness} update skipped (${u.installed})`);
      continue;
    }
    out(`  ↻ updating ${u.harness}: ${u.command.join(' ')}`);
    let ok = false;
    try {
      ok = await deps.run(u.command, (line) => out(`    ${line}`));
    } catch {
      ok = false;
    }
    const now = cleanVersion(await deps.installedVersion(u.harness).catch(() => undefined)) ?? u.installed;
    out(ok
      ? `  ✓ ${u.harness} updated to ${now}`
      : `  ! ${u.harness} update did not complete; continuing with ${now}`);
  }
  out('');
}

/** `$HOME` in an adapter's `pathPrepend`, expanded. */
function harnessPath(harness: string, home: string): string {
  // An unknown name (a test's stub, a future updater named by path) gets the
  // plain PATH rather than a throw.
  let prepend: string[] = [];
  try { prepend = getAdapter(harness).pathPrepend; } catch { /* not a harness */ }
  const extra = prepend.map((p) => p.replace(/^\$HOME/, home));
  return [...extra, process.env.PATH ?? ''].join(':');
}

/** The real machine and registry. */
export function realUpdateDeps(home: string, timeoutMs: number = UPDATE_TIMEOUT_MS): UpdateDeps {
  return {
    async installedVersion(harness) {
      const probe = await probeVersion(harness, { ...process.env, PATH: harnessPath(harness, home) });
      return probe.state === 'ok' ? probe.version : undefined;
    },
    async latestVersion(npmPackage) {
      try {
        const res = await fetch(`https://registry.npmjs.org/${npmPackage}/latest`, {
          signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        });
        if (!res.ok) return undefined;
        const body = await res.json() as { version?: unknown };
        return typeof body.version === 'string' ? body.version : undefined;
      } catch {
        return undefined;
      }
    },
    run(command, out) {
      const [cmd, ...args] = command;
      const harness = cmd;
      return new Promise((resolve) => {
        // stdin is closed: an updater that stops to ask something would
        // otherwise wait forever on a terminal the prompt layer owns.
        const child = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: harnessPath(harness, home) },
        });
        // Settled once, by whichever comes first. The timeout does not wait
        // for `close`: an updater that ignores SIGTERM, or a descendant still
        // holding the pipes, would otherwise never close, and init would hang
        // on what is meant to be at worst a warning.
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        };
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
          finish(false);
        }, timeoutMs);
        const forward = (chunk: Buffer) => {
          for (const line of chunk.toString().split(/\r?\n|\r/)) {
            const text = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
            if (text.trim() !== '') out(text);
          }
        };
        child.stdout?.on('data', forward);
        child.stderr?.on('data', forward);
        child.on('error', () => finish(false));
        child.on('close', (code) => finish(code === 0));
      });
    },
  };
}
