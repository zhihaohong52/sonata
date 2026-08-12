import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disabledOpencodeAgents, enableOpencodeAgent } from '../src/detect.js';

let home: string;
const cfg = () => join(home, '.config', 'opencode', 'opencode.json');
const write = (o: unknown) => {
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(cfg(), JSON.stringify(o, null, 2));
};

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'oc-agents-')); });

describe('disabledOpencodeAgents', () => {
  it('names an agent the user has disabled', () => {
    write({ agent: { explore: { disable: true }, general: { disable: true } } });
    expect(disabledOpencodeAgents(home).sort()).toEqual(['explore', 'general']);
  });

  it('ignores agents that are present and enabled', () => {
    write({ agent: { explore: { disable: false }, build: {} } });
    expect(disabledOpencodeAgents(home)).toEqual([]);
  });

  it('is empty when there is no opencode config or no agent block', () => {
    expect(disabledOpencodeAgents(home)).toEqual([]);
    write({ model: 'x' });
    expect(disabledOpencodeAgents(home)).toEqual([]);
  });

  it('does not throw on an unreadable config', () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(cfg(), 'not json {{{');
    expect(disabledOpencodeAgents(home)).toEqual([]);
  });
});

describe('enableOpencodeAgent', () => {
  it('flips disable to false and reports the change', () => {
    write({ agent: { explore: { disable: true } } });
    expect(enableOpencodeAgent(home, 'explore')).toBe(true);
    expect(JSON.parse(readFileSync(cfg(), 'utf8')).agent.explore.disable).toBe(false);
  });

  it('leaves every other key untouched', () => {
    // This is the user's opencode config, not sonata's. Touch one field.
    write({ model: 'x', agent: { explore: { disable: true }, general: { disable: true } },
            provider: { openrouter: { models: {} } } });
    enableOpencodeAgent(home, 'explore');
    const back = JSON.parse(readFileSync(cfg(), 'utf8'));
    expect(back.model).toBe('x');
    expect(back.provider.openrouter).toBeDefined();
    expect(back.agent.general.disable).toBe(true);
  });

  it('reports no change when it is already enabled', () => {
    write({ agent: { explore: { disable: false } } });
    expect(enableOpencodeAgent(home, 'explore')).toBe(false);
  });

  it('does not create a config that was not there', () => {
    expect(enableOpencodeAgent(home, 'explore')).toBe(false);
    expect(existsSync(cfg())).toBe(false);
  });
});
