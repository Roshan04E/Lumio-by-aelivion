/**
 * Searchable icon/SVG source for the unified Search "Graphics" chip — Iconify's public search API
 * (https://iconify.design), no API key. Complements the offline bundled shape pack
 * (`@kimera-by-aelivion/shared`'s `searchBundledGraphics`) so Graphics always has both curated shapes and a
 * huge searchable icon set. Feature-detected: if the host is blocked (strict CSP / offline), search fails
 * soft (empty array) rather than throwing — the bundled pack still renders.
 */

export interface IconifyGraphicResult {
  id: string;
  /** "<prefix>:<name>" — Iconify's icon identifier, also used as the cache/import key. */
  iconId: string;
  name: string;
  /** SVG markup fetched on demand (only when the user imports it, to avoid N eager fetches per search). */
}

interface IconifySearchResponse {
  icons: string[];
}

const ICONIFY_SEARCH_URL = "https://api.iconify.design/search";
const ICONIFY_SVG_URL = "https://api.iconify.design";

const searchCache = new Map<string, IconifyGraphicResult[]>();
const svgCache = new Map<string, string>();

function iconLabel(iconId: string): string {
  const name = iconId.includes(":") ? iconId.split(":")[1] : iconId;
  return (name ?? iconId).replace(/[-_]/g, " ");
}

/** Search Iconify's icon set. Returns [] on any network/CSP failure — never throws into the UI. */
export async function searchIconifyGraphics(query: string, limit = 40): Promise<IconifyGraphicResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const cacheKey = `${trimmed}:${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(`${ICONIFY_SEARCH_URL}?query=${encodeURIComponent(trimmed)}&limit=${limit}`);
    if (!res.ok) return [];
    const data = (await res.json()) as IconifySearchResponse;
    const results = (data.icons ?? []).map((iconId) => ({ id: iconId, iconId, name: iconLabel(iconId) }));
    searchCache.set(cacheKey, results);
    return results;
  } catch {
    // Blocked host (CSP), offline, or a transient network error — Graphics still has the bundled pack.
    return [];
  }
}

/** Fetch one icon's raw SVG markup, cached. Returns null on failure (caller should skip that result). */
export async function fetchIconifySvg(iconId: string): Promise<string | null> {
  const cached = svgCache.get(iconId);
  if (cached) return cached;
  const [prefix, name] = iconId.split(":");
  if (!prefix || !name) return null;
  try {
    const res = await fetch(`${ICONIFY_SVG_URL}/${prefix}/${name}.svg`);
    if (!res.ok) return null;
    const svg = await res.text();
    svgCache.set(iconId, svg);
    return svg;
  } catch {
    return null;
  }
}
