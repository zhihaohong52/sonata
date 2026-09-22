/** The screens this phase of the config TUI has. */
export type Step = 'checking' | 'overview' | 'init' | 'budget' | 'models' | 'providers' | 'tiers' | 'keys' | 'actions' | 'status';

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
  if (step === 'overview' && key === 'm') return 'models';
  if (step === 'overview' && key === 'p') return 'providers';
  if (step === 'overview' && key === 't') return 'tiers';
  if (step === 'overview' && key === 'k') return 'keys';
  if (step === 'overview' && key === 'a') return 'actions';
  if (step === 'overview' && key === 's') return 'status';
  if (step === 'overview' && key === 'i') return 'init';
  return step;
}

/**
 * Where boot lands after the health check, given whether it has run before.
 *
 * `start` is a **deep link**: the screen `sonata status`, `sonata agents` or
 * `sonata init` opens on. It applies once. Re-applying it is an infinite
 * loop, and one that shipped: `init` finishes by routing back to `checking`
 * so doctor re-runs against the machine it just changed, `checking` then read
 * `start` again, and `sonata init` bounced straight back into Setup and
 * re-probed every harness — reported as exactly that, a loop that would not
 * exit.
 *
 * Once booted, every later pass through `checking` lands on the overview,
 * which is the screen the app is actually for.
 */
export function afterCheck(start: Step | undefined, booted: boolean): Step {
  if (booted || start === undefined) return 'overview';
  // `checking` as a deep link would be a second loop, of a simpler kind: the
  // check would complete and route straight back into itself.
  if (start === 'checking') return 'overview';
  return start;
}
