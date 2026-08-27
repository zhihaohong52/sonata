# Troubleshooting

Start with `sonata doctor` — it checks tmux, each configured harness, its
version and auth, and the permission hook.

| Symptom | Cause |
|---|---|
| Agents don't appear in Claude Code | Run `sonata sync`; Claude Code picks up regenerated agents automatically. |
| `sonata: command not found` | The generated agents call `sonata` on your PATH. Run `npm link` in the clone (or install globally once published). |
| Dispatch fails: "cannot ask for approval" | You are in `default` mode with opencode or pi, which cannot prompt. Switch to `acceptEdits`, use a codex or reasonix model, or dispatch a read-only role. |
| A tier agent errors with "all native routes … failed" | Every candidate for that tier failed. Run the `sonata dispatch --tier <role>-<tier>` command the error names, in Bash. |
| Every opencode/pi dispatch refuses | The permission hook is not installed, so sonata assumes `default`. Run `sonata init` and choose a hook scope. |
| A codex run sits in `PAUSED` at startup | Codex has not been trusted in this directory. Run `codex` there once and answer "Yes, continue". |
| A run reports `degraded` | The harness exited without writing a report; the text you get is scraped pane output. Treat it as untrustworthy. |
| A run never finishes | It is capped by `run_timeout_seconds`. Attach with `tmux attach -t sonata-<id>` to watch it. |
| `sonata doctor` says "config predates [tiers]" | Run `sonata init` — it migrates the config to `[models]`+`[tiers]`, carrying through every previously selected model. |
| `sonata doctor` says "tier agents need a routed session" | No session routes native traffic to the router. Run `sonata route auto` (or `--global`). |
| `sonata serve --daemon` times out with "the daemon did not answer" | Something already holds the router port — often a stale daemon or another native router. Run `sonata restart` instead; it kills the recorded occupant first. |
