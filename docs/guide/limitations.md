# Limitations

Worth knowing before you depend on this:

- **`sonata init` discovers models for four harnesses** — opencode, pi, codex
  and reasonix. Codex has no `models` subcommand, so its catalogue comes from
  `codex app-server`'s `model/list` (JSON-RPC over stdio), with a real response
  captured in `tests/fixtures/codex/model-list.json`. The `claude` harness is
  the host and is never offered for discovery.
- **Nested agents are unbounded and unattributed.** A generated agent can
  spawn further agents, and nothing counts depth — a `code-normal` agent can
  call `Agent(subagent_type: "code-normal")` on itself. Read-only roles are
  told to delegate only to other read-only roles, but that is prompt text:
  `tools:` frontmatter grants tools, not permitted argument values. `sonata
  usage` attributes spend per session rather than to the dispatch that caused
  nested cost.
- **Some dispatch runs cannot be attributed.** Two dispatches to the same
  harness in the same directory at the same time are both reported `unobservable`
  rather than split by guesswork.
- **`[budget]` counts a dispatch when it finishes.** `sonata dispatch` refuses
  to launch once a cap is reached, but one run already under way can carry
  spend past it.
- **Prompt detection is regex against TUIs sonata does not control.** Codex's
  patterns are written from captured real output in `tests/fixtures/panes/`,
  but they will still break when codex changes its interface. The `STALLED`
  timeout is the backstop. OpenCode and Pi cannot prompt at all, so there is
  nothing to detect. An answered prompt also stays in the pane, so it can be
  re-reported `PAUSED` — wasted `approve`/`wait` round trips, and a digit that
  lands in the harness's composer as text.
- **Codex through a proxy needs that proxy up.** If `~/.codex/config.toml` sets
  `openai_base_url`, `sonata doctor` checks the endpoint is listening — a dead
  proxy otherwise wastes minutes in retries before failing.
- **`opencode run --format json` is broken upstream** (v1.18.15 produces no
  output and never exits), so progress comes from pane text rather than a
  structured event stream. Pi's `--mode json` does work; the adapter keeps a
  seam for adopting it.
- **opencode's `event` table grows without bound** — 6.5 GB across 140k rows on
  the development machine, which is what produced `database is locked` under
  three concurrent dispatches. Sonata cannot prune another harness's store.
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
- **A conversation prefers the candidate that served its first turn.** Switching
  models mid-conversation can hand one model's thinking blocks to another,
  which the API rejects — a multi-turn agent then dies mid-task on a 400.
  Affinity and thinking-block stripping make that survivable, not impossible.

- **`normal` is optional.** A config may keep only `simple` and `complex`, preserving its previous behaviour; adding `normal` provides the uncapped value-ranked choice. `simple` is the value order capped at 12 times the best-value model's cost per task, so it leads with the best-value model while `normal` leads with the knee of the price-performance frontier.
- **A plan's overflow is invisible.** A subscription gateway's work is
  reported as covered and left out of `[budget]`. Some plans bill usage past
  their allowance per token (OpenCode Go with "Use balance" on, Chutes,
  NanoGPT, Ollama Cloud's extra credits), and nothing in a response says
  which requests did — so that spend is reported covered too.
- **`auth = "session"` needs a live Claude Code session.** Outside that context
  the session credential may be unavailable, and subscription spend is
  estimated at Anthropic list prices — a report, not a bill.
