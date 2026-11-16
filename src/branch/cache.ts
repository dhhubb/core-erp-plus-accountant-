import { isBranchMode } from './config';

/**
 * In-process caches for branch mode (decision 13: Redis is cloud-only; a branch uses its local
 * database and in-process caches).
 *
 * These are deliberately tiny and process-local. The branch is a single process on a shop's mini
 * PC, so a Map is the whole cache. Nothing here is a source of truth: the rate-limit counter is a
 * guard, and the promotion cache holds candidates only (the validity window is re-checked in SQL at
 * evaluation time). Both rebuild from the database on a miss, so a restart loses nothing important.
 */

interface Entry {
  value: string;
  /** Epoch millis at which the entry expires, or null for no expiry. */
  expiresAt: number | null;
}

const globalForCache = globalThis as unknown as { __erpBranchCache?: Map<string, Entry> };

function store(): Map<string, Entry> {
  if (!globalForCache.__erpBranchCache) {
    globalForCache.__erpBranchCache = new Map();
  }
  return globalForCache.__erpBranchCache;
}

function get(key: string): string | null {
  const entry = store().get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
    store().delete(key);
    return null;
  }
  return entry.value;
}

function set(key: string, value: string, ttlSeconds?: number): void {
  store().set(key, {
    value,
    expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
  });
}

function del(key: string): void {
  store().delete(key);
}

/**
 * A fixed-window counter backed by the in-process map. Mirrors the Redis INCR + EXPIRE semantics:
 * the first increment in a window sets the TTL. Used only in branch mode; the cloud keeps Redis.
 */
export function inProcessIncrWithTtl(key: string, ttlSeconds: number): number {
  const now = Date.now();
  const existing = store().get(key);

  if (existing && (existing.expiresAt === null || existing.expiresAt > now)) {
    // Inside the open window: increment, and carry the window's expiry forward unchanged, exactly
    // like Redis `INCR` without a fresh `EXPIRE`.
    const count = Number.parseInt(existing.value, 10) + 1;
    store().set(key, { value: String(count), expiresAt: existing.expiresAt });
    return count;
  }

  // A new (or expired) window: open it and set the TTL, like `if (count === 1) expire(...)`.
  store().set(key, { value: '1', expiresAt: now + ttlSeconds * 1000 });
  return 1;
}

/** The subset of a Redis-like cache the branch substitutes in-process. */
export interface LocalCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** An in-process stand-in for the Redis promotion cache, used only in branch mode. */
export function inProcessPromoCache(): LocalCache {
  return {
    async get(key) {
      return get(key);
    },
    async set(key, value, _mode, ttl) {
      set(key, value, ttl);
    },
    async del(key) {
      del(key);
    },
  };
}

/** Clear the whole in-process cache. Used by tests. */
export function clearBranchCache(): void {
  store().clear();
}

export { isBranchMode };
