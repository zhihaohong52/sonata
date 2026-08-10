import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from './types.js';

const VALID: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

/**
 * Claude Code modes that sonata does not model directly, mapped to the closest
 * mode it can actually enforce on a foreign harness.
 *
 * `auto` is Claude Code's current default: it runs tool calls its classifier
 * judges lower-risk without prompting, and blocks the rest. Sonata cannot
 * reproduce that classifier in another harness, so the honest equivalent is
 * `acceptEdits` — work proceeds without prompting the user, which is what the
 * parent session is doing too.
 *
 * Treating it as `default` instead — which is what an unrecognised value used
 * to do — is wrong in both directions: it claims the parent prompts for every
 * action when it does not, and since opencode cannot honour `default` at all,
 * it silently made every opencode dispatch refuse.
 *
 * The residual gap is real and worth stating: the foreign harness has no
 * classifier, so it will run things auto mode would have blocked. Dispatch in
 * `plan` for a read-only run when that matters.
 */
const ALIASES: Record<string, PermissionMode> = {
  auto: 'acceptEdits',
};

/**
 * Claude Code does not expose the permission mode as an environment variable.
 * A PreToolUse hook writes it to .sonata/session-<id>.json; this reads it back.
 * Falls back to the safest mode when unknown.
 */
export function readPermissionMode(cwd: string, sessionId: string | undefined): PermissionMode {
  if (!sessionId) return 'default';
  const path = join(cwd, '.sonata', `session-${sessionId}.json`);
  if (!existsSync(path)) return 'default';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { permissionMode?: string };
    const raw = parsed.permissionMode;
    if (!raw) return 'default';
    if (ALIASES[raw]) return ALIASES[raw];
    return VALID.includes(raw as PermissionMode) ? (raw as PermissionMode) : 'default';
  } catch {
    return 'default';
  }
}
