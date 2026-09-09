import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_CONFIG_RELATIVE, parseConfig } from '../config.js';

export const DEFAULT_PORTS = { router: 4100, litellm: 4000 } as const;

/**
 * The one place router and litellm ports are decided.
 *
 * There is one router per machine, so its ports are the machine config's —
 * never a project's. A project `[native.ports]` still parses (an existing file
 * keeps loading) but is ignored here, and `sonata doctor` says so. Reading the
 * machine file directly rather than through `loadConfig(cwd)` is the point:
 * `loadConfig` prefers `<cwd>/sonata.toml`, which is exactly the file this
 * must not consult.
 */
export function routerPorts(home: string): { router: number; litellm: number } {
  const path = join(home, GLOBAL_CONFIG_RELATIVE);
  if (!existsSync(path)) return { ...DEFAULT_PORTS };
  const config = parseConfig(readFileSync(path, 'utf8'));
  return config.native?.ports ?? { ...DEFAULT_PORTS };
}
