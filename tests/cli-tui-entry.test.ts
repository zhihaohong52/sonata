import { describe, it, expect } from 'vitest';
import { shouldLaunchTui } from '../src/tui-ink/launch.js';
import { main } from '../src/cli.js';

describe('shouldLaunchTui', () => {
  it('launches for a bare command on a TTY', () => {
    expect(shouldLaunchTui(undefined, true, true)).toBe(true);
  });

  it('launches for an explicit `tui` on a TTY', () => {
    // Named so the behaviour is addressable and testable without relying on
    // argv being empty.
    expect(shouldLaunchTui('tui', true, true)).toBe(true);
  });

  it('needs stdin too, not just stdout', () => {
    // Ink's `useInput` puts stdin in raw mode, which throws when stdin is not
    // a TTY. `sonata < /dev/null` from a terminal has a TTY stdout and a piped
    // stdin, so checking stdout alone would crash there instead of printing
    // help.
    expect(shouldLaunchTui(undefined, true, false)).toBe(false);
    expect(shouldLaunchTui('tui', true, false)).toBe(false);
  });

  it('never launches without a TTY', () => {
    // A SessionStart hook and CI both run sonata with stdout piped. Rendering
    // Ink into a pipe is the failure this guard exists to prevent, and bare
    // `sonata` is already called from such places.
    expect(shouldLaunchTui(undefined, false, true)).toBe(false);
    expect(shouldLaunchTui('tui', false, true)).toBe(false);
  });

  it('never launches for another command', () => {
    for (const command of ['doctor', 'init', 'serve', '--help', '-h', '--version']) {
      expect(shouldLaunchTui(command, true, true)).toBe(false);
    }
  });
});

describe('sonata tui without a terminal', () => {
  // `tui` is a documented command in USAGE, but `shouldLaunchTui` refuses it
  // without a TTY on both streams — and it then fell through to the
  // unknown-command handler, so `sonata tui | cat` printed
  // `sonata: unknown command "tui"`. That contradicts the help text this same
  // change added, and points the reader at a typo they did not make.
  const withStreams = async (stdout: boolean, stdin: boolean, argv: string[]) => {
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    const oldOut = process.stdout.isTTY;
    const oldIn = process.stdin.isTTY;
    console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
    console.error = (...a: unknown[]) => { out.push(a.join(' ')); };
    Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
    try {
      const code = await main(argv);
      return { code, text: out.join('\n') };
    } finally {
      console.log = log;
      console.error = err;
      Object.defineProperty(process.stdout, 'isTTY', { value: oldOut, configurable: true });
      Object.defineProperty(process.stdin, 'isTTY', { value: oldIn, configurable: true });
    }
  };

  it('explains that a terminal is required rather than calling it unknown', async () => {
    const { code, text } = await withStreams(false, false, ['tui']);
    expect(text).not.toContain('unknown command');
    expect(text).toMatch(/terminal/i);
    expect(code).toBe(2);
  });

  it('still prints help and exits 2 for a bare invocation', async () => {
    // The pre-existing contract for a bare `sonata`, unchanged by this fix.
    const { code, text } = await withStreams(false, false, []);
    expect(text).toContain('sonata init');
    expect(code).toBe(2);
  });
});
