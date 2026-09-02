# Own the LiteLLM dependency (roadmap item 09)

> **Superseded by [`2026-09-01-litellm-strategy-design.md`](2026-09-01-litellm-strategy-design.md).**
> Kept as the design-history record: its three decisions and both probe
> findings are carried forward unchanged. What changed is the frame — a probe
> the same day showed that a gateway speaking Anthropic natively needs no
> LiteLLM at all, so the managed venv became a prerequisite of *OpenAI-shaped
> gateways* rather than of the native path. Read the successor for the
> current design.

The native path is sonata's default, and it does not work until the user has
run `pip install 'litellm[proxy]'` by hand. That is the first wall a stranger
hits after `npm install -g @zhihaohong52/sonata`, and it is the last item
standing between 0.4 and its stated goal — "let strangers in".

This is the design for making sonata own that dependency: a pinned virtual
environment sonata creates, checks and repairs, without replacing LiteLLM or
vendoring it.

## What is wrong today

`findLitellm()` (`src/native/litellm.ts`) is one line:

```ts
execFileSync('which', ['litellm'], { encoding: 'utf8' }).trim() || null
```

`sonata serve` then spawns the bare name (`src/commands/serve.ts:244`), and
`sonata doctor` reports found-or-not with `pip install 'litellm[proxy]'` as the
fix. Three consequences:

- **The version is whatever the user happens to have.** LiteLLM has broken
  sonata twice from upstream already — the chatgpt provider emitting a
  rejected `role: system` (BerriAI/litellm#22968, fix closed unmerged), and
  the Responses-API transformation raising on `output: []` under concurrent
  load. Both are version-specific, and neither is diagnosable if sonata does
  not know which version it is talking to.
- **`which litellm` does not imply a usable LiteLLM.** Measured on the
  development machine: `which litellm` resolves, and its shebang is
  `#!/Library/Frameworks/Python.framework/Versions/3.13/bin/python3` — a
  different interpreter from the `python3` on PATH, under which
  `import litellm` fails outright. A PATH hit says a script exists, not that
  an importable, runnable LiteLLM does.
- **The failure is late and unhelpful.** A missing LiteLLM surfaces when
  `serve` cannot spawn it, which is often from a SessionStart hook running
  headless — so the user sees a router that did not come up, not a missing
  dependency.

## Decisions

Three, taken before design:

1. **The managed venv always wins.** sonata runs the version sonata was
   tested against; a PATH `litellm` is reported by `doctor` as information
   and never used. The cost is a second copy on disk (~100 MB). The benefit
   is that "works on my machine" stops being structurally possible, which
   matters more for a tool whose failures already look like model failures.
2. **`init` installs, `doctor` repairs, `serve` never installs.** Both of the
   first two are interactive, foregrounded moments where a multi-minute
   install and its output make sense. `serve` refuses fast and names the
   command, because `hooks/ensure-serve.mjs` starts it headless from a
   SessionStart hook, where a silent 3-minute pip install is
   indistinguishable from a hang.
3. **`uv` when present, `python3 -m venv` otherwise.** uv installs in seconds
   rather than minutes and can fetch a suitable Python itself, which is the
   only thing that rescues a user whose `python3` is outside LiteLLM's
   supported range. The cost is two install paths, and the mitigation is in
   the design below: they are one interface with one test suite.

## Python range: a ceiling as well as a floor

LiteLLM declares `requires_python: <3.15,>=3.10` (PyPI, checked 2026-09-01,
latest 1.99.0). A check written as "3.10 or newer" would pass a user on 3.15
and fail at install with a resolver error. Both bounds are enforced, and the
message names the range rather than the floor.

This is also the one case where the two installer paths differ in capability,
not just speed: `uv` can fetch a conforming interpreter, so an out-of-range
system Python is recoverable there and fatal on the `python3` path. The status
value distinguishes them so `doctor` can say "install uv" rather than "install
a different Python", which is much cheaper advice.

## Architecture

One new module, `src/native/litellm-venv.ts`. `serve`, `doctor` and `init`
only ask it questions; nothing else knows the venv exists.

```
~/.config/sonata/litellm/              the venv
~/.config/sonata/litellm/bin/litellm   what serve spawns
~/.config/sonata/litellm/.sonata-pin   the version sonata installed
```

### The pin

`LITELLM_VERSION` is a source constant, the way `OPENCODE_RANGE` already is,
and is written into `.sonata-pin` at install time. Recording it in the venv is
what lets `status()` tell *installed and current* from *installed but from an
older sonata* — a distinction that exists precisely because upstream changes
have broken this integration before, and because a user who upgrades sonata
should not silently keep an older LiteLLM.

Pinned exactly (`==`), not a range. A range would reintroduce the problem this
item exists to remove.

**The initial pin is `1.98.0`**, not the newest release. It is the version
every LiteLLM behaviour recorded in `CLAUDE.md` was measured against — the
`supports_system_message: false` declaration for codex-oauth, the
`output: []` 500-to-529 rewrite, the streaming cost-header behaviour. Pinning
to 1.99.0 on the day this ships would mean shipping a version against which
none of those findings has been re-verified. Moving the pin is a deliberate,
separately-verified change, which is the point of having one.

### Status is a value, not a boolean

```ts
type LitellmStatus =
  | { state: 'ok'; version: string; path: string }
  | { state: 'stale'; installed: string; expected: string; path: string }
  | { state: 'missing' }
  | { state: 'broken'; reason: string }        // venv exists, binary absent or not executable
  // Nothing to build with. Reachable only when uv is absent: uv can fetch a
  // conforming interpreter itself, so its presence always makes the venv
  // buildable. `pythonVersion` is set when a python3 exists but is outside
  // LiteLLM's range, which is the case where "install uv" is the cheap fix.
  | { state: 'no-python'; pythonVersion?: string };
```

`doctor` reports which one, and the repair differs per state — the same
correction already made to the tier-routing check, where five distinct causes
printed one sentence naming only the fix.

### One installer interface, two implementations

```ts
interface Installer {
  readonly kind: 'uv' | 'python3';
  create(venv: string): Promise<void>;
  install(venv: string, spec: string): Promise<void>;
}
```

`detectInstaller(deps)` returns the uv implementation when `uv` is on PATH,
otherwise the python3 one when a conforming `python3` exists, otherwise
`no-python`.

**Both implementations run against the same test suite**, with the subprocess
as a seam (`deps.run`). This is the whole mitigation for accepting two paths:
the `python3` path is the one most users take and the one least likely to be
exercised during development, so a test that passes for only one
implementation is not done.

### Atomic install

Build into a temp directory and move into place only on success. A network
failure part-way through must leave *no* venv rather than a partial one —
`status()` can then say `missing`, which has a working repair, instead of
`broken`, which invites the user to debug a half-installed environment.

## Integration points

Three small edits plus one new command.

- **`src/commands/serve.ts:244`** spawns the managed path instead of the bare
  name, and refuses with the repair command when status is not `ok`. It never
  installs.
- **`src/commands/doctor.ts:311`** reports the status value. A PATH `litellm`
  is mentioned as information, explicitly noting it is not what sonata runs.
- **`sonata init`** gains an install step, offered rather than forced, with the
  expected duration stated (uv: seconds; pip: minutes).
- **`sonata litellm install | status`** is the command both point at, and the
  one a user runs directly.

`findLitellm()` stays, narrowed to what it is actually good for: telling
`doctor` that an unrelated LiteLLM exists on PATH.

## Testing

- `detectInstaller` selection: uv present, uv absent with good python3, uv
  absent with out-of-range python3, neither. Pure, given the `run` seam.
- Python range: 3.9 rejected, 3.10 accepted, 3.14 accepted, 3.15 rejected —
  the ceiling has its own case, because a floor-only check passes 3.15.
- `status()` against fixture directories for each of the five states,
  including `stale` (pin file disagrees with `LITELLM_VERSION`).
- Both `Installer` implementations against the same assertions.
- Atomicity: a failing `install` leaves no venv directory behind.
- `serve` refuses rather than installing when status is not `ok`.

The real network install is verified once, live, against a scratch `HOME` —
not in CI, which should not depend on PyPI.

## Out of scope

- **Automatic upgrades.** `status()` reports `stale`; acting on it is the
  user's call. A tool that silently swaps the inference proxy underneath a
  running session is the failure this item exists to prevent, inverted.
- **Vendoring or replacing LiteLLM.** The roadmap's wording is deliberate:
  manage it, don't replace it.
- **Installing Python.** uv may fetch one as a side effect of its own
  operation; sonata never does. `python3` joins tmux as a named prerequisite,
  which the README's Requirements section must state.
