import { configPath, loadConfig, type SonataConfig } from '../../config.js';

/**
 * A config load that a screen can render either way.
 *
 * A result rather than a throw, because these are consumed inside an Ink
 * render where a throw has no boundary to land on and takes the process with
 * it.
 */
export type ScreenConfig =
  | { ok: true; config: SonataConfig }
  | { ok: false; message: string };

/**
 * Load the config for a screen, reporting failure instead of throwing.
 *
 * Every screen used to guard on `configPath` alone and then call `loadConfig`
 * during render. `configPath` proves a file **exists**; it says nothing about
 * whether it loads, and `loadConfig` throws on any parse or validation
 * failure. With no error boundary in an Ink render, that killed the TUI.
 * Measured against the built binary: a config naming a model no `[models]`
 * entry defines made the overview's `p` key print `PROCESS DIED`.
 *
 * It was worst exactly where it mattered most — doctor's overview had just
 * reported the bad config as a warning row, and then every screen key killed
 * the app rather than letting anyone read or fix it.
 *
 * The underlying message is preserved verbatim rather than replaced with
 * something generic: it names the file and the exact problem
 * (`sonata.toml: tiers.code.simple references unknown model "nope". Define
 * [models."nope"] first.`), which is the whole value of surfacing it. A
 * non-`Error` throw is stringified so this can never throw on its own.
 *
 * One shared loader rather than a try/catch per screen, because three copies
 * are three chances to forget one — the drift this repository has already paid
 * for with `tiersCollapse`.
 */
export function loadConfigForScreen(cwd: string, home: string): ScreenConfig {
  if (configPath(cwd, home) === null) {
    return { ok: false, message: 'no sonata.toml — run `sonata init` first' };
  }
  try {
    return { ok: true, config: loadConfig(cwd, home) };
  } catch (error: unknown) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
