import Redis from 'ioredis';

/**
 * One process-wide Redis client, cached on globalThis so a Next.js dev/hot-reload does not leak a
 * connection per reload. Redis is used only for the promotion candidate cache (and rate limiting
 * in a later item); it is never a source of truth. A cached promotion is still checked against its
 * validity window before it is applied, so a stale entry cannot apply an expired promotion.
 */
const globalForRedis = globalThis as unknown as { __erpRedis?: Redis };

export function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
}

export function getRedis(): Redis {
  if (!globalForRedis.__erpRedis) {
    globalForRedis.__erpRedis = new Redis(redisUrl(), {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
  }
  return globalForRedis.__erpRedis;
}

export async function closeRedis(): Promise<void> {
  if (globalForRedis.__erpRedis) {
    await globalForRedis.__erpRedis.quit();
    delete globalForRedis.__erpRedis;
  }
}
