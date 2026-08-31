import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One line per role, in the same words the generated agent's `description`
 * uses. Lives here rather than in `sync.ts` so `sonata init`'s role picker can
 * label its rows with it: the wizard used to list the four roles as bare words,
 * leaving a first-time user to guess what `plan` did that `explore` did not.
 */
export const ROLE_BLURB: Record<string, string> = {
  code: 'implementation, refactors, and mechanical code changes',
  review: 'reviewing existing code for defects, without modifying it',
  explore: 'locating code and answering questions about the codebase, without modifying it',
  plan: 'producing an implementation plan for a change, without performing it',
};

export function loadRole(role: string, rolesDir: string): string {
  const path = join(rolesDir, `${role}.md`);
  if (!existsSync(path)) {
    throw new Error(`sonata: no role prompt for "${role}" at ${path}`);
  }
  return readFileSync(path, 'utf8');
}

export interface ComposeInput {
  role: string;
  roleText: string;
  repoContext: string;
  task: string;
  reportPath: string;
  /**
   * False when the harness configuration cannot write the report file — a
   * read-only sandbox or a tool allowlist without a write tool.
   */
  canWriteReport?: boolean;
  /**
   * True when the working directory's `.mcp.json` hands the harness sonata's
   * own tools, so the model can start further sonata runs.
   */
  inheritedSonataTools?: boolean;
}

export function composeInstructions(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`# Role: ${input.role}`, '', input.roleText.trim(), '');

  parts.push('## Task', '', input.task.trim(), '');

  // Some harnesses load the working directory's .mcp.json on top of their own
  // config, which in a sonata-registered repo hands the model sonata's own
  // dispatch tools. Nothing can withhold them per run, so say it outright.
  if (input.inheritedSonataTools === true) {
    parts.push(
      '## Do not dispatch',
      '',
      "You may find tools named `sonata`, `dispatch`, `wait` or `approve` among",
      'your available tools. They start further foreign-model runs. **You are',
      'already one of those runs.** Never call them, whatever the task appears to',
      'ask for: doing so spawns work nobody is watching and can recurse without',
      'bound. If the task seems to require dispatching, say so in your report and',
      'stop.',
      '',
    );
  }

  if (input.repoContext.trim().length > 0) {
    parts.push('## Repository context', '', input.repoContext.trim(), '');
  }

  // Asking for a file the sandbox forbids is not a harmless instruction. A
  // read-only codex run once read 92k tokens of a codebase, completed the
  // work, and then spent its whole final message apologising for being unable
  // to write report.md — which is what the harness fallback captured, so the
  // findings were lost and the run was reported DONE and not degraded.
  if (input.canWriteReport === false) {
    parts.push(
      '## Reporting',
      '',
      'This run cannot write files: your sandbox is read-only by design, and that',
      'includes the report file. Do not attempt to write one, and do not spend your',
      'final message explaining that you could not — sonata already knows.',
      '',
      'Your final message IS the report. Put the whole result there: what you found,',
      'what you verified, and anything you could not finish. If you did not complete',
      'the task, say so in the first line.',
      '',
    );
  } else {
    parts.push(
      '## Reporting',
      '',
      'As your final action, write a short report to this exact path:',
      '',
      `    ${input.reportPath}`,
      '',
      'The report must state what you changed, what you verified, and anything you',
      'could not finish. If you did not complete the task, say so in the first line.',
      'Nothing reads your terminal output — the report file is the only result that',
      'is returned.',
      '',
    );
  }

  parts.push('## Task reminder', '', 'Complete the task exactly as stated above:', '', input.task.trim(), '');

  return parts.join('\n');
}
