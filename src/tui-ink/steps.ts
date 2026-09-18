/** The screens this phase of the config TUI has. */
export type Step = 'checking' | 'overview' | 'budget';

/**
 * Where a keypress moves the TUI.
 *
 * Pure and separate from the component, so navigation is provable without a
 * TTY — the same discipline `src/tui.ts`'s `parseKey`/`reduce` already follow.
 *
 * `checking` is deliberately inert: boot advances when the health check
 * resolves, and a keypress that skipped it would land on an overview with no
 * results to show.
 */
export function nextStep(step: Step, key: string): Step {
  if (step === 'checking') return 'checking';
  if (key === 'escape') return 'overview';
  if (step === 'overview' && key === 'b') return 'budget';
  return step;
}
