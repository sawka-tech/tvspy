// Theme choice (system / light / dark), kept per browser. Storage may be unavailable (private mode),
// in which case the choice lasts until reload.

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'tvspy.theme';

export function storedTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Not persisted; fine.
  }
}
