import { describe, it, expect } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokedAsProgram } from '../src/cli.js';

/**
 * `sonata` on PATH is a symlink into node_modules, so node sets argv[1] to the
 * symlink while import.meta.url resolves to the file it points at. A raw string
 * comparison never matches, and every command exits 0 having done nothing.
 *
 * That shipped: a guard was added so a test could import cli.ts without running
 * the CLI, and it killed the CLI instead. Nothing caught it, because every test
 * imports the module — the path the guard gets right. These tests cover the
 * path it got wrong.
 */
describe('invokedAsProgram', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonata-cli-'));
  const real = join(dir, 'cli.js');
  writeFileSync(real, '// entry point\n');
  const link = join(dir, 'sonata');
  symlinkSync(real, link);

  it('runs when invoked through a symlink, which is how npm link installs it', () => {
    expect(invokedAsProgram(link, pathToFileURL(real).href)).toBe(true);
  });

  it('runs when invoked by its real path', () => {
    expect(invokedAsProgram(real, pathToFileURL(real).href)).toBe(true);
  });

  it('does not run when some other program is the entry point', () => {
    const other = join(dir, 'other.js');
    writeFileSync(other, '// not the cli\n');
    expect(invokedAsProgram(other, pathToFileURL(real).href)).toBe(false);
  });

  // This is the case the guard exists for: a test importing the module.
  it('does not run when there is no entry point at all', () => {
    expect(invokedAsProgram(undefined, pathToFileURL(real).href)).toBe(false);
  });

  it('does not run when the path cannot be resolved', () => {
    expect(invokedAsProgram(join(dir, 'gone'), pathToFileURL(real).href)).toBe(false);
  });
});
