import React, { useReducer } from 'react';
import { Box, Text, useInput } from 'ink';
import { rsInitial, rsReduce } from './ranked-select-state.js';

export interface RankedSelectItem<T> {
  value: T;
  label: string;
}

export interface RankedSelectProps<T> {
  title: string;
  items: Array<RankedSelectItem<T>>;
  initialRanked?: T[];
  footer?: string;
  onSubmit: (ranked: T[]) => void;
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
  const { title, items, initialRanked, footer, onSubmit, onBack, onCancel } = props;
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
    if (input === '[') {
      dispatch({ type: 'moveUp' });
      return;
    }
    if (input === ']') {
      dispatch({ type: 'moveDown' });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {items.map((item, index) => {
        const rank = state.ranked.indexOf(index);
        const marker = rank >= 0 ? `${rank + 1}.` : '·';
        return (
          <Text key={index} inverse={index === state.cursor}>
            {marker} {item.label}
          </Text>
        );
      })}
      <Text dimColor>
        {footer ?? `space toggle · [ ] rank${onBack ? ' · ← back' : ''}${onCancel ? ' · esc cancel' : ''}`}
      </Text>
    </Box>
  );
}
