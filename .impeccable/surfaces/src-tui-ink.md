---
version: 1
slug: "src-tui-ink"
primary_target: "src/tui-ink"
related_targets: []
---

# Surface brief — sonata's terminal interface

**Scope:** `src/tui-ink/` — the Ink surfaces of `sonata init`, `sonata agents`,
`sonata status` / `doctor`, and `sonata tui`. All four are co-equal.

**Visitor mode:** Operate. Someone mid-task, in tmux or over SSH, completing a
task or finding out why one failed.

**Audience and job:** developers running Claude Code who want a subagent on a
foreign model. Built for its author, but strangers are the goal — someone who
found the package on npm and must reach a working routed agent alone.

**Constraints that bind every screen:** own the ground and the foreground as
an explicit pair (reversed 2026-09-23 from "never own the background", which
made a light theme impossible — see PRODUCT.md); degrade to 16 colours and
keyboard only; readable in a split pane; never block in a hook. Colour is
never the sole carrier of meaning.

**Unresolved:** whether `sonata tui`'s dashboard shares the board grammar or
earns a second composition. Decide when that surface is built, not before.

## Direction contract

**THESIS.** A tier is a departure board: one service goes, the rest stand by in
declared order. The screen's job is to show the whole chain — what is running,
what follows it, what is delayed and why — not merely the current selection. It
refuses the category default, a titled checkbox list over a dim hint line,
which shows the cursor and hides the consequence. What sonata ranks is
fallback depth, and depth is the one thing a checkbox list cannot draw.

**OWN-WORLD.** Rows on a shared baseline under a fixed head, each carrying a
service number, a name, a measured quantity, and a status held in its own
right-hand column. State is stroke, not hue: live reads unbroken, cooled as a
clean gap, dominated as an open ring, pinned as doubled — so the board survives
monochrome, and colour only ever reinforces. One warm accent marks the lead
service and the committing key, never decoration. Everything else is graphite
and the terminal's own foreground. Quantities are bars against a scale shared
across rows, because the question is always comparative. Rules are hairline and
rare: one under the head, one above provenance. Nothing disappears — a cooled
gateway and a dominated model stay on the board, struck.

**STORY.** The reader arrives knowing a role and a difficulty, not a model.
They see which service leads and what it costs, that others stand behind it in
order, and that a delay is a stated condition with a time, not an error. They
leave having set an ordering they can read back, understanding that choosing
the tier was choosing the model.

**FIRST VIEWPORT.** `sonata init`'s ranking screen at 96×24. Head line: role
and tier left, count chosen right. A hairline rule. Then the board: rank
numeral in accent, model and effort, a capability bar on the shared scale, cost
right-aligned and decimal-aligned, status last. The lead service sits above a
rule, apart from standby rows. Dominated candidates render struck beneath.
Second hairline, then provenance — the catalog and its date. The keymap is the
last line, key then action, double-space separated, never middle-dot prose.
The committing key is the only other accent on screen.

**FORM.** The Departure Board (solari split-flap boards), position 1 of 7 on
the ordered grounded list, chosen by the user over the assigned roll. Seed key
`afb4e0bc`; resolved as kind `pick`. Signature interaction: re-ranking moves a
row and its whole service — numeral, bar and status travel together, so the
board is always readable as an order rather than as markers that swap. Motion
is one orchestrated line-settle on reorder; nothing else animates, and no
split-flap is imitated because a terminal cannot do it honestly.

**FINISH.** unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance
