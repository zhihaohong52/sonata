import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { main, COMMANDS, suggestCommand } from '../src/cli.js';

describe('unknown command', () => {
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  afterEach(() => { errors.length = 0; spy.mockClear(); });

  it('suggests the nearest command and still exits 2', async () => {
    expect(await main(['docotr'])).toBe(2);
    expect(errors.join('\n')).toBe(
      '✘ unknown command "docotr"\n  └ Did you mean sonata doctor?\n\nRun sonata --help to list commands.',
    );
  });

  it('prints no suggestion when nothing is close', async () => {
    expect(await main(['zzzz'])).toBe(2);
    expect(errors.join('\n')).not.toContain('Did you mean');
  });

  it.each([
    ['docotr', 'doctor'], ['stat', 'status'], ['statsu', 'status'], ['usgae', 'usage'],
    ['DOCTOR', 'doctor'], ['rout', 'route'], ['dispach', 'dispatch'],
  ])('%s → %s', (input, expected) => {
    expect(suggestCommand(input)).toBe(expected);
  });

  it.each(['zzzz', 'xy', 'q', '', 'foobar'])('%j → nothing', (input) => {
    expect(suggestCommand(input)).toBeUndefined();
  });

  // The list is hand-kept beside an if-chain; this fails when a branch is added without it.
  it('COMMANDS covers every command main dispatches', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const dispatched = new Set([...src.matchAll(/command === '([a-z][a-z-]*)'/g)].map((m) => m[1]!));
    expect([...dispatched].filter((c) => !(COMMANDS as readonly string[]).includes(c))).toEqual([]);
  });
});
