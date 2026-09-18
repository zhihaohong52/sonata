import { describe, it, expect } from 'vitest';
import { nextStep } from '../../src/tui-ink/steps.js';

describe('nextStep', () => {
  it('opens the budget screen from the overview', () => {
    expect(nextStep('overview', 'b')).toBe('budget');
    expect(nextStep('overview', 'm')).toBe('models');
    expect(nextStep('overview', 'p')).toBe('providers');
  });

  it('returns to the overview from a screen', () => {
    expect(nextStep('budget', 'escape')).toBe('overview');
    expect(nextStep('models', 'escape')).toBe('overview');
    expect(nextStep('providers', 'escape')).toBe('overview');
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
