import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { main } from '../src/cli.js';

const manifestVersion = (): string =>
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('sonata --version', () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  afterEach(() => { lines.length = 0; });
  afterEach(() => spy.mockClear());

  // The point of the flag is answering "which sonata just ran", so the version
  // has to be the *running* build's, read from the manifest beside it rather
  // than baked in at some earlier moment.
  it('prints the version from the package manifest', async () => {
    expect(await main(['--version'])).toBe(0);
    expect(lines[0]).toBe(manifestVersion());
  });

  // `sonata` on PATH runs dist/, not src/. Two bugs in this repo's history were
  // "fixed" and still reproduced for exactly that reason, so the flag names the
  // install it resolved from.
  it('also prints the directory it resolved from', async () => {
    await main(['--version']);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/sonata/);
  });

  it('accepts -v and a bare `version` command', async () => {
    for (const argv of [['-v'], ['version']]) {
      lines.length = 0;
      expect(await main(argv)).toBe(0);
      expect(lines[0]).toBe(manifestVersion());
    }
  });

  it('does not treat --version as an unknown command', async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    await main(['--version']);
    expect(errors.join('\n')).not.toMatch(/unknown command/);
    errSpy.mockRestore();
  });
});
