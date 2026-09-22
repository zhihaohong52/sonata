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

  it('opens the shell for the commands that are screens in it', () => {
    // Deep links into one app rather than separate apps: `status` opens it on
    // the status screen, `agents` on tiers.
    expect(shouldLaunchTui('status', true, true)).toBe(true);
    expect(shouldLaunchTui('agents', true, true)).toBe(true);
  });

  it('keeps those same commands printing when either stream is not a TTY', () => {
    // The contract, not a courtesy: `sonata status` is read by scripts, and
    // both run inside SessionStart hooks where nothing can answer a screen.
    for (const command of ['status', 'agents']) {
      expect(shouldLaunchTui(command, false, true)).toBe(false);
      expect(shouldLaunchTui(command, true, false)).toBe(false);
    }
  });

  it('never launches for another command, doctor included', () => {
    // `doctor` is deliberately excluded even though the overview renders its
    // checks: its whole output IS the list, it is what a broken machine runs,
    // and it is quoted in error messages a non-TTY reader must be able to
    // follow.
    for (const command of ['doctor', 'serve', '--help', '-h', '--version']) {
      expect(shouldLaunchTui(command, true, true)).toBe(false);
    }
  });

  describe('init', () => {
    // `init` used to be in the list above. It moved deliberately: the wizard
    // now runs *inside* the shell rather than mounting its own Ink app, so a
    // bare `sonata init` on a terminal is a deep link like `status` is. What
    // has not changed is the scripted path, and that is what these tests pin.

    it('opens the shell for a bare interactive init', () => {
      expect(shouldLaunchTui('init', true, true, [])).toBe(true);
    });

    it('stays scripted whenever argv tells it what to do', () => {
      // Not just `--yes`: `--providers` without it is still a caller
      // supplying the answers, and opening a screen to ask questions that
      // have already been answered would hang a script on a prompt.
      for (const flag of [['--yes'], ['-y'], ['--providers', 'codex/openai'], ['--models', 'a'],
        ['--roles', 'code'], ['--config-scope', 'global'], ['--scope', 'project'],
        ['--routing', 'skip'], ['--guidance', 'skip'], ['--prune']]) {
        expect(shouldLaunchTui('init', true, true, flag)).toBe(false);
      }
    });

    it('treats --flag=value the same as --flag value', () => {
      expect(shouldLaunchTui('init', true, true, ['--config-scope=global'])).toBe(false);
    });

    it('still opens the shell for a flag that needs a wizard to mean anything', () => {
      // `--repropose-tiers` re-seeds the ranking screens. Matching "any flag"
      // rather than naming the scripting ones would send it down the scripted
      // path, where it silently re-ranks with nobody watching.
      expect(shouldLaunchTui('init', true, true, ['--repropose-tiers'])).toBe(true);
    });

    it('never opens it without a terminal, flags or not', () => {
      expect(shouldLaunchTui('init', false, true, [])).toBe(false);
      expect(shouldLaunchTui('init', true, false, [])).toBe(false);
    });
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
