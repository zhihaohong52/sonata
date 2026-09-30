import { describe, it, expect } from 'vitest';
import { parseConfig, expectedAgentNames, autoAgentRoles } from '../../src/config.js';
import { plannedAgents } from '../../src/commands/sync.js';
import { agentRows, renderAgents } from '../../src/commands/agents.js';
import { SONATA_AGENT_MATCHER } from '../../src/commands/route.js';

const CONFIG = (auto: boolean) => parseConfig(`
${auto ? '[auto_route]\nclassifier = "jev"\n' : ''}
[models."a"]
gateway = "g"
id = "a-1"

[models."b"]
gateway = "g"
id = "b-1"

[native.gateways."g"]
base_url = "https://g.example/v1"

[tiers.code]
simple = ["a"]
normal = ["a", "b"]
complex = ["b"]

[tiers.explore]
simple = ["a"]
complex = ["a"]
`);

describe('<role>-auto agents', () => {
  it('exist only when [auto_route] is set, and not for collapsed roles', () => {
    expect(autoAgentRoles(CONFIG(false))).toEqual([]);
    expect(autoAgentRoles(CONFIG(true))).toEqual(['code']);
    expect(expectedAgentNames(CONFIG(true))).toContain('code-auto');
    expect(expectedAgentNames(CONFIG(true))).not.toContain('explore-auto');
  });

  it('are generated with the auto alias', () => {
    const agent = plannedAgents(CONFIG(true)).find((a) => a.name === 'code-auto');
    expect(agent?.content).toMatch(/^model: sonata-code-auto$/m);
    expect(agent?.content).toMatch(/chooses the tier/);
    expect(agent?.content).toMatch(/no `model` argument/i);
    expect(plannedAgents(CONFIG(false)).some((a) => a.name.endsWith('-auto'))).toBe(false);
  });

  it('appear in sonata agents, marked auto-routed', () => {
    const rows = agentRows(CONFIG(true));
    expect(rows.find((r) => r.agent === 'code-auto')).toMatchObject({ auto: true, role: 'code' });
    expect(renderAgents(rows).join('\n')).toMatch(/code-auto[\s\S]*auto-routed/);
  });

  it('reports the same extended context as the generated auto alias', () => {
    const config = CONFIG(true);
    config.unifiedModels.a.contextWindow = 1_000_000;
    config.unifiedModels.b.contextWindow = 1_000_000;
    expect(agentRows(config).find((r) => r.agent === 'code-auto')?.extendedContext).toBe(true);
    expect(plannedAgents(config).find((a) => a.name === 'code-auto')?.content).toMatch(/^model: sonata-code-auto\[1m\]$/m);
    config.unifiedModels.b.contextWindow = 128_000;
    expect(agentRows(config).find((r) => r.agent === 'code-auto')?.extendedContext).toBe(false);
    expect(plannedAgents(config).find((a) => a.name === 'code-auto')?.content).toMatch(/^model: sonata-code-auto$/m);
  });

  it('are matched by the routing hook matcher', () => {
    expect(new RegExp(SONATA_AGENT_MATCHER).test('code-auto')).toBe(true);
  });
});
