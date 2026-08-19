import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planCode } from '../../src/commands/code.js';

let cwd: string;
let home: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sonata-code-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'sonata-code-home-'));
});

describe('planCode', () => {
  it('sets the router URL and minimum native context window', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.models."large"]
gateway = "g"
id = "large-model"
context_window = 128000
[native.models."small"]
gateway = "g"
id = "small-model"
context_window = 32000
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    const plan = planCode({ cwd, home, passthrough: ['--model', 'sonnet'] });
    expect(plan.env.ANTHROPIC_BASE_URL).toBe('http://localhost:4100');
    expect(plan.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32000');
  });

  it('omits the context variable when no native models exist', () => {
    writeFileSync(join(cwd, 'sonata.toml'), `
[native.gateways."g"]
base_url = "http://gateway.example/v1"
`);

    expect(planCode({ cwd, home, passthrough: [] }).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('includes passthrough args and explains the Remote Control limitation', () => {
    writeFileSync(join(cwd, 'sonata.toml'), '[native]\n');
    const plan = planCode({ cwd, home, passthrough: ['--verbose', '--model', 'sonnet'] });

    expect(plan.argv).toEqual(['claude', '--verbose', '--model', 'sonnet']);
    expect(plan.banner).toMatch(/Remote Control unavailable/i);
  });
});
