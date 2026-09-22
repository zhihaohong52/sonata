/**
 * The board's visual vocabulary: colour, state strokes, and the shared-scale
 * bar every surface draws quantities with.
 *
 * One module because four surfaces (`init`, `agents`, `status`, `tui`) must
 * agree about what a cooled row looks like. A second copy is how they stop
 * agreeing.
 *
 * Three constraints shape everything here, and each one rules something out:
 *
 * - **The background is the user's.** Nothing sets one. Every value below is a
 *   foreground ink chosen to hold on a light *and* a dark terminal, which is
 *   why there is no near-black and no near-white in the palette.
 * - **Colour is never the only carrier.** State is a stroke (see `STATE`), and
 *   colour merely agrees with it. Strip the colour and every screen still
 *   reads — which is what a 16-colour SSH session and a colour-blind reader
 *   both get.
 * - **Ink only, no glyph costumes.** Box-drawing characters are the medium's
 *   own marks, not decoration. No emoji stands in for an icon.
 */

/**
 * Ink.
 *
 * Named by role rather than by hue, so a row asks for `ACCENT` and not for
 * "orange" — the one change that lets the palette move without a sweep through
 * every component.
 *
 * `ACCENT` is warm terracotta, the same tone Claude Code uses. That is a
 * deliberate family resemblance rather than a borrowed look: sonata runs
 * *inside* Claude Code, and a tool that lives in another product's window
 * earns more by belonging than by asserting itself. It is spent on exactly two
 * things per screen — the lead service, and the key that commits — so it keeps
 * meaning something.
 */
export const INK = {
  /** The lead service, and the committing key. Nothing else. */
  ACCENT: '#d7875f',
  /** Primary text. Deliberately not pure white: it must sit on a light theme too. */
  TEXT: undefined as string | undefined,
  /** Secondary text: units, provenance, inactive rows. */
  MUTED: '#8a8a8a',
  /** Hairlines and the unfilled part of a bar. */
  RULE: '#5a5a5a',
  /** Quantities, by band. Desaturated so a full row of bars stays calm. */
  LOW: '#87af87',
  MID: '#d7af5f',
  HIGH: '#d75f5f',
} as const;

/**
 * `TEXT` is `undefined` on purpose: Ink renders an unstyled `<Text>` in the
 * terminal's own foreground, which is the only value guaranteed to contrast
 * with the terminal's own background. Naming a hex here would be the single
 * most likely way to produce unreadable text on somebody's light theme.
 */

/**
 * Where a quantity sits, as a band rather than a number.
 *
 * Thresholds are behavioural, not aesthetic: `HIGH` is where sonata itself
 * starts refusing or escalating, so the colour and the program agree about
 * what is alarming. A band that disagreed with the code would be decoration.
 */
export function band(fraction: number): string {
  if (fraction >= 0.9) return INK.HIGH;
  if (fraction >= 0.7) return INK.MID;
  return INK.LOW;
}

/**
 * State as stroke.
 *
 * Each row carries one of these in its status column, and the mark alone is
 * sufficient — colour repeats it, never replaces it. Taken from the machine-room
 * patchbay this direction was raised by, where a link line's *shape* says
 * whether a normal is live, held, broken or cut.
 */
export const STATE = {
  /** Live and reachable: nothing is wrong. */
  live: { mark: '──', word: 'ready' },
  /** The lead: this is what a dispatch gets right now. */
  lead: { mark: '━━', word: 'running' },
  /** Cooling down after a failure. A stated condition with a time, not an error. */
  cooled: { mark: '─ ─', word: 'delayed' },
  /** Something better and cheaper exists, so this will never be chosen first. */
  dominated: { mark: '──○', word: 'standby' },
  /** Held out by hand — `avoid_gateways`, or a deselected provider. */
  held: { mark: '─┼─', word: 'held' },
  /** Cannot be ranked: the catalog prices no work for it. */
  unscored: { mark: '· ·', word: 'unranked' },
} as const;

export type StateName = keyof typeof STATE;

/**
 * A quantity drawn against a scale shared with every other row on screen.
 *
 * Shared is the whole point: the reader's question is always comparative
 * ("is this one better than the one under it"), and a bar scaled to its own
 * row answers a question nobody asked. `fraction` is therefore computed by the
 * caller against the screen's own maximum, never against the value's ceiling.
 *
 * `╸` gives a half cell so a one-column difference is still visible at the
 * narrow widths a split pane imposes — without it, two models a few points
 * apart draw identical bars.
 */
export function bar(fraction: number, width: number): { filled: string; track: string } {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const cells = clamped * width;
  const full = Math.floor(cells);
  const half = cells - full >= 0.5 && full < width;
  return {
    filled: '━'.repeat(full) + (half ? '╸' : ''),
    track: '─'.repeat(Math.max(0, width - full - (half ? 1 : 0))),
  };
}

/**
 * Column widths for a given terminal width.
 *
 * The board degrades by dropping *columns*, never by wrapping: a wrapped row
 * stops being a row, and the whole grammar depends on one service per line.
 * Below `MIN_BOARD`, the bar goes first (the numbers still carry the
 * comparison), then status words shorten to their marks.
 */
export const MIN_BOARD = 72;

/**
 * The board stops growing here and sits left.
 *
 * A measure limit, for the same reason prose has one: past this the name
 * column stretches and the bar drifts so far from the model it describes
 * that the eye cannot carry one to the other. Measured at 200 columns, where
 * the name ran 145 wide and the row read as two unrelated halves.
 */
export const MAX_BOARD = 120;

/** Widest mark and word in `STATE`, which the status column must hold. */
const MARK_W = Math.max(...Object.values(STATE).map((s) => s.mark.length));
const WORD_W = Math.max(...Object.values(STATE).map((s) => s.word.length));
/** `rank` is 3 plus its trailing space; `cost` is `$` + 4 decimals, right-aligned. */
const RANK_W = 4;
const COST_W = 9;

export interface BoardColumns {
  name: number;
  bar: number;
  showBar: boolean;
  showWord: boolean;
  /** Total cells a row occupies. Never exceeds the terminal width. */
  total: number;
}

export function columns(termWidth: number): BoardColumns {
  const w = Math.min(Math.max(40, termWidth), MAX_BOARD);
  const showBar = w >= MIN_BOARD;
  const showWord = w >= 88;
  // Measured from STATE rather than guessed: a status column one cell short
  // wraps the row, and a wrapped row stops being a row — which is the whole
  // grammar. Caught by rendering, where rows came back with a blank line
  // between each because the total ran one cell over the terminal.
  const status = showWord ? 1 + MARK_W + 1 + WORD_W : 1 + MARK_W;
  const budget = w - RANK_W - COST_W - status;
  const barWidth = showBar ? Math.min(18, Math.max(8, Math.floor(budget * 0.3))) : 0;
  const name = Math.max(10, budget - barWidth);
  return { name, bar: barWidth, showBar, showWord, total: RANK_W + name + barWidth + COST_W + status };
}
