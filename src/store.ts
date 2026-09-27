import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, readdirSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { reportPathFor } from './report-contract.js';
import type { RunMeta } from './types.js';

export function sonataDir(cwd: string): string {
  return join(cwd, '.sonata');
}

/**
 * What a run id looks like: lowercase hex, 6 characters for runs made before
 * ids grew, 12 since. Checked by `runDir`, which every path into a run goes
 * through, because every CLI entry (`log`, `tail`, `wait`, `approve`,
 * `verify`) takes the id raw — and `../../x` is a path segment too.
 */
export const RUN_ID_PATTERN = /^[0-9a-f]{6,32}$/;

export function isRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function runDir(cwd: string, id: string): string {
  if (!isRunId(id)) {
    throw new Error(`sonata: "${id}" is not a sonata run id (expected lowercase hex, as \`sonata runs\` lists)`);
  }
  return join(sonataDir(cwd), 'runs', id);
}

/**
 * Six bytes. Three collided at about n^2/33.5M over a project's lifetime —
 * run directories are never deleted — and a collision reused a finished run's
 * directory, whose exit sentinel and report.md then read as the new run's
 * instant, trusted result. `createRun` refuses to reuse one regardless.
 */
export function newRunId(): string {
  return randomBytes(6).toString('hex');
}

export type RunInit = Omit<RunMeta, 'id' | 'session' | 'cwd'>;

export function createRun(cwd: string, init: RunInit, nextId: () => string = newRunId): RunMeta {
  mkdirSync(join(sonataDir(cwd), 'runs'), { recursive: true });
  // The leaf is created without `recursive`, so an existing directory is an
  // error rather than silently adopted with another run's files in it.
  for (let attempt = 0; ; attempt++) {
    const id = nextId();
    try {
      mkdirSync(runDir(cwd, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 10) continue;
      throw err;
    }
    const meta: RunMeta = { ...init, id, session: `sonata-${id}`, cwd };
    writeMeta(cwd, meta);
    return meta;
  }
}

export function writeMeta(cwd: string, meta: RunMeta): void {
  writeFileSync(join(runDir(cwd, meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}

export function readMeta(cwd: string, id: string): RunMeta {
  return JSON.parse(readFileSync(join(runDir(cwd, id), 'meta.json'), 'utf8')) as RunMeta;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function readExit(cwd: string, id: string): number | null {
  const raw = readIfExists(join(runDir(cwd, id), 'exit'));
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * The model's report, or null when there is none worth the name.
 *
 * An empty or whitespace-only file counts as none. A model can create
 * report.md and never fill it, and the codex/reasonix quit watchers fire on
 * the file merely existing — so a zero-length file is a real outcome, and read
 * as "" it was trusted as a finished report while hiding the harness's own
 * fallback file behind it.
 */
export function readReport(cwd: string, id: string): string | null {
  const raw = readIfExists(reportPathFor(runDir(cwd, id)));
  return raw === null || raw.trim().length === 0 ? null : raw;
}

export function readAnsweredPrompt(cwd: string, id: string): string | null {
  return readIfExists(join(runDir(cwd, id), 'answered-prompt'));
}

export function writeAnsweredPrompt(cwd: string, id: string, prompt: string): void {
  writeFileSync(join(runDir(cwd, id), 'answered-prompt'), prompt);
}

export function clearAnsweredPrompt(cwd: string, id: string): void {
  const path = join(runDir(cwd, id), 'answered-prompt');
  if (existsSync(path)) unlinkSync(path);
}

export function readCursor(cwd: string, id: string): number {
  const raw = readIfExists(join(runDir(cwd, id), 'cursor'));
  return raw === null ? 0 : Number.parseInt(raw.trim(), 10) || 0;
}

export function writeCursor(cwd: string, id: string, n: number): void {
  writeFileSync(join(runDir(cwd, id), 'cursor'), String(n));
}

export function appendEvents(cwd: string, id: string, lines: string[]): void {
  if (lines.length === 0) return;
  appendFileSync(join(runDir(cwd, id), 'events.jsonl'), lines.map((l) => `${l}\n`).join(''));
}

export function readEvents(cwd: string, id: string): string[] {
  const raw = readIfExists(join(runDir(cwd, id), 'events.jsonl'));
  return raw === null ? [] : raw.split('\n').filter(Boolean);
}

export function listRuns(cwd: string): string[] {
  const dir = join(sonataDir(cwd), 'runs');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
