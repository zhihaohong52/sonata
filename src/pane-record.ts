/**
 * What a run printed, recorded once each: the source of `events.jsonl`, which
 * `sonata log` prints.
 *
 * A tmux pane shows one screen, and a poll that compares two captures of it
 * cannot see anything that scrolled past in between. Capturing scrollback as
 * well, and diffing that, was tried and was wrong: a scrollback capture almost
 * never shifts, so any line redrawn in place (a status line, a two-line
 * composer, an alternate screen exiting) left nothing to align on and the
 * whole history — ~2000 lines — was recorded again on every poll.
 *
 * So the record is built from facts tmux states rather than from alignment:
 *
 * - **Scrollback is append-only.** `#{history_size}` says how many rows it
 *   holds, so the rows that entered it since the last poll are known exactly
 *   (`g`), and a row never changes once there.
 * - **Rows only move up.** The rows that scrolled into history were the top
 *   rows of the previous screen, in order. Those that held content when the
 *   previous screen was captured were seen then and are already recorded; the
 *   rest — output that filled the blank rows below it and scrolled away, or
 *   that scrolled through faster than a poll — are the *last* rows of the new
 *   history, fetched exactly.
 * - **The visible screen is compared by position**, shifted by `g`: row `i`
 *   now is row `i + g` then. A row that differs is new or redrawn, and only
 *   that row is recorded — a redrawn status line costs one line, not a
 *   screen. Content that has not scrolled is recorded this way the moment it
 *   appears, and because it was seen, it is skipped when it later scrolls.
 * - **The alternate screen writes no history** (a full-screen TUI), so there
 *   the shift is estimated by best row alignment instead, and the normal
 *   screen's state is kept aside until the TUI exits.
 *
 * The one place a count is not available is a full history: at
 * `history-limit`, `history_size` stops growing while rows still enter. There
 * the growth is found by locating the last rows of history seen before (an
 * anchor), which never change, in the history now. A block of identical rows
 * repeated can make that ambiguous; the latest match is taken, which can miss
 * lines but never records one twice.
 */
import { SPINNER_ONLY, stripAnsi } from './normalize.js';

/** What `display-message` reports about a pane, read together. */
export interface PaneInfo {
  historySize: number;
  historyLimit: number;
  alternate: boolean;
  height: number;
}

/** How the recorder reads the pane; tmux in production, a model in tests. */
export interface PaneSource {
  info(): Promise<PaneInfo | null>;
  /** The visible screen, one string per row. */
  screen(): Promise<string[] | null>;
  /** The last `count` rows of scrollback, oldest first. */
  history(count: number): Promise<string[] | null>;
}

export interface RecorderState {
  normal?: { historySize: number; rows: string[]; anchor: string[] };
  alternate?: { rows: string[] };
}

export interface RecordResult {
  /** New lines for the event log, in order, blank and spinner rows dropped. */
  events: string[];
  state: RecorderState;
}

/** Rows kept as the anchor that finds growth in a full history. */
export const ANCHOR_ROWS = 32;

function row(raw: string): string {
  return stripAnsi(raw).replace(/\s+$/, '');
}

function recordable(rows: string[]): string[] {
  return rows.filter((l) => l.length > 0 && !SPINNER_ONLY.test(l.trim()));
}

function fit(rows: string[], height: number): string[] {
  const out = rows.slice(0, height).map(row);
  while (out.length < height) out.push('');
  return out;
}

/** Rows of `prev` up to and including its last one with content. */
function contentRows(prev: string[]): number {
  for (let i = prev.length - 1; i >= 0; i--) if (prev[i]!.length > 0) return i + 1;
  return 0;
}

/**
 * The rows of `now` that are new or changed, given that the screen scrolled
 * by `shift` rows since `prev`: row `i` now was row `i + shift` then.
 */
function changedRows(prev: string[], now: string[], shift: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < now.length; i++) {
    const before = i + shift < prev.length ? prev[i + shift] : undefined;
    if (now[i] !== before) out.push(now[i]!);
  }
  return recordable(out);
}

/** The shift that lines up the most non-blank rows; the screen height if none do. */
function bestShift(prev: string[], now: string[]): number {
  let best = now.length;
  let bestMatches = 0;
  for (let shift = 0; shift < prev.length; shift++) {
    let matches = 0;
    for (let i = 0; i + shift < prev.length && i < now.length; i++) {
      if (now[i]!.length > 0 && now[i] === prev[i + shift]) matches += 1;
    }
    if (matches > bestMatches) { best = shift; bestMatches = matches; }
  }
  return best;
}

/** Latest start of `anchor` inside `rows`, or -1. */
function lastIndexOfBlock(rows: string[], anchor: string[]): number {
  for (let j = rows.length - anchor.length; j >= 0; j--) {
    let hit = true;
    for (let k = 0; k < anchor.length; k++) {
      if (rows[j + k] !== anchor[k]) { hit = false; break; }
    }
    if (hit) return j;
  }
  return -1;
}

/**
 * Rows that entered a full history since `anchor` was its tail. Searched in
 * growing windows, so the usual answer — nothing, or a few rows — costs one
 * small capture rather than the whole history.
 */
async function growthAtLimit(source: PaneSource, info: PaneInfo, anchor: string[]): Promise<number | null> {
  if (anchor.length === 0) return info.historySize;
  for (let n = Math.min(info.historySize, 256); ; n = Math.min(info.historySize, n * 4)) {
    const rows = await source.history(n);
    if (rows === null) return null;
    const tail = rows.map(row);
    const j = lastIndexOfBlock(tail, anchor);
    if (j !== -1) return tail.length - (j + anchor.length);
    if (n >= info.historySize) return info.historySize;
  }
}

async function tail(source: PaneSource, count: number): Promise<string[] | null> {
  if (count <= 0) return [];
  const rows = await source.history(count);
  return rows === null ? null : rows.map(row).slice(-count);
}

function sameInfo(a: PaneInfo, b: PaneInfo): boolean {
  return a.historySize === b.historySize && a.alternate === b.alternate && a.height === b.height;
}

/**
 * One observation: the lines to append to the event log, and the state to
 * keep for the next. `null` when tmux could not be read consistently, in
 * which case nothing is recorded and the previous state stands.
 *
 * `legacy` is the visible-pane snapshot of a run recorded before this
 * existed: its history was never tracked, so it is not backfilled — that
 * would record again everything the old diff already recorded — and the
 * screen is diffed against the old snapshot the old way.
 */
export async function recordPane(
  source: PaneSource,
  state: RecorderState | undefined,
  legacy?: { snapshot: string[]; diff: (prev: string[], next: string[]) => string[] },
): Promise<RecordResult | null> {
  // tmux is read in several calls; output landing between them would make
  // the history count and the rows disagree. Re-read until the pane held
  // still across the whole observation.
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await source.info();
    const raw = info === null ? null : await source.screen();
    if (info === null || raw === null) return null;
    const rows = fit(raw, info.height);

    let events: string[];
    let next: RecorderState;
    if (info.alternate) {
      const prev = state?.alternate?.rows;
      events = prev === undefined ? recordable(rows) : changedRows(prev, rows, bestShift(prev, rows));
      next = { ...state, alternate: { rows } };
    } else if (state?.normal === undefined && legacy !== undefined) {
      events = legacy.diff(legacy.snapshot, recordable(rows));
      const anchor = await tail(source, Math.min(info.historySize, ANCHOR_ROWS));
      if (anchor === null) return null;
      next = { normal: { historySize: info.historySize, rows, anchor } };
    } else {
      const prev = state?.normal;
      // Rows that entered history since the previous observation.
      let growth: number | null;
      if (prev === undefined) growth = info.historySize;
      else if (info.historySize >= info.historyLimit) growth = await growthAtLimit(source, info, prev.anchor);
      else if (info.historySize < prev.historySize) growth = info.historySize; // history was cleared
      else growth = info.historySize - prev.historySize;
      if (growth === null) return null;

      // Of those, the ones the previous screen never showed with content.
      const seen = prev === undefined ? 0 : contentRows(prev.rows);
      const unseen = await tail(source, Math.min(info.historySize, Math.max(0, growth - seen)));
      if (unseen === null) return null;
      const screen = prev === undefined ? recordable(rows) : changedRows(prev.rows, rows, growth);

      const anchor = growth === 0 && prev !== undefined
        ? prev.anchor
        : await tail(source, Math.min(info.historySize, ANCHOR_ROWS));
      if (anchor === null) return null;
      events = [...recordable(unseen), ...screen];
      next = { ...state, normal: { historySize: info.historySize, rows, anchor } };
    }

    const after = await source.info();
    if (after !== null && sameInfo(info, after)) return { events, state: next };
  }
  return null;
}
