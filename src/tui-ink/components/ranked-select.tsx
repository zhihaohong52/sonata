import React, { useReducer } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { rsInitial, rsOrder, rsReduce } from './ranked-select-state.js';
import { INK, STATE, bar, band, columns } from '../theme.js';
import type { CandidateFacts } from '../../catalog.js';
import { usePalette } from '../theme-context.js';

export interface RankedSelectItem<T> {
  value: T;
  label: string;
  /**
   * Measured fields for the board columns. Optional: a caller with no catalog
   * (and every existing test) still passes `label` alone, and the row falls
   * back to rendering it as one span. A board that demanded facts would make
   * the unscored case unrenderable, which is the case most worth showing.
   */
  facts?: CandidateFacts;
}

export interface RankedSelectProps<T> {
  title: string;
  items: Array<RankedSelectItem<T>>;
  initialRanked?: T[];
  footer?: string;
  onSubmit: (ranked: T[]) => void;
  /**
   * Confirm this screen AND every screen after it. Passed only while later
   * screens exist, so the key never appears on the last one, where it would
   * mean exactly what `enter` already does.
   */
  onAcceptRest?: (ranked: T[]) => void;
  onBack?: () => void;
  onCancel?: () => void;
}

function initialIndices<T>(items: Array<RankedSelectItem<T>>, initialRanked: T[] = []): number[] {
  return initialRanked.flatMap((value) => {
    const index = items.findIndex((item) => Object.is(item.value, value));
    return index >= 0 ? [index] : [];
  });
}

export function RankedSelect<T>(props: RankedSelectProps<T>): React.ReactElement {
  const palette = usePalette();
  const { title, items, initialRanked, footer, onSubmit, onAcceptRest, onBack, onCancel } = props;
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof rsInitial>, action: Parameters<typeof rsReduce>[1]) => (
      rsReduce(current, action, items.length)
    ),
    undefined,
    () => rsInitial(items.length, initialIndices(items, initialRanked)),
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }
    if (key.leftArrow) {
      onBack?.();
      return;
    }
    if (key.return) {
      if (state.ranked.length > 0) {
        onSubmit(state.ranked.map((index) => items[index].value));
      }
      return;
    }
    if (key.upArrow) {
      dispatch({ type: 'up' });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: 'down' });
      return;
    }
    if (input === ' ') {
      dispatch({ type: 'toggle' });
      return;
    }
    // Guarded by the same non-empty rule as `enter`: accepting the rest must
    // not be a way to submit a ranking `enter` would have refused.
    if ((input === 'a' || input === 'A') && onAcceptRest && state.ranked.length > 0) {
      onAcceptRest(state.ranked.map((index) => items[index].value));
      return;
    }
    if (input === '[') {
      dispatch({ type: 'moveUp' });
      return;
    }
    if (input === ']') {
      dispatch({ type: 'moveDown' });
    }
  });

  const { stdout } = useStdout();
  const col = columns(stdout?.columns ?? 80);

  // The scale is shared across every row on screen, because the reader's
  // question is comparative. A bar scaled to its own row's ceiling answers a
  // question nobody asked.
  const scored = items.map((item) => item.facts).filter((f): f is CandidateFacts => f !== undefined);
  const maxCapability = Math.max(...scored.map((f) => f.capability ?? 0), 0);
  const maxCost = Math.max(...scored.map((f) => f.costPerTask ?? 0), 0);

  const order = rsOrder(state, items.length);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{title}</Text>
      </Box>
      <Text color={INK.RULE}>{'─'.repeat(col.total)}</Text>
      {order.map((index, position) => {
        const item = items[index];
        const rank = state.ranked.indexOf(index);
        const isLead = rank === 0;
        const onCursor = position === state.cursor;
        const facts = item.facts;

        // State is a stroke first; colour only ever agrees with it.
        const stateName = facts === undefined || facts.costPerTask === undefined
          ? 'unscored'
          : isLead ? 'lead' : rank >= 0 ? 'live' : 'dominated';
        const mark = STATE[stateName];

        const capFraction = maxCapability > 0 ? (facts?.capability ?? 0) / maxCapability : 0;
        const b = bar(capFraction, col.bar);

        const name = facts === undefined
          ? item.label
          : `${facts.key}${facts.effort ? ` @${facts.effort}` : ''}`;

        return (
          <Box key={index}>
            <Text color={isLead ? INK.ACCENT : INK.MUTED} bold={isLead}>
              {`${(rank >= 0 ? String(rank + 1) : '·').padStart(3)} `}
            </Text>
            <Text inverse={onCursor} color={rank < 0 && !onCursor ? palette.MUTED : undefined}>
              {name.length > col.name ? `${name.slice(0, col.name - 1)}…` : name.padEnd(col.name)}
            </Text>
            {col.showBar && facts?.capability !== undefined && (
              <Text>
                <Text color={band(capFraction)}>{b.filled}</Text>
                <Text color={INK.RULE}>{b.track}</Text>
              </Text>
            )}
            {col.showBar && facts?.capability === undefined && (
              <Text color={INK.RULE}>{'─'.repeat(col.bar)}</Text>
            )}
            <Text color={INK.MUTED}>
              {facts?.costPerTask === undefined
                ? '        —'
                : `$${facts.costPerTask.toFixed(4)}`.padStart(9)}
            </Text>
            <Text color={INK.MUTED}>
              {' '}{mark.mark}{col.showWord ? ` ${mark.word}` : ''}
            </Text>
          </Box>
        );
      })}
      {state.ranked.length === 0 && (
        <Text color={INK.MID}>
          Nothing ranked yet. Space adds a model; the order you add them is the order they are tried.
        </Text>
      )}
      <Text color={INK.RULE}>{'─'.repeat(col.total)}</Text>
      {footer !== undefined && <Text color={INK.MUTED}>{footer}</Text>}
      {/*
        Wraps between key/action pairs, never inside one. At 40 columns the
        single-Text version broke after "A" and orphaned "accept all" on the
        next line, which reads as two different things. Keys are never DROPPED
        to fit: a hidden action is worse than a second line.
      */}
      <Box flexWrap="wrap">
        {([
          ['↑↓', 'move'], ['space', 'rank'], ['[ ]', 'reorder'],
          ['enter', 'confirm', true],
          ...(onAcceptRest ? [['A', 'accept all']] : []),
          ...(onBack ? [['←', 'back']] : []),
          ...(onCancel ? [['esc', 'cancel']] : []),
        ] as Array<[string, string, boolean?]>).map(([key, action, commits]) => (
          <Text key={key}>
            <Text color={commits === true ? INK.ACCENT : INK.MUTED}>{key}</Text>
            <Text color={INK.MUTED}>{` ${action}   `}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
