import React, { useReducer, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { tiInitial, tiReduce, type TextInputState } from './text-input-state.js';

export interface TextInputProps {
  title: string;
  hint?: string;
  /**
   * Render the value as bullets.
   *
   * Set for API keys. The terminal is not a private surface: what is printed
   * stays in scrollback, and scrollback is somewhere credentials get read from
   * later.
   */
  mask?: boolean;
  initial?: string;
  /** Rejects a value before submission; the message is shown in place. */
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
  onBack?: () => void;
  onCancel?: () => void;
}

/** Control characters, which arrive from a paste as their raw bytes. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function TextInput(props: TextInputProps): React.ReactElement {
  const { title, hint, mask = false, initial, validate, onSubmit, onBack, onCancel } = props;
  const [state, dispatch] = useReducer(tiReduce, undefined, () => tiInitial(initial));
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((input, key) => {
    if (key.escape) return onCancel?.();
    if (key.return) {
      const problem = validate?.(state.value);
      if (problem !== undefined) return setError(problem);
      return onSubmit(state.value);
    }
    // ← is text navigation first and "go back" only at the left edge. Every
    // other wizard screen uses ← for back, so it must do that here too — but a
    // line editor that leaves the screen on ← cannot be used to fix a typo.
    if (key.leftArrow) return state.cursor === 0 ? onBack?.() : dispatch({ kind: 'left' });
    if (key.rightArrow) return dispatch({ kind: 'right' });
    if (key.backspace) return dispatch({ kind: 'backspace' });
    if (key.delete) return dispatch({ kind: 'delete' });
    if (key.upArrow) return dispatch({ kind: 'home' });
    if (key.downArrow) return dispatch({ kind: 'end' });
    // Printable text only. Pasting a stray control byte into a key or a model
    // id is how a value becomes one the config writer then has to escape.
    if (input !== '' && !key.ctrl && !key.meta && !CONTROL.test(input)) {
      setError(undefined);
      dispatch({ kind: 'insert', value: input });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {hint !== undefined && <Text dimColor>{hint}</Text>}
      <Text>❯ {render(state, mask)}</Text>
      {error !== undefined && <Text color="red">{error}</Text>}
      <Text dimColor>
        enter confirm{onBack ? ' · ← back (at the start of the line)' : ''}{onCancel ? ' · esc cancel' : ''}
      </Text>
    </Box>
  );
}

function render(state: TextInputState, mask: boolean): string {
  return mask ? '•'.repeat(state.value.length) : state.value;
}
