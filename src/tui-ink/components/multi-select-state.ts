export interface MsState {
  /** Index into the visible list, including the Select All row. */
  cursor: number;
  /** Original item indices, retained when the visible filter changes. */
  selected: Set<number>;
  filter: string;
}

export type MsAction =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'space' }
  | { kind: 'char'; value: string }
  | { kind: 'backspace' };

export function msInitial(itemCount: number, initialSelected: Set<number>): MsState {
  return {
    cursor: 0,
    selected: new Set([...initialSelected].filter((index) => index >= 0 && index < itemCount)),
    filter: '',
  };
}

export function msVisible(labels: string[], filter: string): number[] {
  const query = filter.toLowerCase();
  return labels.flatMap((label, index) => (
    query.length === 0 || label.toLowerCase().includes(query) ? [index] : []
  ));
}

function cursorFor(state: MsState, labels: string[], filter: string): number {
  const rowCount = msVisible(labels, filter).length + 1;
  return Math.min(state.cursor, rowCount - 1);
}

export function msReduce(state: MsState, action: MsAction, labels: string[]): MsState {
  const visible = msVisible(labels, state.filter);
  const rowCount = visible.length + 1;

  switch (action.kind) {
    case 'up':
      return { ...state, cursor: (state.cursor - 1 + rowCount) % rowCount };
    case 'down':
      return { ...state, cursor: (state.cursor + 1) % rowCount };
    case 'space': {
      const selected = new Set(state.selected);
      if (state.cursor === 0) {
        const allVisibleSelected = visible.length > 0 && visible.every((index) => selected.has(index));
        for (const index of visible) {
          if (allVisibleSelected) selected.delete(index);
          else selected.add(index);
        }
      } else {
        const index = visible[state.cursor - 1];
        if (index !== undefined) {
          if (selected.has(index)) selected.delete(index);
          else selected.add(index);
        }
      }
      return { ...state, selected };
    }
    case 'char': {
      const filter = state.filter + action.value;
      return { ...state, filter, cursor: cursorFor(state, labels, filter) };
    }
    case 'backspace': {
      const filter = state.filter.slice(0, -1);
      return { ...state, filter, cursor: cursorFor(state, labels, filter) };
    }
  }
}
