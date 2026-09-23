# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal

<!--
Impeccable's schema offers `web | ios | android | adaptive`. None applies.
Sonata is a CLI whose interface is Ink — React reconciled onto a character
grid. Recorded as `terminal` deliberately rather than mislabelled `web`,
which would invite assumptions that cannot hold here: no CSS, no viewport, no
pointer, no fonts of our choosing, and a colour space that is whatever the
terminal emulator supports.
-->

## Users

Developers working inside Claude Code in a terminal, who want a subagent to run
on a model other than Claude — for cost, or for a second opinion from a
different model family.

Built for its author today, but **strangers are the goal**: someone who finds
`@zhihaohong52/sonata` on npm, has never seen it, and has to get from
`npm install -g` to a working routed agent on their own. Explanation earns its
place where a newcomer would otherwise be stuck, and nowhere else.

That gap is real rather than theoretical. `docs/roadmap.md` gates 1.0 on
exposure and records that nobody outside the repository has yet tried to use
it, so nothing in the interface has been proven against a first-time reader.

## Product Purpose

Dispatch a subagent backed by a foreign model through Claude Code's ordinary
Agent tool: same interface, same working directory, same report contract,
different model.

Two motivations, both confirmed in the codebase:

- **Cost.** Cheap, high-cache models do mechanical work that does not need a
  frontier model.
- **Diversity of judgement.** A different model family reviews Claude's own
  output, which Claude reviewing Claude cannot provide.

Success is a dispatch the user does not have to think about: the right model
for the difficulty, at a price they chose, with a fallback when it fails.

## Positioning

Tier agents run **natively inside Claude Code's own loop** — its tools, its
permission modes, no separate TUI — because an agent's frontmatter names a
router alias rather than a specific model, and a local proxy resolves that
alias against a ranked candidate list.

The consequence a neighbouring tool could not truthfully copy: choosing the
tier *is* choosing the model. There is no model picker, because a model
argument would silently defeat the routing.

## Operating Context

- A terminal, frequently inside **tmux** and often over **SSH**. Colour depth,
  width and theme are all the user's, not ours.
- Claude Code sessions, including **SessionStart hooks and detached daemons**
  where no human is present to answer anything.
- `sonata.toml` — per project, else per machine — is the config the user reads
  and edits by hand. `sonata init` is its sole full writer.
- A local routing daemon (`sonata serve`), one per machine, serving every
  project, with an optional managed LiteLLM child.
- Foreign CLIs (OpenCode, Codex, Pi, Reasonix) as the fallback dispatch lane.
- An Artificial Analysis catalog, refreshed on demand, which moves under the
  user: a model ranked today may be dominated tomorrow.

## Capabilities and Constraints

**Four interface surfaces, all of them confirmed as mattering:**

| surface | frequency | job |
|---|---|---|
| `sonata init` | rare, ~3 times ever | writes the config that decides what every agent costs |
| `sonata agents` | frequent | shows what each candidate resolves to; re-ranks tiers |
| `sonata status` / `doctor` | on failure | is the router up, what did it route, what is broken |
| `sonata tui` | the app shell | health, budget, models, providers, tiers, keys, actions |

**Hard constraints, all four confirmed:**

1. **Any terminal theme.** The app paints its own ground and names its own
   foreground, as an explicit pair per theme, so light and dark are two pages
   rather than two sets of ink. Meaning must still survive colour's absence.

   <!-- Reversed 2026-09-23, from "never set a background". That rule made a
   light theme structurally impossible: with no ground of its own the app
   could only darken the ink on a still-dark terminal, and the selected row —
   a named near-white band under an inherited foreground — disappeared
   outright. Measured, then fixed by giving each palette a BG/TEXT pair and
   painting the page. The surviving half of the original constraint is the
   half that was right: colour is never the only carrier. -->
2. **SSH and tmux.** No truecolor assumption, no mouse. Degrades to 16 colours
   and keyboard only.
3. **Narrow widths.** Usable in a split pane, not only full width. Columns
   reflow or truncate; they do not wrap into mush.
4. **Never block in a hook.** Sonata runs inside SessionStart hooks and
   detached daemons. An interactive prompt there is indistinguishable from a
   hang, and has been one.

**Other confirmed constraints:**

- Four roles ship: `code`, `review`, `explore`, `plan`. The last three are
  read-only, enforced by the harness rather than by prompt text.
- Three difficulty tiers: `simple`, `normal`, `complex`. `normal` is the
  default; a failed task escalates one tier.
- `init` must never offer a model the router cannot reach. Offering one writes
  a config that then fails to load.
- Node 22+, macOS or Linux. Windows unsupported.

## Brand Commitments

- **Name:** sonata, lowercase. Published as `@zhihaohong52/sonata`.
- **Vocabulary the interface must use consistently**, because it is also the
  config's vocabulary: *role*, *tier*, *gateway*, *provider*, *candidate*,
  *dispatch*, *cooldown*.
- **Voice:** evidence-led and specific. The project's own documentation states
  what was measured, when, and what it cost — including its own mistakes and
  reversals. Interface copy should be able to sit beside that without sounding
  like marketing: plain verbs, no apology, no vagueness about what happened.

## Evidence on Hand

- An append-only usage ledger (`~/.config/sonata/usage/`) with real routed
  requests, tokens and cost.
- A cached Artificial Analysis catalog: ~425 rows, of which ~135 publish a
  cost-per-task.
- Real `sonata.toml` files across three projects on this machine, with
  genuinely different shapes.
- A test suite of ~2392 tests against a fake harness and captured fixtures.
- A permanent design-history record in `docs/superpowers/specs/`.

**Absences future work must not paper over:** no external users, no testimonials,
no adoption numbers, no benchmark claims of sonata's own. Harness-lane token
counts are unobservable and the interface says so rather than showing zero.

## Product Principles

1. **A choice must show its consequence before it is made.** Every screen is a
   ranked list with a price attached; the numbers are the content, not
   decoration.
2. **Never offer what the system cannot honour.** A model that will not load, a
   provider with no credential, a tier with no candidates — these are filtered
   or refused at the point of choosing, never accepted and failed later.
3. **Unknown is not zero.** Unpriced volume, unobservable harness usage and
   unscored models are reported as unknown. Folding them into a total is the
   one error that cannot be noticed.
4. **Degrade, never assume.** Colour, width, terminal features and the catalog
   itself may all be absent or stale. Each has a defined fallback.
5. **Silence is a failure mode.** A refusal nobody sees, a daemon that dies
   quietly, a prompt in a context that cannot answer — these have each been
   real bugs here. Saying what happened is a product requirement.

## Accessibility & Inclusion

- **Colour is never the only carrier of meaning.** Rank, state and cost must
  each be readable in monochrome.
- **Keyboard only.** No interaction may require a pointer.
- Legible on light and dark terminal themes, and at 16 colours.
- No motion that conveys information on its own; a spinner may indicate work,
  but never what the work is.
