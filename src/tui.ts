/**
 * Minimal zero-dependency TUI primitives.
 *
 * The interactive glue is deliberately thin: all list behaviour lives in the
 * pure `parseKey` / `reduce` / `renderList` functions so it can be tested
 * without a TTY. Only `runList` and `confirm` touch stdin.
 */

export type ListKey =
  | { kind: 'up' } | { kind: 'down' } | { kind: 'space' }
  | { kind: 'enter' } | { kind: 'cancel' } | { kind: 'back' }
  | { kind: 'backspace' } | { kind: 'ignore' } | { kind: 'toggleAll' }
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
    // Left steps back a screen. Free to claim even in a filterable list: the
    // filter is append-only, with no cursor to move within it.
    case '\u001b[D': return { kind: 'back' };
    // Space toggles even while filtering: no provider or model ref contains
    // one, so the filter never needs a space.
    case ' ': return { kind: 'space' };
    case '\r': case '\n': return { kind: 'enter' };
    case '\u0001': return { kind: 'toggleAll' };
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
  /** Left was pressed: the caller should re-ask the previous question. */
  back?: boolean;
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
    case 'toggleAll': {
      if (!multi) return state;
      const enabled = view.filter((i) => !choices[i].disabled);
      const allChecked = enabled.every((i) => state.checked.has(i));
      const checked = new Set(state.checked);
      for (const i of enabled) {
        if (allChecked) checked.delete(i); else checked.add(i);
      }
      return { ...state, checked };
    }
    case 'cancel':
      return { ...state, cancelled: true, done: true };
    case 'back':
      return { ...state, back: true, done: true };
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
  back = false,
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
    ? `  ${view.length} of ${choices.length} · space toggle · type to filter · enter confirm${back ? ' · ← back' : ''} · esc cancel`
    : `  ↑↓ move · enter select${back ? ' · ← back' : ''} · esc cancel`);
  return lines.join('\n');
}

/**
 * Builds one redraw of a block, and reports the height to pass back next time.
 *
 * Uses clear-screen rather than per-line cursor-up: some terminal
 * environments (cmux panels, certain multiplexer panes) do not process
 * CSI cursor-movement sequences, which causes cursor-up redraws to
 * append the block rather than overwrite it. Clear-screen is universally
 * handled.
 */
export function redraw(body: string, lastHeight: number): { out: string; height: number } {
  const lines = body.split('\n');
  const clear = '\u001b[2J\u001b[H';
  return {
    out: `${clear}${lines.join('\n')}\n`,
    height: lines.length,
  };
}

/**
 * The wordmark, for commands a person reads rather than pipes.
 *
 * Deliberately plain text: no colour, so it survives a pale terminal, a dark
 * one, and a pipe into a file equally. Widest row is 54 columns, which leaves
 * room on an 80-column terminal.
 */
export function banner(): string {
  return [
  '  ███████╗ ██████╗ ███╗   ██╗ █████╗ ████████╗ █████╗',
  '  ██╔════╝██╔═══██╗████╗  ██║██╔══██╗╚══██╔══╝██╔══██╗',
  '  ███████╗██║   ██║██╔██╗ ██║███████║   ██║   ███████║',
  '  ╚════██║██║   ██║██║╚██╗██║██╔══██║   ██║   ██╔══██║',
  '  ███████║╚██████╔╝██║ ╚████║██║  ██║   ██║   ██║  ██║',
  '  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝',
    '',
    '  foreign-model subagents for Claude Code',
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

/**
 * Left was pressed on a screen that offers a previous step.
 *
 * A thrown sentinel rather than a return value, so every prompt keeps its
 * ordinary return type and only the wizard that knows the step order has to
 * handle going back.
 */
export class BackError extends Error {
  constructor() {
    super('back');
    this.name = 'BackError';
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
  back = false,
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

  stdout.write('\u001b[?1049h');

  let lastHeight = 0;
  const draw = (): void => {
    const { out, height: drawn } =
      redraw(renderList(title, choices, state, multi, height, back), lastHeight);
    stdout.write(out);
    lastHeight = drawn;
  };

  try {
    draw();
    await readKeys(stdin, (chunk) => {
      state = reduce(state, parseKey(chunk, multi), choices, multi);
      if (state.done) return true;
      draw();
      return false;
    });
  } finally {
    stdout.write('\u001b[?1049l');
  }

  if (state.cancelled) throw new CancelledError();
  // Only honoured where the caller said a previous step exists; otherwise Left
  // is inert rather than an error the wizard would have to swallow.
  if (state.back && back) throw new BackError();
  return [...state.checked].sort((a, b) => a - b).map((i) => choices[i].value);
}

export async function select<T>(title: string, choices: Choice<T>[], back = false): Promise<T> {
  const picked = await runList(title, choices, false, back);
  return picked[0];
}

export async function confirm(
  question: string, defaultYes: boolean, back = false,
): Promise<boolean> {
  const yes = { value: true, label: 'Yes', checked: defaultYes };
  const no = { value: false, label: 'No', checked: !defaultYes };
  return select(question, defaultYes ? [yes, no] : [no, yes], back);
}
