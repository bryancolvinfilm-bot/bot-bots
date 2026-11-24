import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
const themeKey = 'bot-bots-theme';

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const background = theme === 'dark' ? '#202124' : '#f8f7f3';
  document.documentElement.style.backgroundColor = background;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', background);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const changeTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      /* Keep the chosen theme for this session. */
    }
  }, []);
  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key !== themeKey && event.key !== null) return;
      const next = event.newValue === 'light' ? 'light' : 'dark';
      applyTheme(next);
      setTheme(next);
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return { theme, changeTheme };
}
