import { describe, it, expect } from 'vitest';

import { tiInitial, tiReduce } from '../../src/tui-ink/components/text-input-state.js';

describe('tiInitial', () => {
  it('starts empty with the cursor at zero', () => {
    expect(tiInitial()).toEqual({ value: '', cursor: 0 });
  });

  it('puts the cursor at the end of a pre-filled value', () => {
    expect(tiInitial('sk-abc')).toEqual({ value: 'sk-abc', cursor: 6 });
  });
});

describe('tiReduce', () => {
  it('inserts a character at the cursor', () => {
    expect(tiReduce({ value: 'ac', cursor: 1 }, { kind: 'insert', value: 'b' }))
      .toEqual({ value: 'abc', cursor: 2 });
  });

  it('inserts a whole paste rather than its first character', () => {
    // Ink delivers a paste as one multi-character `input`. Taking input[0]
    // silently truncates a pasted API key to one character, which then fails
    // authentication with nothing on screen to explain it.
    expect(tiReduce({ value: '', cursor: 0 }, { kind: 'insert', value: 'sk-longkey' }))
      .toEqual({ value: 'sk-longkey', cursor: 10 });
  });

  it('backspace removes the character before the cursor', () => {
    expect(tiReduce({ value: 'abc', cursor: 2 }, { kind: 'backspace' }))
      .toEqual({ value: 'ac', cursor: 1 });
  });

  it('backspace at position 0 is a no-op', () => {
    expect(tiReduce({ value: 'abc', cursor: 0 }, { kind: 'backspace' }))
      .toEqual({ value: 'abc', cursor: 0 });
  });

  it('delete removes the character under the cursor', () => {
    expect(tiReduce({ value: 'abc', cursor: 1 }, { kind: 'delete' }))
      .toEqual({ value: 'ac', cursor: 1 });
  });

  it('delete at the end is a no-op', () => {
    expect(tiReduce({ value: 'abc', cursor: 3 }, { kind: 'delete' }))
      .toEqual({ value: 'abc', cursor: 3 });
  });

  it('left and right move the cursor', () => {
    expect(tiReduce({ value: 'abc', cursor: 2 }, { kind: 'left' }).cursor).toBe(1);
    expect(tiReduce({ value: 'abc', cursor: 1 }, { kind: 'right' }).cursor).toBe(2);
  });

  it('clamps the cursor at both ends', () => {
    expect(tiReduce({ value: 'abc', cursor: 0 }, { kind: 'left' }).cursor).toBe(0);
    expect(tiReduce({ value: 'abc', cursor: 3 }, { kind: 'right' }).cursor).toBe(3);
  });

  it('home and end jump to the ends', () => {
    expect(tiReduce({ value: 'abc', cursor: 1 }, { kind: 'home' }).cursor).toBe(0);
    expect(tiReduce({ value: 'abc', cursor: 1 }, { kind: 'end' }).cursor).toBe(3);
  });

  it('never mutates the state it is given', () => {
    const state = { value: 'abc', cursor: 1 };
    tiReduce(state, { kind: 'insert', value: 'x' });
    expect(state).toEqual({ value: 'abc', cursor: 1 });
  });
});
