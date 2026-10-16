/**
 * An entry of a map keyed by a name that came from a config, read as an own
 * property only. A plain object answers an inherited value for `constructor`,
 * `toString` and the other Object.prototype names, so a bare `map[name]` is wrong
 * wherever `name` is not already known to be a key. Imports nothing.
 */
export function ownEntry<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
