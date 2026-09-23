import { describe, expect, it } from 'vitest';
import { onAltScreen } from '../../src/tui-ink/alt-screen.js';

const recorder = () => {
  const writes: string[] = [];
  return { writes, write: (s: string) => { writes.push(s); return true; } };
};

describe('onAltScreen', () => {
  it('enters before the body and leaves after it', async () => {
    const out = recorder();
    await onAltScreen(async () => { out.write('body'); }, out);
    expect(out.writes).toEqual(['\u001b[?1049h', 'body', '\u001b[?1049l']);
  });

  it('restores the terminal when the body throws', async () => {
    // The whole reason this is a `finally`. A skipped restore leaves the user
    // looking at a blank buffer with no prompt, which reads as a crashed
    // terminal rather than a crashed program — strictly worse than the
    // leftover frame it replaced.
    const out = recorder();
    await expect(onAltScreen(async () => { throw new Error('boom'); }, out)).rejects.toThrow('boom');
    expect(out.writes).toEqual(['\u001b[?1049h', '\u001b[?1049l']);
  });

  it('passes the body result through', async () => {
    expect(await onAltScreen(async () => 7, recorder())).toBe(7);
  });
});
