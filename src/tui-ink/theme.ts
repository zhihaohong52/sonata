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
 * - **The app paints its own ground.** Each palette is a *pair* — an explicit
 *   background and an explicit foreground — and the shell fills the screen
 *   with the background before anything draws on it.
 *
 *   This reverses the original rule, which was "the background is the user's,
 *   nothing sets one". That rule made light mode structurally impossible:
 *   with no ground of its own, switching to light could only darken the ink
 *   on a still-dark terminal, which is harder to read rather than lighter.
 *   Worse, `TEXT` was left `undefined` to inherit the terminal's foreground
 *   while `BAND` was a near-white — so the selected row rendered the
 *   terminal's light-grey text on a white band and vanished. A theme that
 *   only restyles ink is not a theme; it is a request that the user's
 *   terminal already match.
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
export interface Palette {
  /** The screen's own ground. Painted once by the shell, under everything. */
  BG: string;
  /** The lead row, the selected row's edge, and the committing key. Nothing else. */
  ACCENT: string;
  /**
   * Primary text. Explicit, never inherited.
   *
   * Inheriting was the bug: a palette that sets `BAND` but not `TEXT` is
   * asserting a background without knowing the foreground that will land on
   * it, and the two were from different themes.
   */
  TEXT: string;
  /** Secondary text: units, provenance, unselected rows. */
  MUTED: string;
  /** Hairlines and the unfilled part of a bar. */
  RULE: string;
  /** The selected row's band. Bounded to one row — never a screen background. */
  BAND: string;
  /** Quantities, by band. */
  LOW: string;
  MID: string;
  HIGH: string;
}

/**
 * Dark and light are the same design at two lightnesses, not two designs.
 *
 * Every pair holds its role: `MUTED` stays clearly secondary against `TEXT`,
 * `RULE` stays quieter than `MUTED`, and the three quantity bands stay
 * distinguishable from each other and from the rules. What changes is
 * lightness, because a hue that reads on charcoal disappears on paper — the
 * greens and ambers in particular have to darken considerably to hold against
 * a light ground.
 *
 * Both are explicit pairs. An unstyled Ink `<Text>` renders in the *terminal's*
 * foreground, which is the right answer only while the app draws on the
 * terminal's background too — once the shell paints its own ground, an
 * inherited foreground is a colour from somebody else's theme landing on
 * this one. Every `<Text>` therefore names its role, and `TEXT` is the role
 * for ordinary prose.
 */
export const DARK: Palette = {
  BG: '#141414',
  ACCENT: '#d7875f',
  TEXT: '#e8e4de',
  MUTED: '#8a8a8a',
  RULE: '#3f3f3f',
  BAND: '#2e2e2e',
  LOW: '#87af87',
  MID: '#d7af5f',
  HIGH: '#d75f5f',
};

/**
 * Light is not dark inverted, and its band goes the other way.
 *
 * On dark, an elevated surface is *lighter* than the ground; on light it must
 * be *darker*, or the selected row is a paler smear on an already pale page.
 * The accent is deepened rather than reused — terracotta that reads on
 * charcoal is too pale to hold against near-white, and it has to survive on
 * the band as well as on the ground, which is the worst case rather than the
 * typical one.
 */
export const LIGHT: Palette = {
  BG: '#faf7f2',
  ACCENT: '#95492a',
  TEXT: '#2b2723',
  MUTED: '#635d55',
  RULE: '#c9c1b4',
  BAND: '#e6dccc',
  LOW: '#2f6b34',
  MID: '#7a5c14',
  HIGH: '#9c2f24',
};

export type ThemeName = 'dark' | 'light';

/**
 * Which way round the terminal is.
 *
 * Order matters, and each step is weaker evidence than the one before it:
 *
 * 1. An explicit choice (`SONATA_THEME`, or the in-app toggle passing a
 *    value). The user saying so outranks any detection.
 * 2. `COLORFGBG`, which several terminals set as `fg;bg` with ANSI indices.
 *    A background of 7 or 15 is white-ish, so the terminal is light. It is
 *    absent more often than present, which is why it cannot be the only test.
 * 3. Dark, because it is the common default and because the dark palette's
 *    mistake on a light terminal is muted text that is *harder* to read,
 *    while the light palette's mistake on a dark one is text that vanishes.
 *    Both are wrong; only one is recoverable by squinting.
 */
export function resolveThemeName(env: NodeJS.ProcessEnv = process.env): ThemeName {
  const explicit = env.SONATA_THEME?.trim().toLowerCase();
  if (explicit === 'light' || explicit === 'dark') return explicit;
  const fgbg = env.COLORFGBG;
  if (fgbg !== undefined) {
    const bg = fgbg.split(';').pop()?.trim();
    if (bg === '7' || bg === '15') return 'light';
    if (bg !== undefined && /^\d+$/.test(bg)) return 'dark';
  }
  return 'dark';
}

export function paletteFor(name: ThemeName): Palette {
  return name === 'light' ? LIGHT : DARK;
}

/** The resolved palette for callers outside React. */
export const INK: Palette = paletteFor(resolveThemeName());

/**
 * Where a quantity sits, as a band rather than a number.
 *
 * Thresholds are behavioural, not aesthetic: `HIGH` is where sonata itself
 * starts refusing or escalating, so the colour and the program agree about
 * what is alarming. A band that disagreed with the code would be decoration.
 */
export function band(fraction: number, palette: Palette = INK): string {
  if (fraction >= 0.9) return palette.HIGH;
  if (fraction >= 0.7) return palette.MID;
  return palette.LOW;
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

/**
 * How many columns a row may actually occupy.
 *
 * One short of the terminal, because that is how wide the painted ground is
 * — see `Ground`, which cannot be full width or ink emits no background at
 * all. A row sized to the *terminal* therefore overflows the ground by one
 * cell and wraps, which turns every hairline into a rule plus a lone `─` on
 * the next line. Measured at 96 columns, where every rule wrapped.
 *
 * One definition, used by `Ground` and by every caller of `columns()`, so the
 * page and the rows drawn on it cannot disagree about the width.
 */
export const GROUND_INSET = 1;

export function usableWidth(termWidth: number = process.stdout.columns ?? 96): number {
  return Math.max(1, termWidth - GROUND_INSET);
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

/**
 * Where a cost sits within the range on screen, on a log scale.
 *
 * Log, because cost is a ratio scale and this design treats it that way
 * everywhere else — the frontier's knee, its slopes, and the wasteful-tail
 * gate all measure cost in decades. A linear fraction does not survive the
 * spreads that actually occur: on a real ranking screen the cheapest model is
 * $0.0098 and the dearest $1.399, a 143x range, so every row but the top two
 * rounds to near zero and the severity ramp collapses to one colour.
 *
 * Returns 0 for the cheapest row and 1 for the dearest, so `band` spends its
 * three colours across the range actually present rather than across a range
 * the screen does not have.
 */
export function costFraction(cost: number, min: number, max: number): number {
  if (!(cost > 0) || !(min > 0) || !(max > 0)) return 0;
  if (max <= min) return 0;
  const span = Math.log10(max / min);
  if (span === 0) return 0;
  return Math.min(1, Math.max(0, Math.log10(cost / min) / span));
}
