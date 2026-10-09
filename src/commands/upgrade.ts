/**
 * `sonata upgrade` — install the latest published release over this one.
 *
 * A development install is refused rather than upgraded. `npm link` makes the
 * global `sonata` a symlink into a clone, and `npm install -g` would replace
 * that link with the published package — so the clone silently stops being
 * what runs, which is the `dist/` vs `src/` confusion this repo has already
 * paid for twice. Such an install is told how to update itself instead.
 */
import { cmp, triple } from './doctor.js';

export interface UpgradeDeps {
  /** The running manifest's name and version. */
  name: string;
  installed: string;
  /** Set when a build stamp says this is a local build: where it runs from. */
  devRoot?: string;
  /** npm's `latest` for `name`, or undefined when the registry cannot be reached. */
  latestVersion(npmPackage: string): Promise<string | undefined>;
  /** Run the installer with its output on the terminal; true when it exited 0. */
  run(command: string[]): Promise<boolean>;
  out(line: string): void;
}

export async function cmdUpgrade(deps: UpgradeDeps): Promise<number> {
  if (deps.devRoot !== undefined) {
    deps.out(`sonata ${deps.installed} is a development install (${deps.devRoot}).`);
    deps.out('Update it from the clone: git pull && npm run build');
    return 1;
  }
  const latest = await deps.latestVersion(deps.name);
  if (latest === undefined) {
    deps.out(`Could not read the latest ${deps.name} release from the npm registry.`);
    return 1;
  }
  // `triple` reads anything else as 0.0.0, which would report "latest".
  if (!/^v?\d+\.\d+\.\d+/.test(latest)) {
    deps.out(`The npm registry returned an unusable version for ${deps.name}: ${latest}`);
    return 1;
  }
  if (cmp(triple(latest), triple(deps.installed)) <= 0) {
    deps.out(`sonata ${deps.installed} is the latest release.`);
    return 0;
  }
  const command = ['npm', 'install', '-g', `${deps.name}@${latest}`];
  deps.out(`Upgrading sonata ${deps.installed} → ${latest}: ${command.join(' ')}`);
  if (!(await deps.run(command))) {
    deps.out(`The upgrade failed; sonata ${deps.installed} is still installed.`);
    return 1;
  }
  // The router is a long-lived process still running the old code.
  deps.out(`Upgraded to ${latest}. Run \`sonata restart\` so a running router picks it up.`);
  return 0;
}
