import React, { createContext, useContext, useMemo, useState } from 'react';
import { paletteFor, resolveThemeName, type Palette, type ThemeName } from './theme.js';

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

export function usePalette(): Palette {
  return useTheme().palette;
}
