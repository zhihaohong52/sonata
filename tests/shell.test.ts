import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { shellQuote } from '../src/shell.js';

/**
 * The contract is a round trip: what goes in is what the shell sees, and
 * nothing else happens. `bash -c 'printf %s ' + shellQuote(s)` must print `s`
 * back byte-for-byte — if any of these inputs execute, split into words, or
 * lose a character, a run directory named with them takes the launch with it.
 */
const ROUND_TRIP: Array<[string, string]> = [
  ['a single quote', "it's"],
  ['command substitution', '$(id)'],
  ['backticks', '`id`'],
  ['history expansion', 'up!x'],
  ['spaces', '/tmp/a path/file'],
  ['a newline', 'line1\nline2'],
  ['an empty string', ''],
  ['a hostile run directory', "/tmp/it's $(echo pwned) !x"],
  ['a double quote', 'say "hi"'],
  ['a dollar and a brace', '${HOME}/x'],
  ['a semicolon and an ampersand', 'a; b && c | d'],
];

describe('shellQuote round-trips through bash', () => {
  for (const [name, input] of ROUND_TRIP) {
    it(name, () => {
      const out = execFileSync('bash', ['-c', 'printf %s ' + shellQuote(input)], {
        encoding: 'utf8',
      });
      expect(out).toBe(input);
    });
  }

  it('leaves a command substitution unexecuted', () => {
    // The round trip proves it above; this names the failure explicitly, since
    // this is the input that turns a bad path into code execution.
    const out = execFileSync('bash', ['-c', 'printf %s ' + shellQuote('$(echo PWNED)')], {
      encoding: 'utf8',
    });
    expect(out).toBe('$(echo PWNED)');
    expect(out).not.toContain('PWNED\n');
  });

  it('splits a single quote as end-quote, escaped quote, reopen', () => {
    // The exact form the adapters' private copies emit (`src/adapters/pi.ts`),
    // asserted so this shared definition cannot drift from them.
    expect(shellQuote('abc')).toBe("'abc'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });
});
