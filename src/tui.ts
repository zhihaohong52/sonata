/**
 * Minimal zero-dependency TUI primitives.
 *
 * The interactive glue is deliberately thin: all list behaviour lives in the
 * pure `parseKey` / `reduce` / `renderList` functions so it can be tested
 * without a TTY. Only `runList` and `confirm` touch stdin.
 */

export type ListKey =
  | { kind: 'up' } | { kind: 'down' } | { kind: 'space' }
  | { kind: 'enter' } | { kind: 'cancel' }
  | { kind: 'backspace' } | { kind: 'ignore' }
  | { kind: 'char'; value: string };

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
}

/**
 * `filterable` decides what a letter means. In a filterable list it is text;
 * in a plain list it is vim navigation. The lists that filter are the long
 * ones, where typing is the only practical way to reach an entry.
 */
export function parseKey(seq: string, filterable: boolean): ListKey {
  switch (seq) {
    case '\u001b[A': return { kind: 'up' };
    case '\u001b[B': return { kind: 'down' };
    // Space toggles even while filtering: no provider or model ref contains
    // one, so the filter never needs a space.
    case ' ': return { kind: 'space' };
    case '\r': case '\n': return { kind: 'enter' };
    case '\u0003': case '\u001b': return { kind: 'cancel' };
    case '\u007f': case '\b': return { kind: 'backspace' };
    default: break;
  }
  if (!filterable) {
    if (seq === 'k') return { kind: 'up' };
    if (seq === 'j') return { kind: 'down' };
    return { kind: 'ignore' };
  }
  // eslint-disable-next-line no-control-regex
  if (seq.length > 0 && !/[\u0000-\u001f\u007f]/.test(seq)) {
    return { kind: 'char', value: seq };
  }
  return { kind: 'ignore' };
}

export interface ListState {
  /** Index into the *filtered* view. */
  cursor: number;
  /** *Original* choice indices, so a filter change cannot disturb a selection. */
  checked: Set<number>;
  filter: string;
  done: boolean;
  cancelled: boolean;
}

export function visibleIndices<T>(choices: Choice<T>[], filter: string): number[] {
  const q = filter.trim().toLowerCase();
  const out: number[] = [];
  choices.forEach((c, i) => {
    if (q.length === 0 || c.label.toLowerCase().includes(q)) out.push(i);
  });
  return out;
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
    filter: '',
    done: false,
    cancelled: false,
  };
}

/** Moves within the filtered view, skipping disabled entries. Wraps. */
function move<T>(choices: Choice<T>[], view: number[], from: number, delta: number): number {
  const n = view.length;
  if (n === 0) return 0;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (!choices[view[i]].disabled) return i;
  }
  return from;
}

function withFilter<T>(state: ListState, choices: Choice<T>[], filter: string): ListState {
  const view = visibleIndices(choices, filter);
  return { ...state, filter, cursor: view.length === 0 ? 0 : Math.min(state.cursor, view.length - 1) };
}

export function reduce<T>(
  state: ListState,
  key: ListKey,
  choices: Choice<T>[],
  multi: boolean,
): ListState {
  const view = visibleIndices(choices, state.filter);
  const under = view[state.cursor];

  switch (key.kind) {
    case 'up':
      return { ...state, cursor: move(choices, view, state.cursor, -1) };
    case 'down':
      return { ...state, cursor: move(choices, view, state.cursor, +1) };
    case 'space': {
      if (!multi || under === undefined || choices[under].disabled) return state;
      const checked = new Set(state.checked);
      if (checked.has(under)) checked.delete(under);
      else checked.add(under);
      return { ...state, checked };
    }
    case 'enter': {
      if (multi) return { ...state, done: true };
      if (under === undefined || choices[under].disabled) return state;
      return { ...state, checked: new Set([under]), done: true };
    }
    case 'char':
      return multi ? withFilter(state, choices, state.filter + key.value) : state;
    case 'backspace':
      return multi ? withFilter(state, choices, state.filter.slice(0, -1)) : state;
    case 'cancel':
      return { ...state, cancelled: true, done: true };
    default:
      return state;
  }
}

export interface Window {
  start: number;
  end: number;
  above: number;
  below: number;
}

/**
 * The slice of a list to draw, centred on the cursor.
 *
 * Drawing every choice is not an option: the redraw moves the terminal cursor
 * up by the block height, so a block taller than the screen corrupts it, and
 * one provider alone offers 341 models.
 */
export function viewport(cursor: number, total: number, height: number): Window {
  if (total === 0) return { start: 0, end: 0, above: 0, below: 0 };
  const h = Math.min(Math.max(3, height), total);
  let start = cursor - Math.floor(h / 2);
  if (start < 0) start = 0;
  if (start + h > total) start = total - h;
  const end = start + h;
  return { start, end, above: start, below: total - end };
}

/** Rows available for choices, after the title, filter, counts and hint. */
export function listHeight(rows: number = process.stdout.rows ?? 24): number {
  return Math.max(3, Math.min(15, rows - 8));
}

export function renderList<T>(
  title: string,
  choices: Choice<T>[],
  state: ListState,
  multi: boolean,
  height = 15,
): string {
  const view = visibleIndices(choices, state.filter);
  const win = viewport(state.cursor, view.length, height);
  const lines: string[] = [`  ${title}`, ''];
  if (multi) lines.push(`  filter: ${state.filter}█`, '');

  if (win.above > 0) lines.push(`    ↑ ${win.above} more`);
  for (let i = win.start; i < win.end; i++) {
    const orig = view[i];
    const choice = choices[orig];
    const pointer = i === state.cursor ? '❯' : ' ';
    const mark = multi ? (state.checked.has(orig) ? '◉' : '○') : '';
    const hint = choice.hint ? `  · ${choice.hint}` : '';
    const label = choice.disabled ? `${choice.label} (unavailable)` : choice.label;
    lines.push(`  ${pointer} ${mark} ${label}${hint}`.replace(/\s+$/, ''));
  }
  if (win.below > 0) lines.push(`    ↓ ${win.below} more`);

  lines.push('');
  lines.push(multi
    ? `  ${view.length} of ${choices.length} · space toggle · type to filter · enter confirm · esc cancel`
    : '  ↑↓ move · enter select · esc cancel');
  return lines.join('\n');
}

// ---- text input ---------------------------------------------------------

/**
 * A line editor, kept separate from `ListKey` because the meaning of a keystroke
 * differs: in a list, `j` moves down; in a text field it is the letter j.
 */
export type TextKey =
  | { kind: 'char'; value: string }
  | { kind: 'backspace' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'enter' }
  | { kind: 'cancel' }
  | { kind: 'ignore' };

export interface TextState {
  value: string;
  /** Insertion point, 0..value.length. */
  cursor: number;
  done: boolean;
  cancelled: boolean;
}

export function parseTextKey(seq: string): TextKey {
  switch (seq) {
    case '\u001b[D': return { kind: 'left' };
    case '\u001b[C': return { kind: 'right' };
    case '\u001b[H': case '\u0001': return { kind: 'home' };   // Home, ctrl-a
    case '\u001b[F': case '\u0005': return { kind: 'end' };    // End, ctrl-e
    case '\u007f': case '\b': return { kind: 'backspace' };    // DEL, BS
    case '\r': case '\n': return { kind: 'enter' };
    case '\u0003': case '\u001b': return { kind: 'cancel' };   // ctrl-c, esc
    default:
      break;
  }
  // A paste arrives as a single chunk, so multi-character input is accepted —
  // but anything containing a control character is dropped rather than written
  // into the value, where an escape sequence would be invisible and corrupting.
  // eslint-disable-next-line no-control-regex
  if (seq.length > 0 && !/[\u0000-\u001f\u007f]/.test(seq)) {
    return { kind: 'char', value: seq };
  }
  return { kind: 'ignore' };
}

export function initialTextState(initial = ''): TextState {
  return { value: initial, cursor: initial.length, done: false, cancelled: false };
}

export function reduceText(state: TextState, key: TextKey): TextState {
  switch (key.kind) {
    case 'char':
      return {
        ...state,
        value: state.value.slice(0, state.cursor) + key.value + state.value.slice(state.cursor),
        cursor: state.cursor + key.value.length,
      };
    case 'backspace':
      if (state.cursor === 0) return state;
      return {
        ...state,
        value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor),
        cursor: state.cursor - 1,
      };
    case 'left':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'right':
      return { ...state, cursor: Math.min(state.value.length, state.cursor + 1) };
    case 'home':
      return { ...state, cursor: 0 };
    case 'end':
      return { ...state, cursor: state.value.length };
    case 'enter':
      // An empty value is not a submission: there is nothing to accept, and
      // silently returning "" would be written into sonata.toml as a model id.
      return state.value.trim().length === 0 ? state : { ...state, done: true };
    case 'cancel':
      return { ...state, cancelled: true, done: true };
    default:
      return state;
  }
}

export function renderText(title: string, state: TextState, hint?: string): string {
  // The caret is drawn as a reverse-video cell rather than by moving the real
  // terminal cursor, which the full-block redraw would otherwise fight with.
  const at = state.value.slice(state.cursor, state.cursor + 1) || ' ';
  const line =
    state.value.slice(0, state.cursor) +
    `\u001b[7m${at}\u001b[0m` +
    state.value.slice(state.cursor + 1);
  return [
    `  ${title}`,
    '',
    `  \u276f ${line}`,
    '',
    hint ? `  ${hint}` : '  enter confirm \u00b7 esc cancel',
  ].join('\n');
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

interface KeySource extends NodeJS.ReadableStream {
  setRawMode?(mode: boolean): void;
  iterator(opts: { destroyOnReturn: boolean }): AsyncIterableIterator<unknown>;
}

/**
 * Puts stdin in raw mode, feeds every keystroke to `step`, and restores it.
 *
 * Owning the whole lifecycle here is deliberate: stdin is shared by every
 * prompt in a run, and two details have to be right or the *next* prompt
 * breaks rather than this one.
 *
 *   - `destroyOnReturn: false` — the default async iterator destroys the
 *     stream when the loop ends, so a later prompt would reject with "The
 *     operation was aborted".
 *   - no `resume()` — that switches stdin to flowing mode, where chunks are
 *     dropped in the gap before the next prompt's iterator attaches. The
 *     iterator pulls on its own; it needs no help.
 */
export async function readKeys(
  stdin: KeySource,
  step: (chunk: string) => boolean,
): Promise<void> {
  stdin.setRawMode?.(true);
  stdin.setEncoding('utf8');
  try {
    for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
      if (step(String(chunk))) return;
    }
  } finally {
    stdin.setRawMode?.(false);
    stdin.pause();
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
  const height = listHeight();

  const draw = (first: boolean): void => {
    const body = renderList(title, choices, state, multi, height);
    if (!first) stdout.write(`\u001b[${body.split('\n').length}A`);
    stdout.write(`${body.split('\n').map((l) => `\u001b[2K${l}`).join('\n')}\n`);
  };

  draw(true);
  await readKeys(stdin, (chunk) => {
    state = reduce(state, parseKey(chunk, multi), choices, multi);
    if (state.done) return true;
    draw(false);
    return false;
  });

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

/**
 * Reads one line of text. Used where there is nothing to enumerate — codex has
 * no command that lists its models, so the id has to be typed.
 */
export async function prompt(
  title: string,
  opts: { initial?: string; hint?: string; validate?: (v: string) => string | null } = {},
): Promise<string> {
  if (!isInteractive()) {
    throw new Error(
      'sonata: this command needs an interactive terminal. ' +
      'Use the non-interactive flags instead (see `sonata init --help`).',
    );
  }

  let state = initialTextState(opts.initial ?? '');
  let error: string | null = null;
  const stdin = process.stdin;
  const stdout = process.stdout;
  let lastHeight = 0;

  const draw = (first: boolean): void => {
    const body = renderText(title, state, error ?? opts.hint);
    if (!first) stdout.write(`\u001b[${lastHeight}A`);
    // The error line changes the block height, so clear each line as it is
    // rewritten; otherwise a shrinking block leaves the old tail on screen.
    stdout.write(`${body.split('\n').map((l) => `\u001b[2K${l}`).join('\n')}\n`);
    lastHeight = body.split('\n').length;
  };

  draw(true);
  await readKeys(stdin, (chunk) => {
    const next = reduceText(state, parseTextKey(chunk));
    // Validation runs on submission only, so the message does not flicker
    // while the value is still being typed.
    if (next.done && !next.cancelled && opts.validate) {
      const problem = opts.validate(next.value.trim());
      if (problem) {
        error = problem;
        state = { ...next, done: false };
        draw(false);
        return false;
      }
    }
    error = null;
    state = next;
    if (state.done) return true;
    draw(false);
    return false;
  });

  if (state.cancelled) throw new CancelledError();
  return state.value.trim();
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const yes = { value: true, label: 'Yes', checked: defaultYes };
  const no = { value: false, label: 'No', checked: !defaultYes };
  return select(question, defaultYes ? [yes, no] : [no, yes]);
}
