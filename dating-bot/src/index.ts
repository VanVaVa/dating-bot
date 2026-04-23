import "reflect-metadata";
import "./env.js";
import { GrammyError } from "grammy";
import { createClient } from "redis";
import { AppDataSource } from "./data-source.js";
import { createBot } from "./bot/bot.js";
import { FeedCacheClient } from "./services/feed-cache.service.js";

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

const inMemoryFeedCache = (): FeedCacheClient => {
  const store = new Map<string, string[]>();
  return {
    async del(key: string) {
      store.delete(key);
      return 1;
    },
    async rPush(key: string, elements: string[]) {
      const existing = store.get(key) ?? [];
      existing.push(...elements);
      store.set(key, existing);
      return existing.length;
    },
    async expire() {
      return 1;
    },
    async lPop(key: string) {
      const existing = store.get(key);
      if (!existing?.length) {
        return null;
      }
      const value = existing.shift() ?? null;
      if (!existing.length) {
        store.delete(key);
      } else {
        store.set(key, existing);
      }
      return value;
    },
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectRedisWithRetries(url: string, attempts = 8): Promise<FeedCacheClient | null> {
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

const redisClient = await connectRedisWithRetries(redisUrl);
const cacheClient: FeedCacheClient = redisClient ?? inMemoryFeedCache();

if (!redisClient) {
  console.error("Redis недоступен после повторных попыток, использую in-memory кэш ленты.");
}

const bot = createBot(token, cacheClient);

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
  process.exit(1);
}
