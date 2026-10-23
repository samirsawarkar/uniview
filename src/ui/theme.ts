export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "uniview.theme.v1";

export function getTheme(): Theme {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") {
      return val;
    }
    return "light";
  } catch {
    return "light";
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, t);
  } catch {
    // ignore storage errors
  }
  applyTheme(t);
}
