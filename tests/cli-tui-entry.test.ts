import { describe, it, expect } from 'vitest';
import { shouldLaunchTui } from '../src/tui-ink/launch.js';

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
