import "reflect-metadata";
import "./env.js";
import { GrammyError } from "grammy";
import { createClient } from "redis";
import { AppDataSource } from "./data-source.js";
import { createBot } from "./bot/bot.js";
import { createConfiguredPhotoStorage, createEventPublisher } from "./messaging/factory.js";
import type { PhotoStorageService } from "./services/photo-storage.service.js";
import {
  listenMetricsHttp,
  telegramUpdatesTotal,
} from "./monitoring/metrics-http.js";
import type { FeedCacheClient } from "./services/feed-cache.service.js";

type RedisDriver = ReturnType<typeof createClient>;
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Задайте BOT_TOKEN в .env");
  process.exit(1);
}

await AppDataSource.initialize();
console.log("База данных подключена");

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("Задайте REDIS_URL в .env");
  process.exit(1);
}

let photoStorage: PhotoStorageService | null = createConfiguredPhotoStorage();
if (photoStorage) {
  try {
    await photoStorage.ensureBucket();
    console.log("[photos] MinIO/S3 бакет готов к загрузке изображений");
  } catch (error) {
    console.warn(
      "[photos] Не удалось автоматически создать бакет, отключаем фото до решения ошибки:",
      error,
    );
    photoStorage = null;
  }
}

const metricsPortRaw = Number.parseInt(process.env.METRICS_HTTP_PORT ?? "9100", 10);
const metricsEnabled = Number.isFinite(metricsPortRaw) && metricsPortRaw > 0;
const metricsLifecycle = metricsEnabled ? await listenMetricsHttp(metricsPortRaw) : null;
if (!metricsLifecycle) {
  console.warn("[metrics] HTTP-экспорт Prometheus отключён (METRICS_HTTP_PORT ≤ 0 или порт занят).");
}


const publisher = createEventPublisher();

function wrapRedisFeedCache(driver: RedisDriver): FeedCacheClient {
  return {
    del: (key) => driver.del(key),
    rPush: (key, elements) => driver.rPush(key, elements),
    expire: (key, seconds) => driver.expire(key, seconds),
    lPop: (key) => driver.lPop(key),
    incr: (key) => driver.incr(key),
  };
}

const inMemoryFeedCache = (): FeedCacheClient => {
  const lists = new Map<string, string[]>();
  const counters = new Map<string, number>();
  return {
    async del(key: string) {
      lists.delete(key);
      return 1;
    },
    async rPush(key: string, elements: string[]) {
      const existing = lists.get(key) ?? [];
      existing.push(...elements);
      lists.set(key, existing);
      return existing.length;
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    async lPop(key: string) {
      const existing = lists.get(key);
      if (!existing?.length) {
        return null;
      }
      const value = existing.shift() ?? null;
      if (!existing.length) {
        lists.delete(key);
      } else {
        lists.set(key, existing);
      }
      return value;
    },
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectRedisWithRetries(url: string, attempts = 8): Promise<RedisDriver | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const redis = createClient({
      url,
      socket: {
        reconnectStrategy: () => false,
        connectTimeout: 3_000,
      },
    });

    redis.on("error", (error) => {
      console.error(`Ошибка Redis (попытка ${attempt}/${attempts}):`, error.message);
    });

    try {
      await redis.connect();
      await redis.ping();
      console.log(`Redis подключен (попытка ${attempt}/${attempts})`);
      return redis;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Не удалось подключиться к Redis (попытка ${attempt}/${attempts}):`,
        message,
      );
      if (message.includes("NOAUTH")) {
        console.error("Redis требует пароль. Проверьте REDIS_URL и настройки REDIS_PASSWORD.");
      }
      try {
        if (redis.isOpen) {
          await redis.disconnect();
        }
      } catch {
        // Ignore cleanup errors between retries.
      }
    }

    if (attempt < attempts) {
      await sleep(1_500);
    }
  }

  return null;
}

const redisDriver = await connectRedisWithRetries(redisUrl);
const cacheClient: FeedCacheClient = redisDriver ? wrapRedisFeedCache(redisDriver) : inMemoryFeedCache();

if (!redisDriver) {
  console.error("Redis недоступен после повторных попыток, использую in-memory кэш ленты.");
}

const bot = createBot(token, cacheClient, publisher, photoStorage);

bot.use(async (ctx, next) => {
  const descriptor = categorizeUpdate(ctx.update);
  telegramUpdatesTotal.labels(descriptor).inc();
  await next();
});

async function shutdown(reason: string): Promise<void> {
  console.warn(`Завершение процесса: ${reason}`);
  await bot.stop();
  await publisher.close().catch(() => undefined);
  await redisDriver?.disconnect().catch(() => undefined);
  await metricsLifecycle?.close().catch(() => undefined);
  await AppDataSource.destroy().catch(() => undefined);
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await bot.start({
    onStart: (me) => {
      console.log(`Long polling запущен, бот @${me.username}`);
    },
  });
} catch (err) {
  if (err instanceof GrammyError) {
    if (err.error_code === 401) {
      console.error("Неверный BOT_TOKEN (Telegram вернул 401 Unauthorized).");
    } else if (err.error_code === 409) {
      console.error(
        "Конфликт 409: уже запущен другой экземпляр с getUpdates или активен webhook. Остановите второй процесс / снимите webhook.",
      );
    } else {
      console.error("Ошибка Telegram API:", err.description);
    }
  } else {
    console.error("Ошибка при запуске long polling:", err);
  }
  await publisher.close().catch(() => undefined);
  await redisDriver?.disconnect().catch(() => undefined);
  await metricsLifecycle?.close().catch(() => undefined);
  process.exit(1);
}

function categorizeUpdate(update: {
  message?: unknown;
  edited_message?: unknown;
  callback_query?: unknown;
  inline_query?: unknown;
}): string {
  if (update.message) return "message";
  if (update.callback_query) return "callback_query";
  if (update.edited_message) return "edited_message";
  if (update.inline_query) return "inline_query";
  return "other";
}
