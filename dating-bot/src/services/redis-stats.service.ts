import type { FeedCacheClient } from "./feed-cache.service.js";

/** TTL счётчиков активности — несколько дней, чтобы ключи не копились в Redis. */
const STATS_COUNTER_TTL_SECONDS = 60 * 60 * 72;

/**
 * Дневной счётчик «активности продуктовой воронки» (не Celery-брокер).
 * Отдельный тип ключей от ленты (`feed:*`), чтобы Redis использовался двумя независимыми сценариями.
 */
export async function recordDailyActiveSessionPing(cache: FeedCacheClient): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `stats:daily:active_sessions:${day}`;
  await cache.incr(key);
  await cache.expire(key, STATS_COUNTER_TTL_SECONDS);
}
