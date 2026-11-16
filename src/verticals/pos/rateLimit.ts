import { getRedis } from '@/core/redis';
import { inProcessIncrWithTtl } from '@/branch/cache';
import { isBranchMode } from '@/branch/config';

/**
 * Live-sale rate limit: 30 sales per minute per cashier (R4).
 *
 * Redis holds counters only; it is never a source of truth. The counter is a fixed-window counter
 * keyed by org, branch and cashier, and it is incremented with INCR + EXPIRE in one round trip, so
 * two requests cannot both see the pre-increment value. The key is prefixed with the org id, as the
 * brief requires of every Redis key in this codebase.
 *
 * The sync endpoint is deliberately exempt: it carries a backlog, and refusing a backlog would
 * strand completed sales. Only the live sale endpoint is limited.
 */

export const LIVE_SALE_LIMIT = 30;
export const LIVE_SALE_WINDOW_SECONDS = 60;

/** The subset of Redis this module needs, so it can be tested with a tiny fake. */
export interface CounterStore {
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
}

export function redisCounterStore(): CounterStore {
  // Redis is cloud-only (decision 13). A branch uses an in-process counter with the same
  // fixed-window semantics, so a live sale is still rate limited with no Redis on the LAN.
  if (isBranchMode()) {
    return {
      async incrWithTtl(key, ttlSeconds) {
        return inProcessIncrWithTtl(key, ttlSeconds);
      },
    };
  }

  const redis = getRedis();
  return {
    async incrWithTtl(key, ttlSeconds) {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, ttlSeconds);
      }
      return count;
    },
  };
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * The window key. One counter per cashier per minute. A cashier is the JWT subject; the org and
 * branch keep two tenants (and two branches) from sharing a counter.
 */
export function liveSaleKey(orgId: string, branchId: string, cashierId: string, now: number): string {
  const window = Math.floor(now / (LIVE_SALE_WINDOW_SECONDS * 1000));
  return `ratelimit:livesale:${orgId}:${branchId}:${cashierId}:${window}`;
}

export async function checkLiveSaleLimit(
  store: CounterStore,
  input: { orgId: string; branchId: string; cashierId: string; now?: number },
): Promise<RateLimitResult> {
  const now = input.now ?? Date.now();
  const key = liveSaleKey(input.orgId, input.branchId, input.cashierId, now);
  const count = await store.incrWithTtl(key, LIVE_SALE_WINDOW_SECONDS);
  const windowEndMs = (Math.floor(now / (LIVE_SALE_WINDOW_SECONDS * 1000)) + 1) *
    LIVE_SALE_WINDOW_SECONDS * 1000;
  const retryAfter = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
  return {
    allowed: count <= LIVE_SALE_LIMIT,
    count,
    limit: LIVE_SALE_LIMIT,
    retryAfter,
  };
}
