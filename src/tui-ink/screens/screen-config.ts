import { configPath, loadConfig, type SonataConfig } from '../../config.js';

export type ScreenConfig =
  | { ok: true; config: SonataConfig }
  | { ok: false; message: string };

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
