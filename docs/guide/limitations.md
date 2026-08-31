# Limitations

Worth knowing before you depend on this:

- **`sonata init` discovers models for all three harnesses.** Codex has no
  `models` subcommand, so its catalogue comes from `codex app-server`'s
  `model/list` (JSON-RPC over stdio), with a real response captured in
  `tests/fixtures/codex/model-list.json`.
- **Nested agents are unbounded and unattributed.** A generated agent can
  spawn further agents, and nothing counts depth — a `code-complex` agent can
  call `Agent(subagent_type: "code-complex")` on itself. Read-only roles are
  told to delegate only to other read-only roles, but that is prompt text:
  `tools:` frontmatter grants tools, not permitted argument values. `sonata
  usage` attributes spend per session rather than to the dispatch that caused
  nested cost.
- **Prompt detection is regex against TUIs sonata does not control.** Codex's
  patterns are written from captured real output in `tests/fixtures/panes/`,
  but they will still break when codex changes its interface. The `STALLED`
  timeout is the backstop. OpenCode and Pi cannot prompt at all, so there is
  nothing to detect.
- **Codex through a proxy needs that proxy up.** If `~/.codex/config.toml` sets
  `openai_base_url`, `sonata doctor` checks the endpoint is listening — a dead
  proxy otherwise wastes minutes in retries before failing.
- **`opencode run --format json` is broken upstream** (v1.18.15 produces no
  output and never exits), so progress comes from pane text rather than a
  structured event stream. Pi's `--mode json` does work; the adapter keeps a
  seam for adopting it.
- **No streaming granularity guarantees.** Progress is whatever the harness
  prints.
- **ChatGPT's Codex endpoint occasionally returns an empty completion under
  concurrent load** instead of a 429, which LiteLLM surfaces as a 500. The
  router recognizes this specific case and re-emits it as 529 (overloaded) so
  Claude Code retries automatically instead of treating it as a hard failure.
- **Tier fallback retries only before a response starts.** The router tries
  each ranked candidate in order and returns the first one that answers with
  status < 500; once a response starts streaming there is no mid-stream
  failover to the next candidate. A candidate that fails cools down for 60
  seconds so a repeated request doesn't retry a model that just failed.
