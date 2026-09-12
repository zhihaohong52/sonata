# Troubleshooting

Start with `sonata doctor` — it checks tmux, each configured harness, its
version and auth, and the permission hook.

| Symptom | Cause |
|---|---|
| Agents don't appear in Claude Code | Run `sonata sync`; Claude Code picks up regenerated agents automatically. |
| `sonata: command not found` | The generated agents call `sonata` on your PATH. Install it with `npm install -g @zhihaohong52/sonata`, or run `npm link` in a clone if you are working on sonata itself. |
| Dispatch fails: "cannot ask for approval" | You are in `default` mode with opencode or pi, which cannot prompt. Switch to `acceptEdits`, use a codex or reasonix model, or dispatch a read-only role. |
| A tier agent errors with "all native routes … failed" | Every candidate for that tier failed. Run the `sonata dispatch --tier <role>-<tier>` command the error names, in Bash. |
| Every opencode/pi dispatch refuses | The permission hook is not installed, so sonata assumes `default`. Run `sonata init` and choose a hook scope. |
| A codex run sits in `PAUSED` at startup | Codex has not been trusted in this directory. Run `codex` there once and answer "Yes, continue". |
| A run reports `degraded` | The harness exited without writing a report; the text you get is scraped pane output. Treat it as untrustworthy. |
| A run never finishes | It is capped by `run_timeout_seconds`. Attach with `tmux attach -t sonata-<id>` to watch it. |
| `sonata doctor` says "config predates [tiers]" | Run `sonata init` — it migrates the config to `[models]`+`[tiers]`, carrying through every previously selected model. |
| `sonata doctor` says "tier agents need a routed session" | No session routes native traffic to the router. Run `sonata route auto` (or `--global`). |
| A tier always picks the wrong model first | The tier is a *ranked* list and the order is the fallback order. Run `sonata agents` and re-rank it — no need to walk the whole `sonata init` wizard. |
| A tier agent's window is smaller than the model's | The alias only claims 1M when **every** candidate in that tier has a 1M window, since any of them may answer. `sonata agents` shows each candidate's window and whether the alias carries `[1m]`. |
| Setup is in a bad state and you want to start clean | `sonata reset` (add `--global` for the machine scope) removes the config, generated agents, loop skill, CLAUDE.md block and routing hooks, while keeping your keys and usage ledger. Then run `sonata init` again. |
| Two installs disagree about a fixed bug | `sonata` on PATH runs `dist/`, not `src/`. `sonata --version` prints the version *and* the directory it ran from, which is how you tell which one answered. |
| `sonata serve --daemon` times out with "the daemon did not answer" | Something already holds the router port — often a stale daemon or another native router. Run `sonata restart` instead; it kills the recorded occupant first. |
