import React, { createContext, useContext, useMemo, useState } from 'react';
import { Box, useWindowSize } from 'ink';
import { paletteFor, resolveThemeName, usableWidth, type Palette, type ThemeName } from './theme.js';

interface ThemeValue {
  palette: Palette;
  name: ThemeName;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | undefined>(undefined);

/**
 * The active palette, and the toggle that flips it.
 *
 * A context rather than a module constant because the theme changes at
 * runtime: `resolveThemeName` can only guess from `COLORFGBG`, which most
 * terminals never set, so the user needs a way to say "you guessed wrong"
 * without restarting. A module-level palette could not re-render on that.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [name, setName] = useState<ThemeName>(() => resolveThemeName());
  const value = useMemo<ThemeValue>(() => ({
    palette: paletteFor(name),
    name,
    toggle: () => setName((current) => (current === 'dark' ? 'light' : 'dark')),
  }), [name]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Falls back to the resolved palette rather than throwing when no provider is
 * above it. A component rendered in a test, or reached by a path that has not
 * been wrapped yet, should draw in sensible colours rather than crash — the
 * theme is a presentation detail and never worth failing a screen over.
 */
export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (value !== undefined) return value;
  const name = resolveThemeName();
  return { palette: paletteFor(name), name, toggle: () => {} };
}

/** The active palette. Shorthand for `useTheme().palette`, so a component that only draws does not see the toggle. */
export function usePalette(): Palette {
  return useTheme().palette;
}

/**
 * The screen's own ground.
 *
 * Ink draws on whatever the terminal already is, so without this the app is
 * ink floating on someone else's background — which is why the light theme
 * did not work: switching it only darkened the text on a still-dark
 * terminal, and the near-white selected band collided with the terminal's own
 * light foreground until the row vanished. Painting the ground is what makes
 * a theme a theme, and it is what claude-swap does (Textual fills `$background`
 * before any widget draws).
 *
 * Sized to the terminal so the fill reaches the edges: a Box wraps its content
 * otherwise, and a background that stops where the text stops is a rectangle
 * behind the words rather than a page.
 *
 * **One column short of the terminal, and that is load-bearing.** At exactly
 * `columns` Ink emits no background at all — measured on ink 7.1.1 in a
 * 60-column pane, where width 59 padded and filled every row and width 60
 * produced bare text with no fill on any of them. A full-width run of padding
 * would wrap onto the next line, so the trailing spaces that carry the colour
 * are trimmed, and trimming them removes the background with them. The
 * symptom is not a missing last column, it is a ragged page: rows that happen
 * to set their own background (the selected band) keep it and every other row
 * shows the terminal through. `minHeight` is one short of the row count for a
 * related reason — filling the final row scrolls the terminal by one line, so
 * the top of the app walks off the scrollback on every repaint.
 */
export function Ground({ children }: { children: React.ReactNode }): React.ReactElement {
  const palette = usePalette();
  // Subscribed, never read once. Ink re-lays-out its existing tree on a resize
  // but does not re-run a component unless its state changes, so a size read
  // from `process.stdout` during render stays at whatever it was when the
  // ground was first drawn. Shrinking the terminal then left a page wider
  // than the window: every line wrapped, the header scrolled off, and the
  // screen read as blank — reported as exactly that. `useWindowSize`
  // re-renders on every resize.
  const { columns, rows } = useWindowSize();
  return (
    <Box
      flexDirection="column"
      backgroundColor={palette.BG}
      width={usableWidth(columns)}
      minHeight={Math.max(1, rows - 1)}
    >
      {children}
    </Box>
  );
}
