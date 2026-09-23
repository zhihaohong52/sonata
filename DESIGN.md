---
name: sonata
description: A terminal departure board for ranked model tiers — one service leads, the rest stand by in declared order.
colors:
  bg-dark: "#141414"
  accent-dark: "#d7875f"
  text-dark: "#e8e4de"
  muted-dark: "#8a8a8a"
  rule-dark: "#3f3f3f"
  band-dark: "#2e2e2e"
  low-dark: "#87af87"
  mid-dark: "#d7af5f"
  high-dark: "#d75f5f"
  bg-light: "#faf7f2"
  accent-light: "#95492a"
  text-light: "#2b2723"
  muted-light: "#635d55"
  rule-light: "#c9c1b4"
  band-light: "#e6dccc"
  low-light: "#2f6b34"
  mid-light: "#7a5c14"
  high-light: "#9c2f24"
typography:
  masthead:
    fontFamily: "inherit (the terminal's own monospace)"
    fontWeight: 700
  title:
    fontFamily: "inherit (the terminal's own monospace)"
    fontWeight: 700
  body:
    fontFamily: "inherit (the terminal's own monospace)"
    fontWeight: 400
  secondary:
    fontFamily: "inherit (the terminal's own monospace)"
    fontWeight: 400
  keymap:
    fontFamily: "inherit (the terminal's own monospace)"
    fontWeight: 400
spacing:
  ground-inset: "1 cell"
  head-note-gap: "3 cells"
  stroke-column: "4 cells"
  keymap-gap: "3 cells"
  block-gap: "1 row"
components:
  screen-title:
    textColor: "{colors.text-dark}"
    typography: "{typography.title}"
  screen-note:
    textColor: "{colors.muted-dark}"
    typography: "{typography.secondary}"
    padding: "0 0 0 3 cells"
  screen-rule:
    textColor: "{colors.rule-dark}"
    width: "board total"
  lead-rule:
    textColor: "{colors.rule-dark}"
    width: "board total"
  menu-row:
    textColor: "{colors.muted-dark}"
    typography: "{typography.body}"
  menu-row-selected:
    backgroundColor: "{colors.band-dark}"
    textColor: "{colors.text-dark}"
    typography: "{typography.title}"
  menu-row-disabled:
    textColor: "{colors.rule-dark}"
    typography: "{typography.body}"
  menu-edge-selected:
    textColor: "{colors.accent-dark}"
    width: "1 cell"
  board-row-lead:
    textColor: "{colors.accent-dark}"
    typography: "{typography.title}"
  board-row-standby:
    textColor: "{colors.text-dark}"
    typography: "{typography.body}"
  board-row-dominated:
    textColor: "{colors.muted-dark}"
    typography: "{typography.body}"
  board-row-cursor:
    backgroundColor: "{colors.text-dark}"
    textColor: "{colors.bg-dark}"
  bar-fill:
    textColor: "{colors.low-dark}"
    width: "8–18 cells"
  bar-track:
    textColor: "{colors.rule-dark}"
  keymap-key:
    textColor: "{colors.muted-dark}"
    typography: "{typography.keymap}"
  keymap-key-commit:
    textColor: "{colors.accent-dark}"
    typography: "{typography.keymap}"
    width: "ranking board only"
  field-caret:
    textColor: "{colors.accent-dark}"
    width: "1 cell"
  notice:
    textColor: "{colors.mid-dark}"
    typography: "{typography.body}"
---

# Design System: sonata

## Overview

**Creative North Star: "The Departure Board"**

A tier is a departure board. One service goes; the rest stand by in declared
order, and a delay is a stated condition with a time on it rather than an
error. Every screen in `src/tui-ink/` is built from that one idea: rows on a
shared baseline under a fixed head, each carrying a position, a name, a
measured quantity and a status held in its own right-hand column. The screen's
job is to show the whole chain — what is running, what follows it, what is
delayed and why — not merely where the cursor is. That is why the category
default, a titled checkbox list over a dim hint line, was refused: a checkbox
list draws the selection and hides the consequence, and what sonata ranks is
fallback depth.

The medium is a character grid inside somebody else's terminal, frequently in
tmux and often over SSH. The system treats that as a material rather than a
limitation. Box-drawing characters are the medium's own marks and are used as
such; no emoji ever stands in for an icon. State is carried by the *shape* of a
stroke, so the board survives a 16-colour session, a monochrome pipe and a
colour-blind reader, and colour is only ever allowed to agree with the stroke.
One warm accent — terracotta, the same tone Claude Code uses, because sonata
runs inside Claude Code's window and earns more by belonging than by asserting
itself — is spent only on what leads, what is selected, and what commits.

The app paints its own ground. This reverses an earlier rule (still stated in
`PRODUCT.md` and in the surface brief) that the background belongs to the user
and nothing may set one. That rule made light mode structurally impossible and
shipped a selected row as terminal-grey text on a near-white band; the build
that exists now names an explicit background/foreground pair per theme and
fills the page before anything draws on it. Where the contract and the build
disagree, this document records the build.

**Key Characteristics:**
- Rows on a shared baseline: one service per line, always, at any width.
- State is stroke first; colour repeats it and never replaces it.
- One accent, two or three marks a screen: what leads, what is selected, what commits.
- Quantities are bars on a scale shared across rows, because the question is comparative.
- Hairlines are rare: one under the head, one above provenance, one under the lead.
- Nothing disappears — a cooled gateway and a dominated model stay on the board, struck.
- Ink only. No emoji, no glyph costumes, no colour-only meaning.

## Colors

Graphite and the terminal's own weight, with one warm accent and a three-band
quantity ramp; the whole palette exists twice, once for each ground.

### Primary
- **Terracotta Accent** (`{colors.accent-dark}` on dark, `{colors.accent-light}` on light): the lead
  service's rank numeral, the selected row's edge `▌`, the `━━` stroke on a
  router that is up, the `$` and caret in an editable field, and — on the
  ranking board only — the key that commits. Nothing decorative. It is
  deepened rather than reused on light, because terracotta that reads on
  charcoal is too pale to hold against near-white — and it has to hold on the
  selected band as well as on the page, which is the worst case rather than the
  typical one.

### Neutral
- **Ground** (`{colors.bg-dark}` / `{colors.bg-light}`): the page, painted once by the shell under
  everything.
- **Primary Text** (`{colors.text-dark}` / `{colors.text-light}`): titles, row names, the value being
  edited. Always named explicitly, never inherited.
- **Secondary Text** (`{colors.muted-dark}` / `{colors.muted-light}`): head notes, units, provenance,
  cost, status words, keymap verbs, unselected rows.
- **Rule** (`{colors.rule-dark}` / `{colors.rule-light}`): hairlines, the unfilled part of a bar, and a
  disabled menu row. Quieter than secondary text, always.
- **Band** (`{colors.band-dark}` / `{colors.band-light}`): the selected row's surface. Bounded to one
  row; it is never a screen background.

### Tertiary — the quantity ramp
- **Low** (`{colors.low-dark}` / `{colors.low-light}`), **Mid** (`{colors.mid-dark}` / `{colors.mid-light}`),
  **High** (`{colors.high-dark}` / `{colors.high-light}`): where a measured fraction sits. Mid also
  carries an in-place notice — an empty state, a "this would not load", and the
  Budget screen's rejected value; High carries a hard fault — a failed route's
  status code, a gateway with no credential, and the text field's own rejected
  value. Both refusal colours are in the build and are recorded rather than
  reconciled: a refusal that leaves a usable screen is Mid, one naming a value
  the system will not take at all is High.

### Named Rules
**The Leads-Selects-Commits Rule.** The accent marks exactly three kinds of
thing: what leads (the lead service's numeral, a live router's stroke), what is
selected or being typed into (the selection edge, the field caret and its `$`),
and — on the ranking board — the key that commits. Two or three marks per screen
is what the build spends; a fourth is decoration, and decoration is what makes
the rest stop meaning anything. Screens wearing the shared frame render their
whole keymap muted, commit key included; only the ranking board accents
`enter`.

**The Agreement Rule.** Colour may only agree with something already carried by
a stroke, a position or a word. Strip every colour from a screen and it must
still read. This is why the quantity bands (`≥0.9` High, `≥0.7` Mid, else Low)
are behavioural thresholds taken from where sonata itself starts refusing or
escalating: a band that disagreed with the program would be decoration.

**The Explicit Pair Rule.** A palette that asserts a background owns the
foreground that lands on it. Every `<Text>` names a role; none inherits the
terminal's foreground. A palette naming `BAND` but not `TEXT` is how the
selected row once vanished.

**The Band Is The Worst Case Rule.** Contrast is checked against the band as
well as against the ground, in both themes — `tests/tui-ink/menu-theme.test.ts`
asserts WCAG 4.5:1 for text and 3:1 for secondary text and the accent, on both
surfaces. The band is the only place the background changes under the same
text, and it is exactly where the original palette failed.

## Typography

**One face:** whatever monospace the user's terminal is set to. Size is not
ours, family is not ours, and the system does not pretend otherwise.

**Character:** hierarchy is built from the three things a character grid
actually gives — weight, colour role, and position — never from size. Copy is
plain and evidence-led: lowercase verbs, no apology, no vagueness about what
happened.

### Hierarchy
- **Masthead** (bold, primary text): the product's own name, on the overview
  screen only. It is a name, not a section heading, so nothing rules under it.
- **Title** (bold, primary text): one Title-case noun at the top-left of a
  screen — `Models`, `Keys`, `Budget`, `Tiers`. The status screen instead uses
  lowercase heads (`router`, `routes, last hour`) for its two boards; that
  split is what the build does and is recorded rather than resolved.
- **Body** (regular, primary text): row names, the value under edit.
- **Secondary** (regular, secondary text): the head note, cost, status words,
  provenance, and every explanatory line under a board.
- **Keymap** (regular, secondary text, lowercase): the last line of a screen.
  Key then verb, pairs separated by three spaces. Muted throughout on a framed
  screen; the ranking board alone draws its committing key in accent.

### Named Rules
**The Count-Right-Of-Head Rule.** A screen's one live fact goes in the head
note, three spaces right of the title, in secondary text: `3 of 19 ranked`,
`12 gateways, all credentialed`, `2 of 7 unreachable`, `updated 4s ago`. It sits
beside the title, not under it, so the hairline stays the first horizontal line
on the screen. A note that competes with its own body is how a reader learns to
skip headers. Counts are pluralised by the shared `count()` helper — `1
gateways` in a real header is what put it there.

**The Key-Then-Verb Rule.** Keymaps read `enter confirm   ← back   esc cancel`:
key first, lowercase verb, three spaces between pairs, never a sentence. The
ranking board wraps *between* pairs and never inside one,
and never drops a key to fit — a hidden action is worse than a second line.

**The Truncation Rule.** A field cut to fit ends in `…` (`fit()`). Silently
truncating a joined list of model names produces a row that reads as complete
and is not, which is the one failure worse than an ugly row.

## Layout

The unit is the cell. Everything below is measured, and each number cost a
defect.

**The ground is one column short of the terminal.** `GROUND_INSET = 1`, and
`usableWidth(termWidth) = max(1, termWidth − 1)` is the single definition shared
by the page and by every caller of `columns()`. At exactly `columns` wide, ink
7.1.1 emits no background at all: a full-width run of padding would wrap, so the
trailing spaces that carry the colour are trimmed, and trimming them removes the
background. The symptom is not a missing column — it is a ragged page, where
rows that set their own background keep it and every other row shows the
terminal through. The ground's height is `rows − 1` for a sibling reason:
filling the final row scrolls the terminal by one line, so the top of the app
walks off the scrollback on every repaint.

**One definition of width, or hairlines wrap.** When the page and the rows drawn
on it disagreed by one cell, every rule wrapped into a rule plus a lone `─` on
the next line — measured at 96 columns. `ruleWidth()` is `columns(usableWidth()).total`,
and that is what every hairline, every board row and every list screen measures
against.

**The board's column budget.** `columns(termWidth)` clamps the width to
`[40, MAX_BOARD]` and then spends it:

| field | width | note |
|---|---|---|
| rank | 4 | 3 digits, right-aligned, plus a trailing space |
| name | `max(10, budget − bar)` | model key and `@effort` |
| bar | `min(18, max(8, floor(budget × 0.3)))`, 0 below 72 | shared-scale quantity |
| cost | 9 | `$` plus 4 decimals, right-aligned and decimal-aligned |
| status | 13 with word, 4 without | `1 + widest mark (3) + 1 + widest word (8)` |

`budget = w − 4 − 9 − status`. The status column is *measured from `STATE`*
rather than guessed: one cell short and the row wraps, which was caught as a
blank line between every row.

**Degradation is by dropping columns, never by wrapping.** Below `MIN_BOARD`
(72) the bar goes first — the numbers still carry the comparison. Below 88 the
status word goes and the stroke stands alone. Below that, names truncate. A
wrapped row stops being a row, and one-service-per-line is the whole grammar.

**The board stops growing at `MAX_BOARD` (120) and sits left.** A measure limit,
for the reason prose has one: at 200 columns the name ran 145 wide and the row
read as two unrelated halves.

**Worked example, 96×24 (the first viewport).** `usableWidth` 95 → bar and word
both shown → status 13, budget 69, bar 18, name 51, total 95. Head line, hairline
at 95, board rows, a dotted rule under the lead, hairline, provenance, keymap.

**Vertical rhythm** is one blank row between blocks (`marginTop={1}`): head/rule,
then body, then keymap. Nothing is indented except a detail belonging to the row
above it, which sits under its parent at 5–6 cells.

### Named Rules
**The No-Wrap Rule.** A row must never wrap. If it does not fit, drop a column,
then shorten the status to its mark, then truncate the name with `…`. Applies to
every screen, not just the board — the list screens joined names unbounded until
`fit()` carried the rule to them, and the tiers list wrapped three lines per row
until the detail moved under the cursor.

## Elevation & Depth

There are no shadows; a terminal has none to give. Depth is tonal and it is one
step deep: the ground, and a band on exactly one row. The band is the selected
row's surface and is never used as a screen background, a panel, or a group
fill.

**On dark the band is lighter than the ground; on light it must be darker.**
Inverting one and not the other is how a "light theme" ends up being the dark
theme with different numbers, and it is asserted as a luminance comparison in
`tests/tui-ink/menu-theme.test.ts`.

Separation otherwise is done with hairlines, and there are three weights, each
with one job:

- **Hairline** (`─`, rule colour, full board width): under the head, and above
  provenance or a second board. Never more than two per screen.
- **Lead rule** (`┄`, rule colour, full board width): under the lead service
  only, and only when something follows it — a one-row list must not end in a
  rule against nothing.
- **Bar stroke** (`━` filled, `╸` half cell, `─` track): the quantity itself.
  The half cell exists so a one-column difference is still visible at the narrow
  widths a split pane imposes.

### Named Rules
**The Two-Rules Rule.** One hairline under the head, one above provenance. A
third horizontal line becomes the loudest thing on a screen whose content is the
point — which is why the status screen, drawing two boards with a rule each,
deliberately does not wear the shared frame.

**The Nothing-Disappears Rule.** A cooled gateway, a dominated model, an
untiered model and a disabled action all stay on screen, marked. Hiding a row
loses the reason it was ruled out, which is the thing the reader came for.

## Shapes

There are no radii, no borders and no boxes. The form language is the character
grid itself: a left edge bar `▌` for selection, box-drawing strokes for state,
a `▏` caret for an editable field, `❯` for a text prompt, `…` for truncation and
for a menu row that opens something further rather than acting immediately.

Alignment is the silhouette. Rank right-aligned in 3, cost right-aligned and
decimal-aligned in 9, status last and always in the same column — so the eye
reads down a column rather than across a row.

### Named Rules
**The Ink-Only Rule.** Box-drawing characters are the medium's own marks. No
emoji ever stands in for an icon: a `⚠` on the overview screen was replaced by
`STATE.cooled`'s stroke so that the home screen speaks the same vocabulary as
every screen it leads to.

## Components

### The State Strokes (signature)
Six strokes, one per row, in the right-hand status column. The mark alone is
sufficient; the word repeats it when there is room, and colour repeats it again.

| state | mark | word | means |
|---|---|---|---|
| `live` | `──` | ready | reachable, in the chain, nothing wrong |
| `lead` | `━━` | running | this is what a dispatch gets right now |
| `cooled` | `─ ─` | delayed | a stated condition with a fix or a time — a cooldown, a missing credential, a failing check |
| `dominated` | `──○` | standby | something cheaper is at least as capable; never reached first |
| `held` | `─┼─` | held | out by hand — `avoid_gateways`, a deselected provider, a model no tier names |
| `unscored` | `· ·` | unranked | cannot be ranked; the catalog prices no work for it |

Six strokes and six words, reused everywhere: the board's status column, the
router's up/down line, the overview's findings, the models list, the keys list,
and every failed attempt under a route. A new screen picks from this table; it
does not invent a seventh.

### The Screen Frame
Title, optional head note, hairline, a one-row gap, body, a one-row gap, keymap.
Wearing it is the default, because five screens each grew their own header —
same intent, four spellings, one missing the rule. Two screens deliberately do
not: the overview, whose masthead is the product's name rather than a section
heading, and the status screen, which draws two boards with a rule each.

### Menu (selection drawn three ways)
Arrow keys move a highlight and wrap at both ends; enter chooses. The selected
row is marked **three ways at once** — an accent edge `▌`, a band behind the row,
and full-strength bold text against muted neighbours — because any one alone
fails somewhere: the edge is a glyph a narrow font may render thin, the band
needs colour, and weight alone is invisible in a two-colour terminal. A row that
opens something further carries `…`. A disabled row is drawn in rule colour with
a right-aligned note saying why, and is never hidden.

### The Ranking Board
The signature surface. Rows are drawn **in rank order**, ranked first, so a
ranked row's display position *is* its rank position and reordering moves the
row and its whole service together — numeral, bar and status travel with it.
Per row: rank numeral (accent and bold on the lead, muted `·` when unranked),
name and `@effort`, the capability bar on the screen's shared maximum, cost
right-aligned, then the state stroke.

- **Lead-above-a-rule.** The lead sits apart, above a `┄` rule, because it is the
  row that answers "what runs if I dispatch right now" and in an undifferentiated
  run of rows that question has to be answered by hunting for the numeral 1.
- **Struck dominated rows.** A dominated candidate is rendered with a
  strikethrough on the name, not merely dimmed: the strike says "ruled out" on
  the row where the judgement applies, and `──○` says the same thing in the
  stroke vocabulary.
- **Cursor vs lead.** The cursor is drawn by inversion; the accent stays reserved
  for the lead. The board's two questions — where am I, and what runs — must not
  be answered by the same mark.
- **Empty state.** A board with nothing ranked says what would put something
  there, in notice colour, rather than printing nothing.

### Measured Quantities
A bar is always drawn against the **screen's own maximum**, never against the
value's ceiling: the reader's question is comparative, and a bar scaled to its
own row answers a question nobody asked. Fill takes the quantity band; the track
takes rule colour. A row with no measurement gets a full-width track and `—` in
the cost column — unknown is shown as unknown, never as zero.

### Editable Field
A label in secondary text, the value in bold primary text, and an accent caret
`▏` directly after it. The caret is the whole affordance: an empty field with no
caret reads as a value of zero rather than as an absent cap. A rejected value is
answered in place, under the field, in notice colour. A secret is rendered as
`•` per character, because what is printed stays in scrollback.

### Empty and Failure States
A screen with nothing to show says what would put something there
(`Nothing routed from this project in the last hour. Dispatch a tier agent and
it appears here.`). A screen that cannot load its config is replaced entirely by
a one-line `Message` naming the fault, in notice colour, with `esc back` — an
error is never drawn over a live surface that still owns the keyboard.

## Do's and Don'ts

### Do:
- **Do** paint the ground and name every foreground. Each palette is an explicit
  `BG`/`TEXT` pair, and every `<Text>` names a role from it.
- **Do** size the page and its rows through `usableWidth()` and `columns()` — one
  definition, one cell short of the terminal.
- **Do** carry state on a stroke from `STATE` and let colour agree with it.
- **Do** put the screen's one live fact in the head note, three spaces right of
  the title, in secondary text.
- **Do** drop columns to fit: bar first (below 72), then the status word (below
  88), then truncate the name with `…`.
- **Do** draw selection three ways — accent edge, band, full-strength text — in
  a menu or a list. On the ranking board the cursor is drawn by inversion
  instead, because the accent there is already spent on the lead.
- **Do** scale every bar against the screen's shared maximum.
- **Do** keep dominated, cooled, held and disabled rows on screen and marked.
- **Do** write keymaps as `key verb`, lowercase, three spaces between pairs,
  muted throughout on a framed screen; the ranking board alone accents its
  committing key.
- **Do** check a new palette value against the **band** as well as the ground,
  and keep `tests/tui-ink/menu-theme.test.ts` passing.

### Don't:
- **Don't** let a row wrap. Drop a column instead; a wrapped row stops being a row.
- **Don't** use colour as the only carrier of anything — rank, state and cost must
  each read in monochrome.
- **Don't** spend the accent on a third thing. The lead service and the committing
  key, and nothing else.
- **Don't** make the band a screen background, a panel or a group fill; it is one
  row deep.
- **Don't** invert the band's direction. Lighter than the ground on dark, darker
  on light.
- **Don't** draw a third hairline on a screen, or a lead rule with nothing beneath it.
- **Don't** substitute an emoji for a stroke, and don't hardcode `yellow`, `cyan`
  or `green` — a hardcoded hue does not move with the theme toggle, and yellow on
  the light palette is the vanishing text this system exists to prevent.
- **Don't** show unknown as zero: a missing measurement is `—` and an unpriced row
  says so.
- **Don't** hide a row to make a screen fit, and don't drop a key from a keymap to
  make a line fit.
- **Don't** draw an error over a live surface; replace the surface.
