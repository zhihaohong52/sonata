import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { msVisible } from './multi-select-state.js';

export interface SearchSelectItem<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SearchSelectProps<T> {
  title: string;
  items: Array<SearchSelectItem<T>>;
  onSubmit: (value: T) => void;
  onBack?: () => void;
  onCancel?: () => void;
}

const WINDOW_ROWS = 12;

/**
 * A single-select, type-to-filter list — the Add-provider catalog can run to
 * several dozen entries, too many for a plain arrow-navigated `Choice`.
 */
export function SearchSelect<T>({ title, items, onSubmit, onBack, onCancel }: SearchSelectProps<T>): React.ReactElement {
  const labels = items.map((item) => item.label);
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const visible = msVisible(labels, filter);
  const boundedCursor = visible.length === 0 ? 0 : Math.min(cursor, visible.length - 1);
  const start = Math.max(0, Math.min(boundedCursor - Math.floor(WINDOW_ROWS / 2), visible.length - WINDOW_ROWS));
  const end = Math.min(visible.length, start + WINDOW_ROWS);

  useInput((input, key) => {
    if (key.escape) return onCancel?.();
    if (key.leftArrow) return onBack?.();
    if (key.return) {
      const index = visible[boundedCursor];
      if (index !== undefined) onSubmit(items[index]!.value);
      return;
    }
    if (key.upArrow) return setCursor((c) => (visible.length === 0 ? 0 : (c - 1 + visible.length) % visible.length));
    if (key.downArrow) return setCursor((c) => (visible.length === 0 ? 0 : (c + 1) % visible.length));
    if (key.backspace) return setFilter((f) => f.slice(0, -1));
    if (input.length === 1 && /[a-zA-Z0-9._\-/ ]/.test(input)) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>Filter: {filter}</Text>
      <Text dimColor>{visible.length} of {items.length} shown</Text>
      {start > 0 && <Text dimColor>  ↑ {start} more</Text>}
      {Array.from({ length: end - start }, (_, offset) => {
        const row = start + offset;
        const index = visible[row]!;
        const item = items[index]!;
        return (
          <Text key={index} inverse={row === boundedCursor}>
            {row === boundedCursor ? '›' : ' '} {item.label}{item.hint ? `  · ${item.hint}` : ''}
          </Text>
        );
      })}
      {end < visible.length && <Text dimColor>  ↓ {visible.length - end} more</Text>}
      <Text dimColor>
        ↑↓ choose · type to filter · enter confirm{onBack ? ' · ← back' : ''}{onCancel ? ' · esc cancel' : ''}
      </Text>
    </Box>
  );
}
