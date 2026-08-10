import type { HarnessAdapter } from './types.js';
import { openCodeAdapter } from './opencode.js';
import { codexAdapter } from './codex.js';

const ADAPTERS: Record<string, HarnessAdapter> = {
  opencode: openCodeAdapter,
  codex: codexAdapter,
};

export function getAdapter(name: string): HarnessAdapter {
  const a = ADAPTERS[name];
  if (!a) {
    throw new Error(
      `sonata: unknown harness "${name}". Known: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return a;
}

export { openCodeAdapter, codexAdapter };
export type { HarnessAdapter, PlanInput, LaunchPlan } from './types.js';
