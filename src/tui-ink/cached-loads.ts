/**
 * The two big cache files the wizard consults on every render.
 *
 * `loadModelsDev` (~1.7 MB) and `loadAaCatalog` were called from the render
 * body, so every keypress re-read and re-parsed them — and, because each parse
 * made a fresh object, the `familiesOf` WeakMap in `src/catalog.ts` never hit.
 * Keyed on the file's identity (path, size, mtime) rather than loaded once: a
 * catalog refresh mid-wizard rewrites the file, which changes its mtime, and
 * the next call sees fresh data; otherwise the same object comes back.
 */
import { statSync } from 'node:fs';

import { aaCatalogPath, loadAaCatalog, type AaCatalog } from '../catalog.js';
import { loadModelsDev, modelsDevPath, type ModelsDevCache } from '../modelsdev.js';

function cachedBy<T>(pathOf: (home: string) => string, load: (home: string) => T | undefined): (home: string) => T | undefined {
  const cache = new Map<string, { path: string; size: number; mtimeMs: number; value: T | undefined }>();
  return (home) => {
    const path = pathOf(home);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(path); } catch { cache.delete(home); return load(home); }
    const hit = cache.get(home);
    if (hit !== undefined && hit.path === path && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
    const value = load(home);
    cache.set(home, { path, size: st.size, mtimeMs: st.mtimeMs, value });
    return value;
  };
}

export const loadModelsDevCached: (home: string) => ModelsDevCache | undefined = cachedBy(modelsDevPath, loadModelsDev);
export const loadAaCatalogCached: (home: string) => AaCatalog | undefined = cachedBy(aaCatalogPath, loadAaCatalog);
