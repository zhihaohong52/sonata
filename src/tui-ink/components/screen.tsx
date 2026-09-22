import React from 'react';
import { Box, Text } from 'ink';
import { columns, usableWidth } from '../theme.js';
import { usePalette } from '../theme-context.js';

/** How wide a rule should be drawn, bounded at both ends by `columns`. */
export function ruleWidth(): number {
  return columns(usableWidth()).total;
}

/**
 * The frame every inner screen wears: title, hairline, body, keymap.
 *
 * Extracted because the five screens under the menu had each grown their own
 * header — same intent, four spellings, and one of them missing the rule
 * entirely. A shell makes that consistency structural rather than a thing each
 * screen has to remember, which is the only kind that survives the next screen
 * being added.
 *
 * Two screens deliberately do **not** wear it. `overview` is the masthead —
 * the product's own name, not a section heading, and a rule under it would
 * divide the app from itself. `status` draws two boards with a rule each, so
 * a third at the top would be the loudest line on a screen whose content is
 * the point.
 *
 * `note` is the header's right-hand half: a count, a scope, a freshness
 * stamp. It sits beside the title rather than under it so the rule stays the
 * first horizontal line, and it is always `MUTED` — a header that competes
 * with its own body is how a reader learns to skip headers.
 */
export function Screen({
  title,
  note,
  footer,
  children,
}: {
  title: string;
  note?: string;
  /** The keymap. Lowercase, key then verb, as the board grammar sets it. */
  footer: string;
  children: React.ReactNode;
}): React.ReactElement {
  const palette = usePalette();
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={palette.TEXT}>{title}</Text>
        {note !== undefined && <Text color={palette.MUTED}>{`   ${note}`}</Text>}
      </Box>
      <Text color={palette.RULE}>{'─'.repeat(ruleWidth())}</Text>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
      <Box marginTop={1}><Text color={palette.MUTED}>{footer}</Text></Box>
    </Box>
  );
}

/**
 * A screen that has nothing to show, and says why.
 *
 * Four screens read the config and three of them had inlined the identical
 * "it would not load, press esc" block. It is one shape because it is one
 * situation: the message names the fault, and the only thing to do about it is
 * leave. Drawn in `MID` rather than a hardcoded `yellow`, which on the light
 * palette is the vanishing text `theme.ts` exists to prevent.
 */
export function Message({ text, title = 'sonata' }: { text: string; title?: string }): React.ReactElement {
  const palette = usePalette();
  return (
    <Screen title={title} footer="esc back">
      <Text color={palette.MID}>{text}</Text>
    </Screen>
  );
}

/**
 * A count and its noun, pluralised.
 *
 * Trivial, and here because "1 gateways" appeared in a header the first time
 * these screens were rendered against a real config. A number formatted by
 * hand is the kind of detail that reads as carelessness about everything else
 * on the screen.
 */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * A field cut to fit, with an ellipsis where it was cut.
 *
 * `theme.ts` states the rule — "a row must never wrap; the board degrades by
 * dropping columns" — and `columns()` implements it, but only the ranking
 * board consulted it. The list screens joined model names and tier summaries
 * unbounded, so the rule held exactly where the board was built first and
 * nowhere else. A wrapped row stops being a row, which is the whole grammar.
 *
 * The ellipsis is load-bearing rather than decorative: silently truncating a
 * list of model names produces a row that reads as complete and is not, which
 * is the one failure worse than an ugly row.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}
