import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { ColorTheme, ThemeMode } from '@/shared/types';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  colorTheme: ColorTheme;
  setColorTheme: (theme: ColorTheme) => void;
};

const COLOR_THEMES: readonly ColorTheme[] = ['default', 'evergreen', 'contrast'];

/** The stored colour theme; anything unknown (or nothing) is the original look. */
const readStoredColorTheme = (): ColorTheme => {
  const saved = readUserPreference<string | null>('colorTheme', null);
  return COLOR_THEMES.includes(saved as ColorTheme) ? (saved as ColorTheme) : 'default';
};

/** Page backgrounds per theme and mode, for the browser's theme-color (mobile status bar). */
const THEME_COLOR: Record<ColorTheme, { light: string; dark: string }> = {
  default: { light: '#f6f4ef', dark: '#141414' },
  evergreen: { light: '#f6f7f4', dark: '#111613' },
  contrast: { light: '#ffffff', dark: '#000000' },
};

/** Puts the colour theme on <html>, where src/index.css picks it up. The default theme has no attribute. */
const applyColorTheme = (theme: ColorTheme): void => {
  if (theme === 'default') {
    delete document.documentElement.dataset.colorTheme;
  } else {
    document.documentElement.dataset.colorTheme = theme;
  }
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Reads the stored preference as a theme mode.
 *
 * Only `'dark'` and `'light'` were ever written before the system option
 * existed, so anything else — `'system'`, an absent value, or a value a newer
 * client wrote — means "follow the OS", which is also the default.
 */
const readStoredThemeMode = (): ThemeMode => {
  const savedTheme = readUserPreference<string | null>('theme', null);
  return savedTheme === 'dark' || savedTheme === 'light' ? savedTheme : 'system';
};

/** Whether the OS currently asks for a dark appearance; false when unknown. */
const prefersDarkAppearance = (): boolean =>
  Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);

/** The colour a mode resolves to right now. */
const resolveIsDarkMode = (mode: ThemeMode): boolean =>
  mode === 'system' ? prefersDarkAppearance() : mode === 'dark';

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/** Mounted once by App so every module can read and switch light/dark mode and the colour theme through useTheme. */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  // The mode the user chose, not the colour it currently resolves to: only the
  // mode is persisted, and `system` has to keep tracking the OS afterwards.
  // Read synchronously from the preference mirror so the very first paint is
  // already the right colour.
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredThemeMode);
  // The resolved colour. It is not derivable from `themeMode` alone, because
  // under `system` it changes when the OS does, with no state change here.
  const [isDarkMode, setIsDarkMode] = useState(() => resolveIsDarkMode(readStoredThemeMode()));
  // The colour theme the user picked. Applied in the initializer as well as the
  // effect below, so the first paint already uses it instead of flashing the default.
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(() => {
    const stored = readStoredColorTheme();
    applyColorTheme(stored);
    return stored;
  });

  // The theme now lives in auth.db, so a change made on another device (or in
  // another tab) arrives through the preference store rather than a re-render.
  useEffect(() => subscribeToUserPreferences(() => {
    const storedMode = readStoredThemeMode();
    setThemeModeState(storedMode);
    setIsDarkMode(resolveIsDarkMode(storedMode));
    setColorThemeState(readStoredColorTheme());
  }), []);

  useEffect(() => {
    applyColorTheme(colorTheme);
  }, [colorTheme]);

  // Applying the theme to the document and persisting it are deliberately
  // separate. Persisting from here would also fire on mount — before the stored
  // theme had been fetched — writing this device's system default over the
  // theme the user actually chose on another one.
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');

      // Update iOS status bar style and theme color for dark mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'black-translucent');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', THEME_COLOR[colorTheme].dark);
      }
    } else {
      document.documentElement.classList.remove('dark');

      // Update iOS status bar style and theme color for light mode
      const statusBarMeta = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      if (statusBarMeta) {
        statusBarMeta.setAttribute('content', 'default');
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        themeColorMeta.setAttribute('content', THEME_COLOR[colorTheme].light);
      }
    }
  }, [isDarkMode, colorTheme]);

  // Listen for system theme changes
  useEffect(() => {
    if (!window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      // Re-read rather than close over `themeMode`: a change that arrived from
      // another device lands in the store first, and only `system` follows the OS.
      if (readStoredThemeMode() === 'system') {
        setIsDarkMode(e.matches);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // The only writer: a theme is stored because the user picked it, never
  // because this device happened to start on one.
  const setThemeMode = useCallback((mode: ThemeMode) => {
    writeUserPreference('theme', mode);
    setThemeModeState(mode);
    setIsDarkMode(resolveIsDarkMode(mode));
  }, []);

  // Like setThemeMode: stored only because the user picked it.
  const setColorTheme = useCallback((theme: ColorTheme) => {
    writeUserPreference('colorTheme', theme);
    setColorThemeState(theme);
  }, []);

  // Kept for the callers that only offer a light/dark switch: choosing either
  // one is an explicit choice, so it leaves `system` behind exactly as before.
  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((previous) => {
      const next = !previous;
      writeUserPreference('theme', next ? 'dark' : 'light');
      setThemeModeState(next ? 'dark' : 'light');
      return next;
    });
  }, []);

  // A fresh object here would re-render every consumer in the app on any
  // render of this provider, theme change or not.
  const value = useMemo<ThemeContextValue>(
    () => ({ isDarkMode, toggleDarkMode, themeMode, setThemeMode, colorTheme, setColorTheme }),
    [isDarkMode, toggleDarkMode, themeMode, setThemeMode, colorTheme, setColorTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};
