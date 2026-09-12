import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { apply } from '../../src/init/apply.js';
import type { InitPlan } from '../../src/init/plan.js';
import { applyReset, cmdReset, describeReset, planReset, planSettingsReset } from '../../src/commands/reset.js';
import { guidanceBlock, GUIDANCE_BEGIN, mergeGuidance } from '../../src/init/guidance.js';
import { readSettings } from '../../src/settings.js';
import { TIER_AGENT_MARKER } from '../../src/agent-markers.js';

let home: string;
let cwd: string;
const packageRoot = resolve('.');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonata-reset-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'sonata-reset-cwd-'));
});

const planFor = (): InitPlan => ({
  configScope: 'project',
  configPath: join(cwd, 'sonata.toml'),
  configToml: [
    '[models."acme-fast"]', 'gateway = "acme"', 'id = "fast"', '',
    '[native.gateways."acme"]', 'base_url = "https://acme.example/v1"', '',
    '[tiers.code]', 'simple = ["acme-fast"]', 'complex = ["acme-fast"]', '',
  ].join('\n'),
  keysToStore: [],
  hook: { scope: 'project', allowListScope: 'project' },
  skillPath: join(cwd, '.claude', 'skills', 'sonata-loop', 'SKILL.md'),
  guidance: { scope: 'project', path: join(cwd, 'CLAUDE.md') },
  routing: 'skip',
  syncCwd: cwd,
  agentsDir: join(cwd, '.claude', 'agents'),
  chosenNative: [], roles: ['code'], nativeKeys: ['acme-fast'],
  installLitellm: false,
  notices: [], summary: [],
});

describe('planReset', () => {
  it('finds nothing in a directory sonata never touched', () => {
    const plan = planReset({ cwd, home, packageRoot });
    expect(plan.actions).toEqual([]);
    expect(describeReset(plan).join('\n')).toContain('nothing to remove');
  });

  it('names the config, the agents, the skill and the CLAUDE.md block after an init', async () => {
    await apply(planFor(), { cwd, home, packageRoot }, { out: () => {}, prune: false });
    const labels = planReset({ cwd, home, packageRoot }).actions.map((a) => a.label);
    expect(labels.join(' ')).toContain('config');
    expect(labels.join(' ')).toContain('generated agent');
    expect(labels.join(' ')).toContain('sonata-loop skill');
    expect(labels.join(' ')).toContain('CLAUDE.md');
  });

  // The kept list is printed for a reason: a command called "reset" that says
  // nothing about keys and spend history reads as having destroyed both.
  it('names what it keeps, so silence cannot be read as loss', () => {
    const text = describeReset(planReset({ cwd, home, packageRoot })).join('\n')
      + describeReset({ ...planReset({ cwd, home, packageRoot }), actions: [{ kind: 'delete-file', label: 'config', path: 'x' }] }).join('\n');
    expect(text).toContain('keys');
    expect(text).toContain('ledger');
  });
});

describe('applyReset', () => {
  it('removes everything init wrote at this scope', async () => {
    const p = planFor();
    await apply(p, { cwd, home, packageRoot }, { out: () => {}, prune: false });
    expect(existsSync(p.configPath)).toBe(true);

    applyReset(planReset({ cwd, home, packageRoot }));

    expect(existsSync(p.configPath)).toBe(false);
    expect(existsSync(p.skillPath)).toBe(false);
    expect(existsSync(join(p.agentsDir, 'code.md'))).toBe(false);
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).not.toContain(GUIDANCE_BEGIN);
    const settings = readSettings(join(cwd, '.claude', 'settings.json'));
    expect(JSON.stringify(settings)).not.toContain('capture-mode.mjs');
    expect(JSON.stringify(settings)).not.toContain('sonata dispatch');
  });

  // The whole discipline of this command: it owns what it wrote and nothing
  // else. An agent someone hand-wrote has no sonata marker and must survive.
  it('leaves an agent file sonata did not generate alone', async () => {
    const p = planFor();
    await apply(p, { cwd, home, packageRoot }, { out: () => {}, prune: false });
    const mine = join(p.agentsDir, 'mine.md');
    writeFileSync(mine, '---\nname: mine\n---\n\nMy own agent.\n');

    applyReset(planReset({ cwd, home, packageRoot }));
    expect(existsSync(mine)).toBe(true);
  });

  it('leaves the text either side of the CLAUDE.md markers byte-identical', () => {
    const original = '# My project\n\nInstructions I wrote.\n';
    writeFileSync(join(cwd, 'CLAUDE.md'), mergeGuidance(original, guidanceBlock()));
    applyReset(planReset({ cwd, home, packageRoot }));
    expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe(original);
  });

  it('is idempotent — a second reset finds nothing left', async () => {
    await apply(planFor(), { cwd, home, packageRoot }, { out: () => {}, prune: false });
    applyReset(planReset({ cwd, home, packageRoot }));
    expect(planReset({ cwd, home, packageRoot }).actions).toEqual([]);
  });

  it('does not touch the machine config when resetting the project', async () => {
    const globalConfig = join(home, '.config', 'sonata', 'sonata.toml');
    mkdirSync(join(home, '.config', 'sonata'), { recursive: true });
    writeFileSync(globalConfig, '# machine config\n');
    await apply(planFor(), { cwd, home, packageRoot }, { out: () => {}, prune: false });

    applyReset(planReset({ cwd, home, packageRoot }));
    expect(existsSync(globalConfig)).toBe(true);
  });
});

describe('planSettingsReset', () => {
  it('keeps allow entries and hooks that are not sonata\'s', () => {
    const settings = {
      permissions: { allow: ['Bash(sonata dispatch:*)', 'Bash(git status:*)'] },
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'node "/somewhere/hooks/capture-mode.mjs"' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /mine/hello.mjs' }] }],
      },
    } as const;
    const out = planSettingsReset(settings as never, packageRoot, 'project');
    expect(out.changed).toBe(true);
    expect(out.settings.permissions?.allow).toEqual(['Bash(git status:*)']);
    expect(JSON.stringify(out.settings)).not.toContain('capture-mode.mjs');
    expect(JSON.stringify(out.settings)).toContain('/mine/hello.mjs');
  });

  // A hook installed from a different checkout carries a different absolute
  // path. Matching on this install's own path would leave it behind — by the
  // one command whose job is removing it.
  it('removes a hook installed by a different sonata checkout', () => {
    const settings = {
      hooks: {
        SubagentStart: [{ matcher: '^x', hooks: [{ type: 'command', command: 'node "/other/install/hooks/route-subagent.mjs" start' }] }],
      },
    };
    const out = planSettingsReset(settings as never, packageRoot, 'project');
    expect(out.changed).toBe(true);
    expect(out.settings.hooks?.SubagentStart).toBeUndefined();
  });

  // `planRouteOff` refuses a base URL it did not write. That refusal is about
  // one key; taking the hooks and the allow-list down with it would be a
  // second failure caused by the first.
  it('reports a refused routing env without abandoning the rest of the file', () => {
    const settings = {
      env: { ANTHROPIC_BASE_URL: 'https://not-sonata.example' },
      permissions: { allow: ['Bash(sonata wait:*)'] },
    };
    const out = planSettingsReset(settings as never, packageRoot, 'project');
    expect(out.warnings.join(' ')).toMatch(/ANTHROPIC_BASE_URL/);
    expect(out.changed).toBe(true);
    expect(out.settings.permissions).toBeUndefined();
    expect((out.settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('https://not-sonata.example');
  });
});

describe('reset reports what it could not do', () => {
  // The worst shape a cleanup can fail in: silent, and indistinguishable from
  // having had nothing to do. A scan that flattened every error to `[]` built
  // a plan with no agents in it, and the command reported success having left
  // every agent installed.
  it('warns rather than reporting an empty plan when the agents directory cannot be read', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'code.md'), `x\n${TIER_AGENT_MARKER}\n`);
    chmodSync(agentsDir, 0o000);
    try {
      const plan = planReset({ cwd, home, packageRoot });
      expect(plan.actions.some((a) => a.kind === 'delete-agents')).toBe(false);
      expect(plan.warnings.join(' ')).toMatch(/could not read/);
    } finally {
      chmodSync(agentsDir, 0o755);
    }
  });

  it('exits non-zero and names the path when a removal fails', async () => {
    const lines: string[] = [];
    const skillDir = join(cwd, '.claude', 'skills', 'sonata-loop');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'x');
    writeFileSync(join(cwd, 'sonata.toml'), 'schema_version = 1\n');
    // Make the config undeletable by sealing its parent directory.
    chmodSync(cwd, 0o500);
    try {
      const code = await cmdReset({ cwd, home, packageRoot, yes: true }, {
        out: (l) => lines.push(l),
        confirm: async () => true,
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/could not be removed/);
    } finally {
      chmodSync(cwd, 0o755);
    }
  });
});

describe('describeReset', () => {
  // Elsewhere a "… and N more" is a courtesy. Here the list *is* what is being
  // agreed to, and a confirmation that hides paths it then deletes is not one.
  it('names every agent file, never a truncated sample', () => {
    const agentsDir = join(cwd, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const n of names) writeFileSync(join(agentsDir, `${n}.md`), `x\n${TIER_AGENT_MARKER}\n`);

    const text = describeReset(planReset({ cwd, home, packageRoot })).join('\n');
    for (const n of names) expect(text).toContain(join(agentsDir, `${n}.md`));
    expect(text).not.toContain('more');
  });

  // `writeSettings` copies the file aside before writing, so the reset touches
  // a second path and would overwrite a backup already sitting there.
  it('names the settings backup it will overwrite', () => {
    const settings = join(cwd, '.claude', 'settings.json');
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(sonata dispatch:*)'] } }));

    const text = describeReset(planReset({ cwd, home, packageRoot })).join('\n');
    expect(text).toContain(`${settings}.bak`);
  });
});
