import { Bot, GrammyError, HttpError } from 'grammy';
import { AppDataSource } from '../data-source.js';
import { User } from '../entities/User.js';
import { UserService } from '../services/user.service.js';
import { HELP_TEXT, mainMenuKeyboard } from './main-menu.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  const userRepo = AppDataSource.getRepository(User);
  const users = new UserService(userRepo);

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Ошибка при обработке update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("GrammyError:", e.description);
    } else if (e instanceof HttpError) {
      console.error("HttpError:", e);
    } else {
      console.error(e);
    }
  });

  bot.command('start', async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot) {
      await ctx.reply('Регистрация доступна только пользователям Telegram.');
      return;
    }
    const { isNew } = await users.registerFromTelegram(from);
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      'пользователь';

    const greeting = isNew
      ? `Привет, ${name}! Вы зарегистрированы в боте знакомств.`
      : `С возвращением, ${name}! Ваша учётная запись уже есть в системе.`;

    await ctx.reply(`${greeting}\n\nВыберите действие в меню ниже.`, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { reply_markup: mainMenuKeyboard() });
  });

  bot.hears('Помощь', async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.hears('Мой профиль', async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply('Профиль не найден. Нажмите /start для регистрации.');
      return;
    }

    const lines = [
      'Ваш профиль (этап регистрации):',
      `• Telegram ID: ${user.telegramId}`,
      user.username ? `• @${user.username}` : '• Username не указан',
      user.firstName || user.lastName
        ? `• Имя: ${[user.firstName, user.lastName].filter(Boolean).join(' ')}`
        : null,
      `• Зарегистрированы: ${user.createdAt.toLocaleString('ru-RU')}`,
    ].filter(Boolean);

    await ctx.reply(lines.join('\n'));
  });

  return bot;
}
