/**
 * Small, harness-agnostic helpers the adapters' usage readers share.
 *
 * What each harness stores, and where, stays in its adapter; this file only
 * knows how to read a JSON-lines file without throwing and how to compare
 * paths and times the same way everywhere.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { UsageTokens } from '../native/usage.js';

/** Every parseable line of a JSON-lines file; a torn or bad line is skipped. */
export function readJsonl(path: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A harness mid-write, or a line sonata cannot read — never a reason to fail.
    }
  }
  return out;
}

/** The canonical spelling of a path; the original when it cannot be resolved. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A finite, non-negative count, or 0. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A finite, non-negative money amount, or undefined — never a made-up zero. */
export function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** A timestamp (ISO string, or epoch ms) as epoch ms, or undefined. */
export function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Slack on each side of a run's window. A harness stamps its session a moment
 * after sonata records the launch, and writes its last usage a moment before
 * the exit sentinel lands; clocks on one machine agree, so seconds suffice.
 */
export const WINDOW_SLACK_MS = 5_000;

export function inWindow(ms: number | undefined, startMs: number, endMs: number): boolean {
  return ms !== undefined && ms >= startMs - WINDOW_SLACK_MS && ms <= endMs + WINDOW_SLACK_MS;
}

/** Files directly inside `dir` whose name passes `keep`; none when it is unreadable. */
export function filesIn(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter(keep).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

export function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

export function sumTokens(parts: readonly UsageTokens[]): UsageTokens {
  return parts.reduce(
    (acc, t) => ({
      input: acc.input + t.input,
      output: acc.output + t.output,
      cacheRead: acc.cacheRead + t.cacheRead,
      cacheCreation: acc.cacheCreation + t.cacheCreation,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

/** The ambiguity answer every reader gives, worded once. */
export function ambiguous(harness: string, found: number): string {
  return `${found} ${harness} sessions ran in this directory during the run, so its usage cannot be told apart `
    + '(concurrent dispatches to one harness in one directory are never guessed between)';
}

/**
 * Narrow several candidate sessions to the ones whose stored prompt carries
 * this run's marker (`runMarker`, the run directory).
 *
 * Only ever narrows: a lone candidate is kept without looking, so a run from
 * before the marker existed still resolves, and when no candidate carries the
 * marker all are kept — the caller then reports the ambiguity rather than
 * picking one. The needle is the run's own directory, unique to it, so a
 * match is identification, not a guess.
 */
export function narrowByMarker<T>(candidates: readonly T[], carries: (candidate: T) => boolean): T[] {
  if (candidates.length <= 1) return [...candidates];
  const marked = candidates.filter(carries);
  return marked.length > 0 ? marked : [...candidates];
}

/** Whether a file's text contains `needle`; false when it cannot be read. */
export function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}
