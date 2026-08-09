import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
}

export function composeInstructions(input: ComposeInput): string {
  const parts: string[] = [];

  parts.push(`# Role: ${input.role}`, '', input.roleText.trim(), '');

  if (input.repoContext.trim().length > 0) {
    parts.push('## Repository context', '', input.repoContext.trim(), '');
  }

  parts.push('## Task', '', input.task.trim(), '');

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

  return parts.join('\n');
}
