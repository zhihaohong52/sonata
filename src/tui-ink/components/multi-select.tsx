import React, { useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import { msInitial, msReduce, msVisible } from './multi-select-state.js';

export interface MultiSelectItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface MultiSelectProps<T> {
  title: string;
  items: Array<MultiSelectItem<T>>;
  initialSelected?: Set<T>;
  onSubmit: (selected: T[]) => void;
  onBack?: () => void;
  onCancel?: () => void;
  filterable?: boolean;
}

const WINDOW_ROWS = 12;

function initialIndices<T>(items: Array<MultiSelectItem<T>>, initialSelected?: Set<T>): Set<number> {
  if (!initialSelected) return new Set();
  return new Set(items.flatMap((item, index) => initialSelected.has(item.value) ? [index] : []));
}

export function MultiSelect<T>(props: MultiSelectProps<T>): React.ReactElement {
  const { title, items, initialSelected, onSubmit, onBack, onCancel, filterable = true } = props;
  const labels = items.map((item) => item.label);
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof msInitial>, action: Parameters<typeof msReduce>[1]) => msReduce(current, action, labels),
    undefined,
    () => msInitial(items.length, initialIndices(items, initialSelected)),
  );
  const visible = msVisible(labels, state.filter);
  const allVisibleSelected = visible.length > 0 && visible.every((index) => state.selected.has(index));
  const rowCount = visible.length + 1;
  const start = Math.max(0, Math.min(state.cursor - Math.floor(WINDOW_ROWS / 2), rowCount - WINDOW_ROWS));
  const end = Math.min(rowCount, start + WINDOW_ROWS);

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
      onSubmit(items.filter((_, index) => state.selected.has(index)).map((item) => item.value));
      return;
    }
    if (key.upArrow || (!filterable && input === 'k')) {
      dispatch({ kind: 'up' });
      return;
    }
    if (key.downArrow || (!filterable && input === 'j')) {
      dispatch({ kind: 'down' });
      return;
    }
    if (input === ' ') {
      dispatch({ kind: 'space' });
      return;
    }
    if (filterable && key.backspace) {
      dispatch({ kind: 'backspace' });
      return;
    }
    if (filterable && input.length === 1 && /[a-zA-Z0-9._\-\/]/.test(input)) {
      dispatch({ kind: 'char', value: input });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {filterable && <Text>Filter: {state.filter}</Text>}
      <Text dimColor>
        {visible.length} of {items.length} shown · {state.selected.size} selected
      </Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {Array.from({ length: end - start }, (_, offset) => {
        const row = start + offset;
        const isToggle = row === 0;
        const index = isToggle ? undefined : visible[row - 1];
        const item = index === undefined ? undefined : items[index];
        const checked = isToggle ? allVisibleSelected : index !== undefined && state.selected.has(index);
        // Naming the count is what makes this row safe to press. It acts on the
        // *filtered* rows, so on an unfiltered 396-model list "Select All"
        // really does mean all 396 — and with a filter active it means only
        // the matches, which the bare label never distinguished.
        const label = isToggle
          ? `[ ${allVisibleSelected ? 'Deselect' : 'Select'} all ${visible.length}${state.filter === '' ? '' : ' matching'} ]`
          : item?.label ?? '';
        return (
          <Text key={isToggle ? 'toggle' : index} inverse={row === state.cursor}>
            {checked ? '◉' : '○'} {label}{item?.hint ? `  · ${item.hint}` : ''}
          </Text>
        );
      })}
      {end < rowCount && <Text dimColor>  ↓ {rowCount - end} more</Text>}
      {/*
        Filtering is on by default and the Filter field is drawn above, but the
        footer never said so — on the 396-model picker that is the difference
        between a usable list and an unusable one.
      */}
      <Text dimColor>
        ↑↓ choose · space toggle{filterable ? ' · type to filter' : ''} · enter confirm
        {onBack ? ' · ← back' : ''}{onCancel ? ' · esc cancel' : ''}
      </Text>
    </Box>
  );
}
