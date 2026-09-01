import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectInstaller, installLitellm, litellmStatus, managedLitellmPath, pythonInRange,
  venvDir, LITELLM_VERSION, PYTHON_RANGE,
} from '../../src/native/litellm-venv.js';

const home = (tag: string) => mkdtempSync(join(tmpdir(), `sonata-${tag}-`));

/** The venv a real `create` would leave behind, so `install` has somewhere to write. */
const fakeVenv = (dir: string) => mkdirSync(join(dir, 'bin'), { recursive: true });

/** An installed venv, as `litellmStatus` expects to find one. */
function installedVenv(h: string, pin: string | undefined): void {
  mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
  writeFileSync(managedLitellmPath(h), '#!/bin/sh\n', { mode: 0o755 });
  if (pin !== undefined) writeFileSync(join(venvDir(h), '.sonata-pin'), pin);
}

describe('pythonInRange', () => {
  it('enforces the ceiling as well as the floor', () => {
    // LiteLLM declares <3.15,>=3.10. A "3.10 or newer" check passes 3.15 and
    // then fails inside the resolver, which is a much worse error to read.
    expect(pythonInRange('3.9.6')).toBe(false);
    expect(pythonInRange('3.10.0')).toBe(true);
    expect(pythonInRange('3.14.1')).toBe(true);
    expect(pythonInRange('3.15.0')).toBe(false);
  });

  it('rejects a version it cannot parse rather than guessing', () => {
    expect(pythonInRange('')).toBe(false);
    expect(pythonInRange('Python 3.12.0')).toBe(false);
  });

  it('spells the range the way pip and uv do', () => {
    expect(PYTHON_RANGE).toBe('>=3.10,<3.15');
  });
});

describe('litellmStatus', () => {
  it('is not-required when no gateway needs litellm', () => {
    // Not a fault: for a config nothing routes through litellm, absence is
    // correct, and reporting `missing` would send the user to install it.
    expect(litellmStatus(home('nr'), false).state).toBe('not-required');
  });

  it('is missing when required and absent', () => {
    expect(litellmStatus(home('miss'), true).state).toBe('missing');
  });

  it('is stale when the pin disagrees with this sonata', () => {
    const h = home('stale');
    installedVenv(h, '1.0.0');
    const s = litellmStatus(h, true);
    expect(s.state).toBe('stale');
    expect(s).toMatchObject({ installed: '1.0.0', expected: LITELLM_VERSION });
  });

  it('is ok when the pin matches', () => {
    const h = home('ok');
    installedVenv(h, LITELLM_VERSION);
    expect(litellmStatus(h, true)).toMatchObject({
      state: 'ok', version: LITELLM_VERSION, path: managedLitellmPath(h),
    });
  });

  it('is broken when the venv exists but the binary does not', () => {
    const h = home('broken');
    mkdirSync(venvDir(h), { recursive: true });
    expect(litellmStatus(h, true).state).toBe('broken');
  });

  it('is broken when the binary exists but nothing records what it is', () => {
    // A venv sonata did not write, or one from before the pin existed: its
    // version is unknown, and "unknown" is not the same as "current".
    const h = home('nopin');
    installedVenv(h, undefined);
    expect(litellmStatus(h, true).state).toBe('broken');
  });

  it('is no-python when nothing on the machine could build the venv', () => {
    // Distinguished from `missing` so doctor can say "install uv" — which can
    // fetch a conforming interpreter — rather than "install a different Python".
    const s = litellmStatus(home('nopy'), true, {
      which: () => undefined, pythonVersion: () => '3.9.6',
    });
    expect(s).toMatchObject({ state: 'no-python', pythonVersion: '3.9.6' });
  });

  it('is still missing when a usable installer exists', () => {
    expect(litellmStatus(home('canbuild'), true, {
      which: (b) => (b === 'uv' ? '/bin/uv' : undefined), pythonVersion: () => undefined,
    }).state).toBe('missing');
  });
});

describe('detectInstaller', () => {
  it('prefers uv when present', () => {
    expect(detectInstaller({
      which: (b) => (b === 'uv' ? '/bin/uv' : undefined), pythonVersion: () => '3.12.0',
    })?.kind).toBe('uv');
  });

  it('prefers uv even when python3 is out of range — uv can fetch one', () => {
    expect(detectInstaller({
      which: (b) => (b === 'uv' ? '/bin/uv' : undefined), pythonVersion: () => '3.9.6',
    })?.kind).toBe('uv');
  });

  it('falls back to python3 when uv is absent', () => {
    expect(detectInstaller({
      which: (b) => (b === 'python3' ? '/bin/python3' : undefined), pythonVersion: () => '3.12.0',
    })?.kind).toBe('python3');
  });

  it('returns undefined when python3 is out of range and uv is absent', () => {
    // uv could fetch a conforming interpreter; python3 alone cannot.
    expect(detectInstaller({
      which: (b) => (b === 'python3' ? '/bin/python3' : undefined), pythonVersion: () => '3.9.6',
    })).toBeUndefined();
  });
});

// The whole mitigation for accepting two install paths is that they answer to
// identical assertions. The python3 path is the one most users take and the one
// least exercised during development, so a test passing for only uv is not done.
describe.each([
  ['uv', (b: string) => (b === 'uv' ? '/bin/uv' : undefined)],
  ['python3', (b: string) => (b === 'python3' ? '/bin/python3' : undefined)],
])('installLitellm via %s', (_kind, which) => {
  it('builds at the final path and records the pin', async () => {
    const h = home('inst');
    const calls: string[] = [];
    await installLitellm(h, {
      which,
      pythonVersion: () => '3.12.0',
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        // Whatever the real tool would have produced. Derived from `home`
        // rather than scraped out of `args`, so this stub does not quietly
        // stop creating anything when an argument order changes.
        fakeVenv(venvDir(h));
      },
    });
    // The venv must be BUILT where it will live. A venv's console scripts
    // carry an absolute shebang and `pyvenv.cfg` records its creation path, so
    // one assembled elsewhere and renamed into place is dead on arrival —
    // measured live, with `bad interpreter: …/litellm.installing/bin/python`.
    expect(calls.some((c) => c.includes(venvDir(h)))).toBe(true);
    expect(calls.some((c) => c.includes('.installing'))).toBe(false);
    expect(calls.some((c) => c.includes(`litellm[proxy]==${LITELLM_VERSION}`))).toBe(true);
    expect(readFileSync(join(venvDir(h), '.sonata-pin'), 'utf8')).toBe(LITELLM_VERSION);
  });

  it('leaves no directory behind when the install fails', async () => {
    const h = home('fail');
    await expect(installLitellm(h, {
      which,
      pythonVersion: () => '3.12.0',
      run: async (_cmd, args) => {
        fakeVenv(venvDir(h));
        if (args.some((a) => a.includes('litellm[proxy]'))) throw new Error('network down');
      },
    })).rejects.toThrow(/network down/);
    // `missing` has a working repair; `broken` invites debugging a half-install.
    expect(existsSync(venvDir(h))).toBe(false);
    expect(existsSync(`${venvDir(h)}.previous`)).toBe(false);
    expect(litellmStatus(h, true).state).toBe('missing');
  });

  it('restores the previous working venv when a reinstall fails', async () => {
    // Building at the final path means the old venv has to be moved aside
    // first, so the failure path has to put it back — otherwise a failed
    // upgrade costs the user the working install they already had.
    const h = home('keep');
    installedVenv(h, LITELLM_VERSION);
    await expect(installLitellm(h, {
      which,
      pythonVersion: () => '3.12.0',
      run: async () => { throw new Error('network down'); },
    })).rejects.toThrow(/network down/);
    expect(litellmStatus(h, true).state).toBe('ok');
    expect(existsSync(`${venvDir(h)}.previous`)).toBe(false);
  });
});

describe('installLitellm without an installer', () => {
  it('names the range rather than just failing', async () => {
    await expect(installLitellm(home('norun'), {
      which: () => undefined, pythonVersion: () => '3.9.6', run: async () => {},
    })).rejects.toThrow(/>=3\.10,<3\.15/);
  });
});

describe('litellmStatus — a venv that was moved', () => {
  it('is broken when the binary’s interpreter does not exist', async () => {
    // The defect this exists for, reproduced: a venv built in one directory
    // and renamed into another has a `bin/litellm` that exists and cannot run,
    // because its shebang is absolute. Reporting `ok` for that is confidently
    // wrong, which is worse than `missing` — `missing` has a repair.
    const h = home('moved');
    mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
    writeFileSync(
      managedLitellmPath(h),
      `#!${join(venvDir(h))}.installing/bin/python3.13\n# -*- coding: utf-8 -*-\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(venvDir(h), '.sonata-pin'), LITELLM_VERSION);
    const s = litellmStatus(h, true);
    expect(s.state).toBe('broken');
    expect(s).toMatchObject({ reason: expect.stringContaining('interpreter') });
  });

  it('is ok when the interpreter it names is really there', async () => {
    const h = home('intact');
    mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
    writeFileSync(join(venvDir(h), 'bin', 'python3.13'), '', { mode: 0o755 });
    writeFileSync(
      managedLitellmPath(h), `#!${join(venvDir(h), 'bin', 'python3.13')}\n`, { mode: 0o755 },
    );
    writeFileSync(join(venvDir(h), '.sonata-pin'), LITELLM_VERSION);
    expect(litellmStatus(h, true).state).toBe('ok');
  });

  it('does not judge a PATH-resolved shebang it cannot check', () => {
    // `#!/usr/bin/env python` names no literal path, so there is nothing to
    // test for — refusing it would report `broken` for a working venv.
    const h = home('env-shebang');
    mkdirSync(join(venvDir(h), 'bin'), { recursive: true });
    writeFileSync(managedLitellmPath(h), '#!/usr/bin/env python\n', { mode: 0o755 });
    writeFileSync(join(venvDir(h), '.sonata-pin'), LITELLM_VERSION);
    expect(litellmStatus(h, true).state).toBe('ok');
  });
});
