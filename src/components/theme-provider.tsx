"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/** Kept in sync with the anti-FOUC script in src/app/layout.tsx. */
export const THEME_KEY = "xavage-theme";
export const DEFAULT_THEME: Theme = "dark";

/** The chrome colour the mobile browser bar paints, per theme. */
const THEME_COLOR: Record<Theme, string> = { dark: "#06060c", light: "#f4f5fa" };

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}>({ theme: DEFAULT_THEME, setTheme: () => {}, toggle: () => {} });

export const useTheme = () => useContext(ThemeContext);

function apply(theme: Theme) {
  const root = document.documentElement;
  // Suppress transitions for one frame so a flip repaints instantly instead
  // of cross-fading every panel, chip and border on the page.
  root.classList.add("theme-switching");
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[theme]);
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => root.classList.remove("theme-switching"));
  });
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The inline script has already stamped data-theme before first paint, so
  // read it back rather than guessing -- that keeps the first client render
  // identical to what is already on screen.
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    const stamped = document.documentElement.dataset.theme;
    if (stamped === "light" || stamped === "dark") setThemeState(stamped);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    apply(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode / blocked storage: the choice just won't persist */
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
    [setTheme],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
