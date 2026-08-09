import { randomBytes } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  appendFileSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RunMeta } from './types.js';

export function sonataDir(cwd: string): string {
  return join(cwd, '.sonata');
}

export function runDir(cwd: string, id: string): string {
  return join(sonataDir(cwd), 'runs', id);
}

export function newRunId(): string {
  return randomBytes(3).toString('hex');
}

export type RunInit = Omit<RunMeta, 'id' | 'session' | 'cwd'>;

export function createRun(cwd: string, init: RunInit): RunMeta {
  const id = newRunId();
  const meta: RunMeta = { ...init, id, session: `sonata-${id}`, cwd };
  mkdirSync(runDir(cwd, id), { recursive: true });
  writeMeta(cwd, meta);
  return meta;
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

export function readReport(cwd: string, id: string): string | null {
  return readIfExists(join(runDir(cwd, id), 'report.md'));
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
