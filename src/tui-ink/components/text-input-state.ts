/**
 * Pure line-editing state for `TextInput`.
 *
 * Split from the component for the same reason `multi-select-state.ts` is:
 * behaviour that needs a TTY to exercise is behaviour that does not get tested.
 * Everything here is a pure function of (state, action).
 */

export interface TextInputState {
  value: string;
  cursor: number;
}

export type TextInputAction =
  | { kind: 'insert'; value: string }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'end' };

export function tiInitial(value = ''): TextInputState {
  return { value, cursor: value.length };
}

export function tiReduce(state: TextInputState, action: TextInputAction): TextInputState {
  const { value, cursor } = state;
  switch (action.kind) {
    case 'insert':
      // The whole string, not its first character: ink delivers a paste as one
      // multi-character `input`, and a pasted API key truncated to one character
      // fails authentication with nothing on screen to explain why.
      return {
        value: value.slice(0, cursor) + action.value + value.slice(cursor),
        cursor: cursor + action.value.length,
      };
    case 'backspace':
      if (cursor === 0) return state;
      return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
    case 'delete':
      if (cursor >= value.length) return state;
      return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
    case 'left':
      return { value, cursor: Math.max(0, cursor - 1) };
    case 'right':
      return { value, cursor: Math.min(value.length, cursor + 1) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    default:
      return state;
  }
}
