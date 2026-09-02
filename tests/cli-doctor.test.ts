import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { cmdDoctor, type Check } from '../src/commands/doctor.js';

vi.mock('../src/commands/doctor.js', async () => {
  const actual = await vi.importActual<typeof import('../src/commands/doctor.js')>(
    '../src/commands/doctor.js',
  );
  return { ...actual, cmdDoctor: vi.fn() };
});

const cmdDoctorMock = vi.mocked(cmdDoctor);

describe('sonata doctor CLI wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('--json prints the checks as a parseable object and preserves the exit code', async () => {
    const checks: Check[] = [
      { name: 'tmux', ok: true, detail: '3.4' },
      { name: 'sonata.toml', ok: false, detail: 'not found' },
    ];
    cmdDoctorMock.mockResolvedValue({ ok: false, checks });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['doctor', '--json']);
    expect(code).toBe(1);
    const out = spy.mock.calls.map(([l]) => String(l)).join('');
    expect(JSON.parse(out)).toEqual({ ok: false, checks });
  });

  it('without --json prints the human-readable lines, not JSON', async () => {
    cmdDoctorMock.mockResolvedValue({
      ok: true,
      checks: [{ name: 'tmux', ok: true, detail: '3.4' }],
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await main(['doctor']);
    expect(code).toBe(0);
    const all = spy.mock.calls.map(([l]) => String(l)).join('\n');
    expect(all).toContain('ok   tmux: 3.4');
    expect(() => JSON.parse(all)).toThrow();
  });

  it('rejects an unrecognized flag with the parseArgs unknown-option error', async () => {
    cmdDoctorMock.mockResolvedValue({ ok: true, checks: [] });

    const err = await main(['doctor', '--bogus']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(`Unknown option '--bogus'`);
  });
});
