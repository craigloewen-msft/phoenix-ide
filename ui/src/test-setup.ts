// Test setup
import '@testing-library/jest-dom';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});

// Mock IndexedDB for tests
global.indexedDB = {} as unknown as IDBFactory;

// Mock navigator.storage
Object.defineProperty(navigator, 'storage', {
  writable: true,
  value: {
    estimate: () => Promise.resolve({ usage: 0, quota: 0 }),
  },
});
