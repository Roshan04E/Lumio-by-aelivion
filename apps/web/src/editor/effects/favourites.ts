/**
 * Favourited catalog items (Effects tab stars). Persisted in localStorage and shared by the Effects
 * panel (toggle + Favourites bin) and the timeline right-click menu (favourite transitions submenu).
 */
const FAVOURITES_KEY = "reelforge.effectFavourites";

export function loadFavourites(): Set<string> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(FAVOURITES_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveFavourites(set: Set<string>): void {
  try {
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore (private mode / quota) */
  }
}
