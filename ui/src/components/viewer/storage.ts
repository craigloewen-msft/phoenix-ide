export function optionalLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readLocalStorage(key: string): string | null {
  try {
    return optionalLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocalStorage(key: string, value: string): void {
  try {
    optionalLocalStorage()?.setItem(key, value);
  } catch {
    // The in-memory preference remains usable when persistence is unavailable.
  }
}
