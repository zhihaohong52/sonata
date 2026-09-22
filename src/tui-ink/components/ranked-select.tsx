import React, { useReducer } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { dominatedRows, rsInitial, rsOrder, rsReduce } from './ranked-select-state.js';
import { STATE, bar, columns, usableWidth } from '../theme.js';
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
  /**
   * What the bar and the capability number measure on THIS screen.
   *
   * The board draws whichever metric its tier ranks by — `complex` orders on
   * reasoning, the value tiers on agentic throughput — so the bar always
   * explains the order it appears in. Nothing said which, though, so the one
   * column carrying the comparison was unlabelled and a reader had to guess
   * whether they were looking at intelligence or something else. Reported as
   * exactly that question.
   */
  metric?: string;
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
  const { title, items, initialRanked, metric = 'capability', footer, onSubmit, onAcceptRest, onBack, onCancel } = props;
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
  const usable = usableWidth(stdout?.columns ?? 80);
  const col = columns(usable);
  // Never wider than the page: `columns` floors at 40 and a terminal can be
  // narrower, and a rule that wraps pushes the header off the screen.
  const ruleCells = Math.min(col.total, usable);

  // The scale is shared across every row on screen, because the reader's
  // question is comparative. A bar scaled to its own row's ceiling answers a
  // question nobody asked.
  const scored = items.map((item) => item.facts).filter((f): f is CandidateFacts => f !== undefined);
  const maxCapability = Math.max(...scored.map((f) => f.capability ?? 0), 0);

  // Computed once per render over every row, not per row: dominance is a
  // property of the whole screen.
  const dominated = dominatedRows(items.map((item) => item.facts));

  const order = rsOrder(state, items.length);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={palette.TEXT}>{title}</Text>
        {/* The count sits right of the head, where every other screen puts
            its note: a ranking screen's one live fact is how many of the
            offered models are actually in the list, and reading it off the
            numerals means counting them. */}
        <Text color={palette.MUTED}>
          {`   ${state.ranked.length} of ${items.length} ranked`}
        </Text>
      </Box>
      {/* Column headers. The board's rows are dense and every column is a
          different quantity; without this the bar, the number and the dollar
          figure are three unlabelled things in a row. Drawn muted and above
          the rule so it reads as a legend rather than as data. */}
      <Box>
        <Text color={palette.MUTED}>{'  # '}</Text>
        <Text color={palette.MUTED}>{'model'.padEnd(col.name)}</Text>
        {col.showBar && <Text color={palette.MUTED}>{metric.slice(0, col.bar).padEnd(col.bar)}</Text>}
        <Text color={palette.MUTED}>{'$/task'.padStart(9)}</Text>
        {col.showWord && <Text color={palette.MUTED}>{'  state'}</Text>}
      </Box>
      <Text color={palette.RULE}>{'─'.repeat(ruleCells)}</Text>
      {order.map((index, position) => {
        const item = items[index];
        const rank = state.ranked.indexOf(index);
        const isLead = rank === 0;
        const onCursor = position === state.cursor;
        const facts = item.facts;

        // State is a stroke first; colour only ever agrees with it.
        // `held`, not `dominated`, for a row the user simply did not rank:
        // `held` means "kept out by hand", which is exactly what an unranked
        // row is. `dominated` is now reserved for rows the catalog actually
        // says are beaten on both axes.
        const stateName = facts === undefined || facts.costPerTask === undefined
          ? 'unscored'
          : isLead ? 'lead'
          : rank >= 0 ? 'live'
          : dominated.has(index) ? 'dominated'
          : 'held';
        const mark = STATE[stateName];

        const capFraction = maxCapability > 0 ? (facts?.capability ?? 0) / maxCapability : 0;
        const b = bar(capFraction, col.bar);

        const name = facts === undefined
          ? item.label
          : `${facts.key}${facts.effort ? ` @${facts.effort}` : ''}`;

        return (
          <React.Fragment key={index}>
          <Box>
            {/* The accent edge, exactly as `menu.tsx` draws it and as
                claude-swap's `border-left: thick $primary` does. The board
                used Ink's `inverse` for its cursor — a reversed block that
                shares nothing with the menu's highlight, so one app
                highlighted two ways depending on which screen you were on.
                It also spent the row's whole width on emphasis, which is why
                a selected row read louder than the lead it was sitting next
                to. */}
            <Text color={palette.ACCENT}>{onCursor ? '▌' : ' '}</Text>
            <Text
              backgroundColor={onCursor ? palette.BAND : undefined}
              color={isLead ? palette.ACCENT : palette.MUTED}
              bold={isLead}
            >
              {`${(rank >= 0 ? String(rank + 1) : '·').padStart(2)} `}
            </Text>
            {/* Struck, not merely dimmed. A dominated model stays ON the
                board — something cheaper is at least as capable, so it will
                never be reached first, and hiding it would lose the reason.
                The strike says "ruled out" on the row itself, which is where
                the judgement applies; `──○` in the status column says the
                same thing in the stroke vocabulary. */}
            <Text
              backgroundColor={onCursor ? palette.BAND : undefined}
              strikethrough={stateName === 'dominated'}
              color={rank < 0 && !onCursor ? palette.MUTED : palette.TEXT}
            >
              {name.length > col.name ? `${name.slice(0, col.name - 1)}…` : name.padEnd(col.name)}
            </Text>
            {/* The bar carries magnitude by LENGTH, and its colour says only
                whether this is the lead. It used to be drawn with
                `band(capFraction)`, which is a SEVERITY ramp — green, amber,
                red at 70% and 90% — built for spend against a budget, where
                "high" is where sonata starts refusing. Capability is not
                severity, so that painted the most capable model alarm-red and
                the weakest reassuring-green: the scale ran backwards on the
                one screen whose whole job is choosing a model. */}
            {col.showBar && facts?.capability !== undefined && (
              <Text backgroundColor={onCursor ? palette.BAND : undefined} color={palette.TEXT}>
                <Text color={isLead ? palette.ACCENT : palette.TEXT}>{b.filled}</Text>
                <Text color={palette.RULE}>{b.track}</Text>
              </Text>
            )}
            {col.showBar && facts?.capability === undefined && (
              <Text backgroundColor={onCursor ? palette.BAND : undefined} color={palette.RULE}>
                {'─'.repeat(col.bar)}
              </Text>
            )}
            {/* Plain ink. There is no severity axis on this screen, and two
                attempts to find one both inverted.
                
                Colouring the BAR by capability painted the strongest model
                alarm-red. Moving the ramp to cost was no better: on `complex`
                the lead is the most expensive candidate, so red would mark
                the tier's own recommended choice as a problem — and the
                meaning flips between tiers, since `simple` is cost-capped and
                dear really is wrong there, while `complex` exists to pay. A
                colour that means opposite things on two screens carries
                nothing.
                
                This is a comparison screen, not a monitoring one: a model is
                cheap or dear, weak or strong, and which of those is wanted is
                the tier's business. `band()` belongs to spend against a
                budget, where "high" means approaching a refusal, and that is
                the one place it is true. */}
            <Text backgroundColor={onCursor ? palette.BAND : undefined} color={palette.MUTED}>
              {facts?.costPerTask === undefined
                ? '        —'
                : `$${facts.costPerTask.toFixed(4)}`.padStart(9)}
            </Text>
            <Text backgroundColor={onCursor ? palette.BAND : undefined} color={palette.MUTED}>
              {' '}{mark.mark}{col.showWord ? ` ${mark.word}` : ''}
            </Text>
          </Box>
          {/* The lead sits above a rule, apart from the rest. It is the one
              row that answers "what runs if I dispatch right now", and in an
              undifferentiated run of rows that question has to be answered by
              finding the numeral 1. Drawn only when something follows it, so
              a one-row list does not end in a rule against nothing. */}
          {isLead && position + 1 < order.length && (
            <Text color={palette.RULE}>{'┄'.repeat(ruleCells)}</Text>
          )}
          </React.Fragment>
        );
      })}
      {state.ranked.length === 0 && (
        <Text color={palette.MID}>
          Nothing ranked yet. Space adds a model; the order you add them is the order they are tried.
        </Text>
      )}
      <Text color={palette.RULE}>{'─'.repeat(ruleCells)}</Text>
      {footer !== undefined && <Text color={palette.MUTED}>{footer}</Text>}
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
            <Text color={commits === true ? palette.ACCENT : palette.MUTED}>{key}</Text>
            <Text color={palette.MUTED}>{` ${action}   `}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
