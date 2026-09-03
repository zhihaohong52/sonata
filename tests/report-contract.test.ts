import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_FILENAME, reportPathFor } from '../src/report-contract.js';

const SRC = join(fileURLToPath(new URL('../src', import.meta.url)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('report contract', () => {
  it('builds the report path inside a run directory', () => {
    expect(reportPathFor('/runs/abc')).toBe(`/runs/abc/${REPORT_FILENAME}`);
  });

  it('is the only place in src/ that names the report file in code', () => {
    // The guard that makes this a manifest rather than a seventh copy. The
    // filename used to be a bare literal in run.ts (what the prompt asks for),
    // store.ts (what is read back), runs.ts (the existence check) and two
    // adapters' watcher loops — nothing forced them to agree. Disagreement is
    // silent in the worst direction: the model writes its report where it was
    // told, nothing reads it there, and the run is reported degraded despite
    // having succeeded.
    //
    // Prose mentions are fine and expected — adapters explain *why* a
    // configuration cannot write the file. Only executable references have to
    // come from here, so comment lines are stripped before matching.
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      if (path.endsWith(join('src', 'report-contract.ts'))) continue;
      const code = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
        })
        .join('\n');
      if (code.includes(REPORT_FILENAME)) offenders.push(path.slice(SRC.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
