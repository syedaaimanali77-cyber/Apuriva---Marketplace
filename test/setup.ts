import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// Not using vitest's `globals: true`, so @testing-library/react's automatic afterEach
// detection never fires — register cleanup explicitly so DOM doesn't leak between tests.
afterEach(() => {
  cleanup();
});

// Node 22+'s own built-in `localStorage` global (present even without `--localstorage-file`)
// shadows jsdom's implementation in this environment and doesn't implement the full Storage
// interface (no `.clear()`), unlike `sessionStorage`, which jsdom provides correctly and is left
// untouched. Spec 007 is the first code in this repo to use `localStorage`; replace the broken
// global with a minimal, spec-compliant in-memory Storage so it behaves correctly in tests.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.clear !== 'function') {
  class MemoryStorage implements Storage {
    #store = new Map<string, string>();
    get length() {
      return this.#store.size;
    }
    clear() {
      this.#store.clear();
    }
    getItem(key: string) {
      return this.#store.has(key) ? this.#store.get(key)! : null;
    }
    key(index: number) {
      return Array.from(this.#store.keys())[index] ?? null;
    }
    removeItem(key: string) {
      this.#store.delete(key);
    }
    setItem(key: string, value: string) {
      this.#store.set(key, String(value));
    }
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}
