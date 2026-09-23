export interface RsState {
  /**
   * Position in the **displayed** order (`rsOrder`) under the cursor — not an
   * index into the item list, which is a different order the moment anything
   * is ranked.
   */
  cursor: number;
  /** Original item indices, ordered from highest to lowest priority. */
  ranked: number[];
}

/**
 * The order rows are drawn in: ranked items first, in rank order, then the
 * rest in item order.
 *
 * The list used to be drawn in item order with the rank as a marker, which is
 * what made `[`/`]` read as broken. Reported: "[ and ] does not work in sonata
 * TUI", on a real 19-row screen whose markers ran `·  ·  ·  ·  1.  5.  ·  ·  ·
 * ·  ·  ·  2.  6.  ·  ·  3.  7.  ·`. Reordering swapped two *numbers* between
 * rows that were nowhere near each other and left the cursor where it was, so
 * pressing `[` twice was a round trip and pressing it once often changed
 * nothing visible on screen at all. Sixteen of those nineteen rows were
 * unranked, where the keys correctly do nothing and the footer offered no hint
 * why.
 *
 * Drawing in rank order makes a display position *be* a rank position for a
 * ranked item, which is what lets the cursor follow the row it moved.
 */
export function rsOrder(state: RsState, itemCount: number): number[] {
  const inRank = new Set(state.ranked);
  const rest: number[] = [];
  for (let index = 0; index < itemCount; index++) {
    if (!inRank.has(index)) rest.push(index);
  }
  return [...state.ranked, ...rest];
}

/** The item the cursor is on, or -1 past the end of a shorter list. */
export function rsCursorItem(state: RsState, itemCount: number): number {
  return rsOrder(state, itemCount)[state.cursor] ?? -1;
}

export type RsAction =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'toggle' }
  | { type: 'moveUp' }
  | { type: 'moveDown' };

/** The board's starting state: cursor on the first row, `ranked` holding the seeded indices in rank order. */
export function rsInitial(itemCount: number, initialRanked: number[]): RsState {
  return {
    cursor: 0,
    ranked: [...new Set(initialRanked)].filter((index) => index >= 0 && index < itemCount),
  };
}

/** The board's state transitions — cursor moves, rank toggles and reorders — as a pure reducer, so every key is testable without a TTY. */
export function rsReduce(state: RsState, action: RsAction, itemCount: number): RsState {
  const maxCursor = Math.max(0, itemCount - 1);

  switch (action.type) {
    case 'up':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'down':
      return { ...state, cursor: Math.min(maxCursor, state.cursor + 1) };
    case 'toggle': {
      const item = rsCursorItem(state, itemCount);
      if (item < 0) return state;
      const ranked = [...state.ranked];
      const position = ranked.indexOf(item);
      if (position >= 0) ranked.splice(position, 1);
      else ranked.push(item);
      // Toggling moves the row between the two blocks, so the cursor follows
      // the *item* rather than holding its position — the same rule `[`/`]`
      // use. Otherwise space would silently leave the highlight on whichever
      // unrelated row slid into the vacated slot, and pressing `[` next would
      // reorder something the user had not looked at.
      return { cursor: rsOrder({ cursor: 0, ranked }, itemCount).indexOf(item), ranked };
    }
    // A ranked item's display position *is* its rank position (`rsOrder` draws
    // the ranked block first), so these need no lookup — and the cursor moves
    // with the row, which is what makes the keypress visible.
    case 'moveUp': {
      if (state.cursor <= 0 || state.cursor >= state.ranked.length) return state;
      const ranked = [...state.ranked];
      [ranked[state.cursor - 1], ranked[state.cursor]] = [ranked[state.cursor], ranked[state.cursor - 1]];
      return { cursor: state.cursor - 1, ranked };
    }
    case 'moveDown': {
      if (state.cursor < 0 || state.cursor >= state.ranked.length - 1) return state;
      const ranked = [...state.ranked];
      [ranked[state.cursor], ranked[state.cursor + 1]] = [ranked[state.cursor + 1], ranked[state.cursor]];
      return { cursor: state.cursor + 1, ranked };
    }
  }
}

/** A row's measurements, as far as dominance cares. */
export interface Measured { capability?: number; costPerTask?: number }

/**
 * Which rows are genuinely Pareto-dominated: something else is at least as
 * capable and costs no more.
 *
 * Computed rather than assumed. The board used to label **every unranked row**
 * `dominated`, whose stated meaning in `theme.ts` is "something better and
 * cheaper exists, so this will never be chosen first" — a claim about the
 * catalog that the component had never checked. It only knew the row was not
 * in the user's list. Deselecting a perfectly good model still called it
 * standby, and on a real screen the label happened to be true, which is worse
 * than being obviously wrong: it reads as verified.
 *
 * Same class as the OAuth gateway reported as needing a credential it cannot
 * have. A row that says something about the world has to have looked.
 *
 * Only rows carrying both measurements take part. An unscored row cannot
 * dominate (nothing is known about it) and cannot be dominated (there is
 * nothing to compare), which is why it has a state of its own.
 */
export function dominatedRows(rows: ReadonlyArray<Measured | undefined>): Set<number> {
  const out = new Set<number>();
  const scored = rows
    .map((row, index) => ({ index, row }))
    .filter((entry): entry is { index: number; row: Measured } =>
      entry.row?.capability !== undefined && entry.row?.costPerTask !== undefined);
  for (const a of scored) {
    const beaten = scored.some((b) => b.index !== a.index
      && b.row.capability! >= a.row.capability!
      && b.row.costPerTask! <= a.row.costPerTask!
      && (b.row.capability! > a.row.capability! || b.row.costPerTask! < a.row.costPerTask!));
    if (beaten) out.add(a.index);
  }
  return out;
}

/**
 * Which rows of the board to draw, so it never outgrows the terminal.
 *
 * The board drew every row however short the window was. A role with a
 * dozen candidates plus the head, the column header, three rules and a
 * keymap that wraps on a narrow terminal is taller than a 22-row window, and
 * what goes is the TOP — the title that says which role and tier is being
 * ranked. Found while verifying resize: at 40 columns the key hints wrapped
 * and the title scrolled away.
 *
 * The window follows the cursor, centred where it can be, so the row being
 * moved is always on screen — `[` and `]` carry a row up and down the list,
 * and a window that did not follow would move it out of sight. `room` is the
 * number of lines left for rows after the chrome. The result never uses more
 * lines than that, markers included — on a terminal too short for markers
 * they are dropped rather than drawn past the bottom.
 *
 * The `↑`/`↓` markers are budgeted here rather than drawn on top: they cost a
 * line each, and forgetting them is how a windowed list overflows by one or
 * two.
 */
export function boardWindow(
  cursor: number,
  count: number,
  room: number,
): { start: number; end: number; markers: boolean } {
  const avail = Math.max(1, room);
  if (count <= avail) return { start: 0, end: count, markers: false };
  // Markers only when there is room for them AND a row: below three lines
  // they would crowd out the list they describe, and drawing them anyway is
  // how a "windowed" list still overflowed a very short terminal — the floor
  // used to force three rows plus two markers into as little as one line.
  const markers = avail >= 3;
  const size = markers ? avail - 2 : avail;
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), count - size));
  return { start, end: Math.min(count, start + size), markers };
}

/**
 * How many lines a row of items takes once it wraps between items.
 *
 * The keymap wraps between key/action pairs, never inside one, so its height
 * is a greedy packing of whole pairs — not total width divided by the page.
 * The division undercounted badly exactly where it mattered: at 22 columns
 * almost every pair gets a line of its own, the estimate said four lines
 * where there were six, and the board spent the difference by pushing its
 * title off the top.
 */
export function packedLines(widths: readonly number[], width: number): number {
  const page = Math.max(1, width);
  let lines = widths.length > 0 ? 1 : 0;
  let used = 0;
  for (const w of widths) {
    if (used > 0 && used + w > page) { lines += 1; used = 0; }
    // An item wider than the page still takes one line of its own; the line
    // truncates or wraps inside it, which the caller's budget cannot see
    // anyway, so count it as the one line it occupies at best.
    used += w;
  }
  return lines;
}
