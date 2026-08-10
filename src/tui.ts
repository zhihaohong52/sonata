/**
 * Minimal zero-dependency TUI primitives.
 *
 * The interactive glue is deliberately thin: all list behaviour lives in the
 * pure `parseKey` / `reduce` / `renderList` functions so it can be tested
 * without a TTY. Only `runList` and `confirm` touch stdin.
 */

export type Key = 'up' | 'down' | 'space' | 'enter' | 'cancel' | 'other';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface ListState {
  cursor: number;
  checked: Set<number>;
  done: boolean;
  cancelled: boolean;
}

export function parseKey(seq: string): Key {
  switch (seq) {
    case '\u001b[A':
    case 'k':
      return 'up';
    case '\u001b[B':
    case 'j':
      return 'down';
    case ' ':
      return 'space';
    case '\r':
    case '\n':
      return 'enter';
    case '\u0003': // ctrl-c
    case '\u001b': // esc
      return 'cancel';
    default:
      return 'other';
  }
}

export function initialState<T>(choices: Choice<T>[]): ListState {
  const checked = new Set<number>();
  choices.forEach((c, i) => {
    if (c.checked) checked.add(i);
  });
  const firstEnabled = choices.findIndex((c) => !c.disabled);
  return {
    cursor: firstEnabled === -1 ? 0 : firstEnabled,
    checked,
    done: false,
    cancelled: false,
  };
}

/** Moves the cursor, skipping disabled entries. Wraps at both ends. */
function move<T>(choices: Choice<T>[], from: number, delta: number): number {
  const n = choices.length;
  if (n === 0) return 0;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!choices[i].disabled) return i;
  }
  return from;
}

export function reduce<T>(
  state: ListState,
  key: Key,
  choices: Choice<T>[],
  multi: boolean,
): ListState {
  switch (key) {
    case 'up':
      return { ...state, cursor: move(choices, state.cursor, -1) };
    case 'down':
      return { ...state, cursor: move(choices, state.cursor, +1) };
    case 'space': {
      if (!multi || choices[state.cursor]?.disabled) return state;
      const checked = new Set(state.checked);
      if (checked.has(state.cursor)) checked.delete(state.cursor);
      else checked.add(state.cursor);
      return { ...state, checked };
    }
    case 'enter': {
      if (!multi && choices[state.cursor]?.disabled) return state;
      const checked = multi ? state.checked : new Set([state.cursor]);
      return { ...state, checked, done: true };
    }
    case 'cancel':
      return { ...state, cancelled: true, done: true };
    default:
      return state;
  }
}

export function renderList<T>(
  title: string,
  choices: Choice<T>[],
  state: ListState,
  multi: boolean,
): string {
  const lines: string[] = [`  ${title}`, ''];

  choices.forEach((choice, i) => {
    const pointer = i === state.cursor ? '❯' : ' ';
    const mark = multi ? (state.checked.has(i) ? '◉' : '○') : '';
    const hint = choice.hint ? `  · ${choice.hint}` : '';
    const label = choice.disabled ? `${choice.label} (unavailable)` : choice.label;
    lines.push(`  ${pointer} ${mark} ${label}${hint}`.replace(/\s+$/, ''));
  });

  lines.push('');
  lines.push(multi ? '  space toggle · enter confirm · esc cancel'
                   : '  ↑↓ move · enter select · esc cancel');
  return lines.join('\n');
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

async function runList<T>(
  title: string,
  choices: Choice<T>[],
  multi: boolean,
): Promise<T[]> {
  if (!isInteractive()) {
    throw new Error(
      'sonata: this command needs an interactive terminal. ' +
      'Use the non-interactive flags instead (see `sonata init --help`).',
    );
  }
  if (choices.length === 0) return [];

  let state = initialState(choices);
  const stdin = process.stdin;
  const stdout = process.stdout;

  const draw = (first: boolean): void => {
    const body = renderList(title, choices, state, multi);
    if (!first) stdout.write(`\u001b[${body.split('\n').length}A`);
    stdout.write(`${body}\n`);
  };

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  draw(true);

  try {
    for await (const chunk of stdin) {
      state = reduce(state, parseKey(String(chunk)), choices, multi);
      if (state.done) break;
      draw(false);
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }

  if (state.cancelled) throw new CancelledError();
  return [...state.checked].sort((a, b) => a - b).map((i) => choices[i].value);
}

export async function select<T>(title: string, choices: Choice<T>[]): Promise<T> {
  const picked = await runList(title, choices, false);
  return picked[0];
}

export async function multiselect<T>(title: string, choices: Choice<T>[]): Promise<T[]> {
  return runList(title, choices, true);
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const yes = { value: true, label: 'Yes', checked: defaultYes };
  const no = { value: false, label: 'No', checked: !defaultYes };
  return select(question, defaultYes ? [yes, no] : [no, yes]);
}
