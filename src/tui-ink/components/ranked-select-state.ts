export interface RsState {
  /** Index into the item list under the cursor. */
  cursor: number;
  /** Original item indices, ordered from highest to lowest priority. */
  ranked: number[];
}

export type RsAction =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'toggle' }
  | { type: 'moveUp' }
  | { type: 'moveDown' };

export function rsInitial(itemCount: number, initialRanked: number[]): RsState {
  return {
    cursor: 0,
    ranked: [...new Set(initialRanked)].filter((index) => index >= 0 && index < itemCount),
  };
}

export function rsReduce(state: RsState, action: RsAction, itemCount: number): RsState {
  const maxCursor = Math.max(0, itemCount - 1);

  switch (action.type) {
    case 'up':
      return { ...state, cursor: Math.max(0, state.cursor - 1) };
    case 'down':
      return { ...state, cursor: Math.min(maxCursor, state.cursor + 1) };
    case 'toggle': {
      const ranked = [...state.ranked];
      const position = ranked.indexOf(state.cursor);
      if (position >= 0) ranked.splice(position, 1);
      else if (state.cursor >= 0 && state.cursor < itemCount) ranked.push(state.cursor);
      return { ...state, ranked };
    }
    case 'moveUp': {
      const position = state.ranked.indexOf(state.cursor);
      if (position <= 0) return state;
      const ranked = [...state.ranked];
      [ranked[position - 1], ranked[position]] = [ranked[position], ranked[position - 1]];
      return { ...state, ranked };
    }
    case 'moveDown': {
      const position = state.ranked.indexOf(state.cursor);
      if (position < 0 || position >= state.ranked.length - 1) return state;
      const ranked = [...state.ranked];
      [ranked[position], ranked[position + 1]] = [ranked[position + 1], ranked[position]];
      return { ...state, ranked };
    }
  }
}
