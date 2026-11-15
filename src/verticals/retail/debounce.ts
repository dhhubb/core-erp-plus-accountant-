/** Search input debounce. The till types fast; the search must not fire on every keystroke. */
export const SEARCH_DEBOUNCE_MS = 150;

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/**
 * Trailing-edge debounce. Calls fn once, `waitMs` after the last invocation. No timers run until
 * the first call, so nothing fires on load.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number = SEARCH_DEBOUNCE_MS,
): Debounced<A> {
  let handle: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: A): void => {
    if (handle !== undefined) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = undefined;
      fn(...args);
    }, waitMs);
  };

  debounced.cancel = (): void => {
    if (handle !== undefined) {
      clearTimeout(handle);
      handle = undefined;
    }
  };

  return debounced;
}
