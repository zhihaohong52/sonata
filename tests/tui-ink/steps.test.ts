import { describe, it, expect } from 'vitest';
import { hostKeyAction, afterCheck, nextStep } from '../../src/tui-ink/steps.js';

describe('nextStep', () => {
  it('opens the budget screen from the overview', () => {
    expect(nextStep('overview', 'b')).toBe('budget');
    expect(nextStep('overview', 'm')).toBe('models');
    expect(nextStep('overview', 'p')).toBe('providers');
    expect(nextStep('overview', 't')).toBe('tiers');
    expect(nextStep('overview', 'k')).toBe('keys');
    expect(nextStep('overview', 'a')).toBe('actions');
  });

  it('returns to the overview from a screen', () => {
    expect(nextStep('budget', 'escape')).toBe('overview');
    expect(nextStep('models', 'escape')).toBe('overview');
    expect(nextStep('providers', 'escape')).toBe('overview');
    expect(nextStep('tiers', 'escape')).toBe('overview');
    expect(nextStep('keys', 'escape')).toBe('overview');
    expect(nextStep('actions', 'escape')).toBe('overview');
  });

  it('ignores an unknown key', () => {
    expect(nextStep('overview', 'z')).toBe('overview');
    expect(nextStep('budget', 'z')).toBe('budget');
  });

  it('never leaves the boot step on a keypress', () => {
    // Boot advances when the health check resolves, never because someone
    // pressed a key: a keypress that skipped it would land on an overview
    // with no results to show.
    expect(nextStep('checking', 'b')).toBe('checking');
    expect(nextStep('checking', 'escape')).toBe('checking');
  });
});

describe('afterCheck', () => {
  it('opens the deep link the first time', () => {
    expect(afterCheck('init', false)).toBe('init');
    expect(afterCheck('status', false)).toBe('status');
    expect(afterCheck('tiers', false)).toBe('tiers');
  });

  it('never re-opens it afterwards', () => {
    // The loop this fixes, reported as `sonata init` refusing to exit: `init`
    // finishes by routing back to `checking` so doctor re-runs against the
    // machine it just changed, `checking` read `start` again, and the app
    // bounced into Setup and re-probed every harness. Forever.
    expect(afterCheck('init', true)).toBe('overview');
    expect(afterCheck('status', true)).toBe('overview');
  });

  it('lands on the overview when there is no deep link', () => {
    expect(afterCheck(undefined, false)).toBe('overview');
    expect(afterCheck(undefined, true)).toBe('overview');
  });

  it('refuses `checking` as a deep link', () => {
    // A simpler loop of the same kind: the check completes and routes
    // straight back into itself.
    expect(afterCheck('checking', false)).toBe('overview');
  });
});

describe('hostKeyAction', () => {
  it('leaves Esc to the Tiers editor, so it cannot jump two levels', () => {
    // One Esc on the ranking board used to be read by BOTH the board ("cancel
    // this list") and the shell ("go home"), unmounting the editor and
    // discarding every unsaved edit to every list.
    expect(hostKeyAction('tiers', '', true)).toBe('none');
    expect(hostKeyAction('tiers', 'q', false)).toBe('none');
  });

  it('leaves every key to Setup', () => {
    expect(hostKeyAction('init', '', true)).toBe('none');
    expect(hostKeyAction('init', 'q', false)).toBe('none');
  });

  it('quits on q from a screen that does not own its keys', () => {
    // `sonata status` could not be closed with q.
    for (const step of ['status', 'models', 'providers', 'keys', 'budget', 'actions'] as const) {
      expect(hostKeyAction(step, 'q', false)).toBe('quit');
    }
  });

  it('goes back to the overview on Esc from those screens', () => {
    expect(hostKeyAction('status', '', true)).toBe('overview');
    expect(hostKeyAction('models', '', true)).toBe('overview');
  });

  it('ignores keys while the health check runs', () => {
    expect(hostKeyAction('checking', 'q', true)).toBe('none');
  });
});

describe('the usage screen', () => {
  it('opens from the overview on u, quits on q and backs out on esc', () => {
    expect(nextStep('overview', 'u')).toBe('usage');
    expect(hostKeyAction('usage', 'q', false)).toBe('quit');
    expect(hostKeyAction('usage', '', true)).toBe('overview');
    // Its own axis keys are not navigation.
    for (const key of ['d', 'w', 'g']) expect(nextStep('usage', key)).toBe('usage');
  });

  it('is a deep link boot lands on once', () => {
    expect(afterCheck('usage', false)).toBe('usage');
    expect(afterCheck('usage', true)).toBe('overview');
  });
});
