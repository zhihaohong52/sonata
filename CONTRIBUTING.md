# Contributing

Issues and pull requests are welcome. Sonata is in public beta: the most useful
contributions right now are bug reports from real setups — a harness version,
a gateway or a model sonata has not met yet.

## Reporting a bug

Run `sonata doctor` and include its output, plus `sonata --version`. For a
native-path problem add the relevant lines of `sonata status`; for a dispatch
problem, `sonata log <id>`. Strip any key that appears — sonata never prints
one itself, but a harness log might. Security issues go through
[SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requires Node 22+ and tmux.

```bash
git clone https://github.com/zhihaohong52/sonata.git
cd sonata
npm install
npm run build
npm link          # puts `sonata` on your PATH
```

`sonata` on your PATH runs `dist/`, not `src/` — after changing anything under
`src/`, run `npm run build`, or the command keeps its old behaviour.
`sonata --version` on a local build reports `<version>+dev.<stamp>` and the
commit, which tells you which install answered.

```bash
npm test          # vitest; needs tmux, no API keys
npm run typecheck
```

The suite runs against a **fake harness** — a scripted binary replaying a
normal run, a crash, a captured approval prompt, a hang the watchdog must kill,
a clean exit with no report, and a harness-written report — on a private tmux
server of its own, so it needs no API keys, no harness installed, and never
touches your own tmux sessions. Run one suite at a time.

## Pull requests

- Run `npm test` and `npm run typecheck` first; CI runs both on Linux with
  tmux installed.
- Add tests for behaviour you change. A new `sonata.toml` key needs a
  round-trip test through `parseConfig`: `sonata init` rewrites the config and
  drops any key it does not write back.
- **Evidence over inference.** If a change depends on how a harness or gateway
  behaves, say how you verified it. A captured fixture in
  `tests/fixtures/panes/` beats a plausible regex.
- **Harness-specific knowledge stays inside its adapter** — never in the CLI
  or in `sonata dispatch`, which relays run state and never parses harness
  output.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user would notice.
- Close the issue you fix with `Closes #n` in the PR description.

Changes touching money (pricing, the usage ledger, `[budget]`), security,
routing or config parsing get the most scrutiny: those are the paths where a
plausible wrong value is worse than an error.

## Adding a harness

The adapter boundary is the extension point — see
[Adding a harness](docs/guide/adding-a-harness.md). Probe the real binary
before writing an adapter: every adapter bug found so far was invisible in
documentation and obvious on the first real run.

## Where things are

- [`docs/guide/`](docs/guide/) — user-facing reference.
- [`docs/internals/`](docs/internals/) — the maintainer's design record:
  read the matching page before changing the code it describes, because most
  of its rules exist because the obvious change was tried and broke something.
- [`docs/superpowers/`](docs/superpowers/) — every feature's design spec and
  implementation plan.
- [`CLAUDE.md`](CLAUDE.md) — the working rules, written for AI assistants but
  just as true for people.
