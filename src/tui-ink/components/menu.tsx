import React from 'react';
import { Box, Text } from 'ink';
import { usePalette } from '../theme-context.js';

export interface MenuItem<T> {
  value: T;
  label: string;
  /** Shown right-aligned: a count, a state, a reason this row is unavailable. */
  note?: string;
  /** Unavailable, with `note` saying why. Still drawn — never hidden. */
  disabled?: boolean;
  /** Opens something further, marked with an ellipsis. */
  opens?: boolean;
}

/**
 * A cursor menu.
 *
 * Arrow keys move a highlight; enter chooses. This replaces a letter-key
 * footer (`b budget · m models · …`), which required the reader to map a
 * mnemonic onto a destination before they could move — fine once learnt, and
 * a wall on first use, which is the wrong trade for a product whose stated
 * audience is strangers.
 *
 * The selection is drawn three ways at once, deliberately: an accent edge
 * `▌`, a band behind the row, and the label in full-strength text against
 * muted neighbours. Any one of them alone fails somewhere — the edge is a
 * glyph a narrow font may render thin, the band needs colour, and weight
 * alone is invisible in a 2-colour terminal — so all three carry it and the
 * row is still obviously selected with any one of them gone.
 *
 * `…` marks a row that opens something further rather than acting
 * immediately, so a reader can tell "this will ask me more" from "this will
 * happen now" before pressing.
 */
export function Menu<T>({
  items,
  cursor,
  label,
}: {
  items: ReadonlyArray<MenuItem<T>>;
  cursor: number;
  /** A quiet heading. Lowercase: it names the region, it is not a title. */
  label?: string;
}): React.ReactElement {
  const palette = usePalette();
  const width = Math.max(...items.map((item) => item.label.length + (item.opens === true ? 1 : 0)), 12);

  return (
    <Box flexDirection="column">
      {label !== undefined && (
        <Box marginBottom={1}><Text color={palette.MUTED}>{label}</Text></Box>
      )}
      {items.map((item, index) => {
        const selected = index === cursor;
        const text = `${item.label}${item.opens === true ? '…' : ''}`;
        return (
          <Box key={String(item.value)}>
            <Text color={palette.ACCENT}>{selected ? '▌' : ' '}</Text>
            <Text
              backgroundColor={selected ? palette.BAND : undefined}
              color={item.disabled === true ? palette.RULE : selected ? palette.TEXT : palette.MUTED}
              bold={selected}
            >
              {` ${text.padEnd(width + 1)}`}
            </Text>
            {item.note !== undefined && (
              <Text
                backgroundColor={selected ? palette.BAND : undefined}
                color={item.disabled === true ? palette.RULE : palette.MUTED}
              >
                {`  ${item.note} `}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** Where an arrow key moves the cursor. Pure, so navigation is testable without a TTY. */
export function moveCursor(cursor: number, count: number, key: 'up' | 'down'): number {
  if (count === 0) return 0;
  // Wraps at both ends: a menu this short is a ring, and a cursor that stops
  // dead at the last row makes the reader travel back through every item to
  // reach the one below it.
  if (key === 'down') return (cursor + 1) % count;
  return (cursor - 1 + count) % count;
}
