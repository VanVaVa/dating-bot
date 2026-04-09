import "reflect-metadata";
import "./env.js";
import { GrammyError } from "grammy";
import { AppDataSource } from "./data-source.js";
import { createBot } from "./bot/bot.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Задайте BOT_TOKEN в .env");
  process.exit(1);
}

await AppDataSource.initialize();
console.log("База данных подключена");

const bot = createBot(token);

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
