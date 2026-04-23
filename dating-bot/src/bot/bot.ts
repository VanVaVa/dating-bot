import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { AppDataSource } from "../data-source.js";
import { User } from "../entities/User.js";
import { Interaction } from "../entities/Interaction.js";
import { Rating } from "../entities/Rating.js";
import { FeedCacheClient, FeedCacheService } from "../services/feed-cache.service.js";
import { ProfilePayload, ProfileService } from "../services/profile.service.js";
import { RankingService } from "../services/ranking.service.js";
import { UserService } from "../services/user.service.js";
import { HELP_TEXT, mainMenuKeyboard } from "./main-menu.js";

type ProfileStep = "age" | "gender" | "city" | "interests" | "preferredGender" | "ageMin" | "ageMax";

interface ProfileDraft {
  step: ProfileStep;
  data: Partial<ProfilePayload>;
}

const profileDrafts = new Map<number, ProfileDraft>();

const PROFILE_FLOW_HELP =
  "Заполнение анкеты идет пошагово отдельными сообщениями.\n" +
  "Отвечайте на каждый вопрос бота в чате.\n" +
  "Чтобы прервать заполнение, отправьте /cancel_profile.";

function profileLog(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.log(`[profile-flow] ${message}`, meta);
    return;
  }
  console.log(`[profile-flow] ${message}`);
}

export function createBot(token: string, redis: FeedCacheClient): Bot {
  const bot = new Bot(token);
  const userRepo = AppDataSource.getRepository(User);
  const interactionRepo = AppDataSource.getRepository(Interaction);
  const ratingRepo = AppDataSource.getRepository(Rating);
  const users = new UserService(userRepo);
  const profiles = new ProfileService(userRepo);
  const ranking = new RankingService(userRepo, interactionRepo, ratingRepo);
  const feedCache = new FeedCacheService(redis);

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

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot) {
      await ctx.reply("Регистрация доступна только пользователям Telegram.");
      return;
    }
    const { isNew } = await users.registerFromTelegram(from);
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      "пользователь";

    const greeting = isNew
      ? `Привет, ${name}! Вы зарегистрированы в боте знакомств.`
      : `С возвращением, ${name}! Ваша учётная запись уже есть в системе.`;

    await ctx.reply(`${greeting}\n\nВыберите действие в меню ниже.`, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { reply_markup: mainMenuKeyboard() });
  });

  bot.command("profile_help", async (ctx) => {
    await ctx.reply(PROFILE_FLOW_HELP, { reply_markup: mainMenuKeyboard() });
  });

  bot.command("profile_set", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    await startProfileFlow(ctx, user);
  });

  bot.command("cancel_profile", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    if (!profileDrafts.has(from.id)) {
      await ctx.reply("Сейчас нет активного заполнения анкеты.");
      return;
    }

    profileDrafts.delete(from.id);
    await ctx.reply("Заполнение анкеты отменено.", { reply_markup: mainMenuKeyboard() });
  });

  bot.command("profile", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    await showMyProfile(ctx, from.id);
  });

  bot.command("profile_delete", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await profiles.getProfileByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await profiles.deleteProfileData(user);
    await ctx.reply("Данные анкеты удалены. Можете заполнить заново через /profile_set.", {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command("browse", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    if (!isProfileReady(user)) {
      await ctx.reply(`Сначала заполните анкету.\n\n${PROFILE_FLOW_HELP}`, {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    await showNextCandidate(ctx, user.id);
  });

  bot.command("likes", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await showMyLikes(ctx, user.id);
  });

  bot.callbackQuery(/^(like|skip):/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Сначала выполните /start." });
      return;
    }

    const [type, toUserId] = ctx.callbackQuery.data.split(":") as ["like" | "skip", string];
    await ranking.saveInteraction(user.id, toUserId, type);

    if (type === "like") {
      await notifyLikeRecipient(user.id, toUserId);
    }

    await ctx.answerCallbackQuery({
      text: type === "like" ? "Лайк отправлен" : "Анкета пропущена",
    });
    await showNextCandidate(ctx, user.id);
  });

  bot.callbackQuery(/^like_reply:(yes|no):([0-9a-f-]+)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const recipient = await users.findByTelegramId(from.id);
    if (!recipient) {
      await ctx.answerCallbackQuery({ text: "Сначала выполните /start." });
      return;
    }

    const [, decision, initiatorId] = ctx.callbackQuery.data.match(
      /^like_reply:(yes|no):([0-9a-f-]+)$/,
    ) ?? [null, null, null];

    if (!decision || !initiatorId) {
      await ctx.answerCallbackQuery({ text: "Некорректный ответ на лайк." });
      return;
    }

    const initiator = await userRepo.findOne({ where: { id: initiatorId } });
    if (!initiator) {
      await ctx.answerCallbackQuery({ text: "Инициатор лайка не найден." });
      return;
    }

    if (decision === "no") {
      await ranking.saveInteraction(recipient.id, initiator.id, "skip");
      await ctx.answerCallbackQuery({ text: "Вы отклонили лайк." });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      await ctx.reply("Лайк отклонен.");
      return;
    }

    await ranking.saveInteraction(recipient.id, initiator.id, "like");
    await ctx.answerCallbackQuery({ text: "Взаимный лайк отправлен." });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);

    await ctx.reply(
      `Отлично, это взаимный лайк.\nTelegram ID инициатора: ${initiator.telegramId}`,
    );

    const opponentNick = initiatorDisplayNick(recipient);
    await bot.api
      .sendMessage(
        Number(initiator.telegramId),
        `Вам ответили взаимным лайком.\nНик оппонента: ${opponentNick}`,
      )
      .catch((error) => {
        console.error("Не удалось отправить уведомление инициатору:", error);
      });
  });

  bot.callbackQuery(/^profile_gender:(male|female|other)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const draft = profileDrafts.get(from.id);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Сначала начните заполнение анкеты." });
      return;
    }
    if (draft.step !== "gender") {
      await ctx.answerCallbackQuery({ text: "Сейчас ожидается другой шаг." });
      return;
    }

    const code = ctx.callbackQuery.data.split(":")[1];
    const gender = fromGenderCode(code);
    if (!gender) {
      await ctx.answerCallbackQuery({ text: "Не удалось обработать выбор." });
      return;
    }

    draft.data.gender = gender;
    draft.step = "city";
    profileLog("step completed via button", { telegramId: from.id, nextStep: draft.step, gender });
    await ctx.answerCallbackQuery({ text: `Выбрано: ${gender}` });
    await ctx.reply(
      "Шаг 3/7: Из какого вы города?\nПодсказка: например, Москва, Казань, Минск.",
    );
  });

  bot.callbackQuery(/^profile_pref:(male|female|other|any)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const draft = profileDrafts.get(from.id);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Сначала начните заполнение анкеты." });
      return;
    }
    if (draft.step !== "preferredGender") {
      await ctx.answerCallbackQuery({ text: "Сейчас ожидается другой шаг." });
      return;
    }

    const code = ctx.callbackQuery.data.split(":")[1];
    const preferredGender = fromPreferredGenderCode(code);
    if (!preferredGender) {
      await ctx.answerCallbackQuery({ text: "Не удалось обработать выбор." });
      return;
    }

    draft.data.preferredGender = preferredGender;
    draft.step = "ageMin";
    profileLog("step completed via button", {
      telegramId: from.id,
      nextStep: draft.step,
      preferredGender,
    });
    await ctx.answerCallbackQuery({ text: `Выбрано: ${preferredGender}` });
    await ctx.reply(
      "Шаг 6/7: Минимальный возраст партнера?\nПодсказка: число от 18 до 99.",
    );
  });

  bot.hears("Помощь", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.hears("Мой профиль", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    await showMyProfile(ctx, from.id);
  });

  bot.hears("Заполнить анкету", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }
    await startProfileFlow(ctx, user);
  });

  bot.hears("Смотреть анкеты", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    if (!isProfileReady(user)) {
      await ctx.reply(`Сначала заполните анкету.\n\n${PROFILE_FLOW_HELP}`);
      return;
    }

    await showNextCandidate(ctx, user.id);
  });

  bot.hears("Мои лайки", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await showMyLikes(ctx, user.id);
  });

  bot.on("message:text", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const draft = profileDrafts.get(from.id);
    if (!draft) return;

    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      profileDrafts.delete(from.id);
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await processProfileStep(ctx, user, draft, text, profiles, ranking);
  });

  return bot;

  async function showMyProfile(ctx: any, telegramId: number): Promise<void> {
    const user = await profiles.getProfileByTelegramId(telegramId);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }
    try {
      const combinedRating = await ranking.recalculateAndPersistForUser(user.id);
      user.combinedRating = combinedRating;
    } catch (error) {
      profileLog("rating recalc failed on profile view", {
        telegramId,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await ctx.reply(formatProfile(user), {
      reply_markup: mainMenuKeyboard(),
    });
  }

  async function showNextCandidate(ctx: any, userId: string): Promise<void> {
    let candidateId = await feedCache.popNextCandidateId(userId);

    if (!candidateId) {
      const user = await userRepo.findOne({ where: { id: userId } });
      if (!user) {
        await ctx.reply("Пользователь не найден.");
        return;
      }
      const candidates = await ranking.getRankedCandidatesFor(user, 10);
      await feedCache.cacheCandidateIds(
        user.id,
        candidates.map((item) => item.id),
      );
      candidateId = await feedCache.popNextCandidateId(userId);
    }

    if (!candidateId) {
      await ctx.reply("Пока нет подходящих анкет, попробуйте позже.");
      return;
    }

    const candidate = await userRepo.findOne({ where: { id: candidateId } });
    if (!candidate) {
      await ctx.reply("Не удалось загрузить анкету, попробуйте снова.");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("❤️ Лайк", `like:${candidate.id}`)
      .text("⏭️ Пропуск", `skip:${candidate.id}`);

    await ctx.reply(
      [
        "Кандидат:",
        `${candidate.firstName ?? "Без имени"}, ${candidate.age ?? "?"}`,
        `Город: ${candidate.city ?? "не указан"}`,
        `Интересы: ${candidate.interests ?? "не указаны"}`,
        `Рейтинг: ${candidate.combinedRating.toFixed(2)}`,
      ].join("\n"),
      { reply_markup: keyboard },
    );
  }

  async function showMyLikes(ctx: any, userId: string): Promise<void> {
    const interactions = await interactionRepo.find({
      where: { fromUserId: userId, type: "like" },
      relations: { toUser: true },
      order: { createdAt: "DESC" },
      take: 50,
    });

    if (!interactions.length) {
      await ctx.reply("Вы пока не поставили ни одного лайка.");
      return;
    }

    const uniqueByUser = new Map<string, Interaction>();
    for (const item of interactions) {
      if (!uniqueByUser.has(item.toUserId)) {
        uniqueByUser.set(item.toUserId, item);
      }
    }

    const lines = Array.from(uniqueByUser.values())
      .slice(0, 20)
      .map((item, index) => {
        const target = item.toUser;
        const name = target?.firstName ?? "Без имени";
        const age = target?.age ?? "?";
        const city = target?.city ?? "не указан";
        const date = item.createdAt.toLocaleString("ru-RU");
        return `${index + 1}. ${name}, ${age} (${city}) — лайк: ${date}`;
      });

    await ctx.reply(`Ваши последние лайки:\n\n${lines.join("\n")}`, {
      reply_markup: mainMenuKeyboard(),
    });
  }

  async function notifyLikeRecipient(fromUserId: string, toUserId: string): Promise<void> {
    const initiator = await userRepo.findOne({ where: { id: fromUserId } });
    const recipient = await userRepo.findOne({ where: { id: toUserId } });
    if (!initiator || !recipient) return;

    const keyboard = new InlineKeyboard()
      .text("👍 Ответить взаимностью", `like_reply:yes:${initiator.id}`)
      .text("👎 Отклонить", `like_reply:no:${initiator.id}`);

    const senderNick = initiatorDisplayNick(initiator);
    await bot.api
      .sendMessage(
        Number(recipient.telegramId),
        `Вам поставили лайк.\nИнициатор: ${senderNick}\nОтветить на лайк?`,
        { reply_markup: keyboard },
      )
      .catch((error) => {
        console.error("Не удалось отправить уведомление о лайке:", error);
      });
  }
}

function isProfileReady(user: User): boolean {
  return (
    user.age !== null &&
    !!user.gender &&
    !!user.city &&
    !!user.interests &&
    !!user.preferredGender &&
    user.ageMin !== null &&
    user.ageMax !== null
  );
}

function formatProfile(user: User): string {
  return [
    "Ваша анкета:",
    `${user.firstName ?? "Без имени"}${user.lastName ? ` ${user.lastName}` : ""}`,
    `Возраст: ${user.age ?? "не указан"}`,
    `Пол: ${user.gender ?? "не указан"}`,
    `Город: ${user.city ?? "не указан"}`,
    `Интересы: ${user.interests ?? "не указаны"}`,
    `Предпочитаемый пол: ${user.preferredGender ?? "не указан"}`,
    `Предпочитаемый возраст: ${user.ageMin ?? "?"}-${user.ageMax ?? "?"}`,
    `Полнота анкеты: ${user.completenessScore}%`,
    `Комбинированный рейтинг: ${user.combinedRating.toFixed(2)}`,
  ].join("\n");
}

async function startProfileFlow(ctx: any, user: User): Promise<void> {
  const telegramId = Number(user.telegramId);
  profileDrafts.set(telegramId, {
    step: "age",
    data: {},
  });
  profileLog("flow started", { telegramId, userId: user.id });

  await ctx.reply(
    "Начинаем заполнение анкеты.\n" +
      "Шаг 1/7: Сколько вам лет?\n" +
      "Подсказка: отправьте число от 18 до 99.\n\n" +
      "Для отмены в любой момент: /cancel_profile",
  );
}

async function processProfileStep(
  ctx: any,
  user: User,
  draft: ProfileDraft,
  text: string,
  profiles: ProfileService,
  ranking: RankingService,
): Promise<void> {
  const telegramId = Number(user.telegramId);
  profileLog("incoming step value", {
    telegramId,
    userId: user.id,
    step: draft.step,
    text,
  });

  switch (draft.step) {
    case "age": {
      const age = parseInteger(text);
      if (age === null || age < 18 || age > 99) {
        profileLog("validation failed: age", { telegramId, value: text });
        await ctx.reply("Возраст указан неверно. Введите число от 18 до 99.");
        return;
      }
      draft.data.age = age;
      draft.step = "gender";
      profileLog("step completed", { telegramId, nextStep: draft.step, age });
      await ctx.reply(
        "Шаг 2/7: Укажите ваш пол.\nПодсказка: нажмите кнопку ниже.",
        { reply_markup: genderKeyboard() },
      );
      return;
    }
    case "gender": {
      const normalized = normalizeGender(text);
      if (!normalized) {
        profileLog("validation failed: gender", { telegramId, value: text });
        await ctx.reply("Не понял вариант пола. Напишите: мужской, женский или другое.");
        return;
      }
      draft.data.gender = normalized;
      draft.step = "city";
      profileLog("step completed", { telegramId, nextStep: draft.step, gender: normalized });
      await ctx.reply(
        "Шаг 3/7: Из какого вы города?\nПодсказка: например, Москва, Казань, Минск.",
      );
      return;
    }
    case "city": {
      if (text.length < 2) {
        profileLog("validation failed: city", { telegramId, value: text });
        await ctx.reply("Город слишком короткий. Введите название города еще раз.");
        return;
      }
      draft.data.city = toTitleCase(text);
      draft.step = "interests";
      profileLog("step completed", { telegramId, nextStep: draft.step, city: draft.data.city });
      await ctx.reply(
        "Шаг 4/7: Напишите ваши интересы.\nПодсказка: перечислите через запятую, например: кино, спорт, путешествия.",
      );
      return;
    }
    case "interests": {
      if (text.length < 3) {
        profileLog("validation failed: interests", { telegramId, value: text });
        await ctx.reply("Интересы не распознаны. Напишите хотя бы 2-3 интереса.");
        return;
      }
      draft.data.interests = text;
      draft.step = "preferredGender";
      profileLog("step completed", {
        telegramId,
        nextStep: draft.step,
        interests: draft.data.interests,
      });
      await ctx.reply(
        "Шаг 5/7: Кого вы ищете?\nПодсказка: нажмите кнопку ниже.",
        { reply_markup: preferredGenderKeyboard() },
      );
      return;
    }
    case "preferredGender": {
      const preferredGender = normalizePreferredGender(text);
      if (!preferredGender) {
        profileLog("validation failed: preferredGender", { telegramId, value: text });
        await ctx.reply("Неверный вариант. Напишите: мужской, женский, другое или любой.");
        return;
      }
      draft.data.preferredGender = preferredGender;
      draft.step = "ageMin";
      profileLog("step completed", {
        telegramId,
        nextStep: draft.step,
        preferredGender,
      });
      await ctx.reply(
        "Шаг 6/7: Минимальный возраст партнера?\nПодсказка: число от 18 до 99.",
      );
      return;
    }
    case "ageMin": {
      const ageMin = parseInteger(text);
      if (ageMin === null || ageMin < 18 || ageMin > 99) {
        profileLog("validation failed: ageMin", { telegramId, value: text });
        await ctx.reply("Минимальный возраст указан неверно. Введите число от 18 до 99.");
        return;
      }
      draft.data.ageMin = ageMin;
      draft.step = "ageMax";
      profileLog("step completed", { telegramId, nextStep: draft.step, ageMin });
      await ctx.reply(
        `Шаг 7/7: Максимальный возраст партнера?\nПодсказка: число от ${ageMin} до 99.`,
      );
      return;
    }
    case "ageMax": {
      const ageMax = parseInteger(text);
      if (ageMax === null || ageMax < 18 || ageMax > 99) {
        profileLog("validation failed: ageMax", { telegramId, value: text });
        await ctx.reply("Максимальный возраст указан неверно. Введите число от 18 до 99.");
        return;
      }
      if (!draft.data.ageMin || ageMax < draft.data.ageMin) {
        profileLog("validation failed: age range", {
          telegramId,
          ageMin: draft.data.ageMin,
          ageMax,
        });
        await ctx.reply(
          `Максимальный возраст должен быть не меньше ${draft.data.ageMin ?? 18}. Повторите ввод.`,
        );
        return;
      }
      draft.data.ageMax = ageMax;

      const payload = toProfilePayload(draft.data);
      if (!payload) {
        profileLog("payload assembly failed", { telegramId, data: draft.data });
        await ctx.reply("Не удалось собрать анкету. Попробуйте снова через /profile_set.");
        profileDrafts.delete(telegramId);
        return;
      }

      profileLog("saving profile started", { telegramId, payload });
      try {
        const updated = await profiles.upsertProfile(user, payload);
        const combinedRating = await ranking.recalculateAndPersistForUser(updated.id);
        updated.combinedRating = combinedRating;
        profileDrafts.delete(telegramId);
        profileLog("profile saved", {
          telegramId,
          userId: user.id,
          completenessScore: updated.completenessScore,
          combinedRating,
        });
        await ctx.reply(
          `Анкета успешно сохранена.\n\n${formatProfile(updated)}\n\n` +
            "Используйте /browse или кнопку «Смотреть анкеты».",
          { reply_markup: mainMenuKeyboard() },
        );
      } catch (error) {
        profileLog("profile save failed", {
          telegramId,
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await ctx.reply(
          "Не удалось сохранить анкету из-за ошибки сервера. Попробуйте еще раз через /profile_set.",
          { reply_markup: mainMenuKeyboard() },
        );
      }
      return;
    }
  }
}

function toProfilePayload(data: Partial<ProfilePayload>): ProfilePayload | null {
  if (
    typeof data.age !== "number" ||
    typeof data.gender !== "string" ||
    typeof data.city !== "string" ||
    typeof data.interests !== "string" ||
    typeof data.preferredGender !== "string" ||
    typeof data.ageMin !== "number" ||
    typeof data.ageMax !== "number"
  ) {
    return null;
  }

  return {
    age: data.age,
    gender: data.gender,
    city: data.city,
    interests: data.interests,
    preferredGender: data.preferredGender,
    ageMin: data.ageMin,
    ageMax: data.ageMax,
  };
}

function parseInteger(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeGender(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (["м", "муж", "мужской", "male"].includes(lower)) return "мужской";
  if (["ж", "жен", "женский", "female"].includes(lower)) return "женский";
  if (["другое", "other"].includes(lower)) return "другое";
  return null;
}

function normalizePreferredGender(value: string): string | null {
  const lower = value.trim().toLowerCase();
  if (["любой", "любые", "any"].includes(lower)) return "любой";
  return normalizeGender(lower);
}

function genderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Мужской", "profile_gender:male")
    .text("Женский", "profile_gender:female")
    .row()
    .text("Другое", "profile_gender:other");
}

function preferredGenderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Мужской", "profile_pref:male")
    .text("Женский", "profile_pref:female")
    .row()
    .text("Другое", "profile_pref:other")
    .text("Любой", "profile_pref:any");
}

function fromGenderCode(code: string): string | null {
  if (code === "male") return "мужской";
  if (code === "female") return "женский";
  if (code === "other") return "другое";
  return null;
}

function fromPreferredGenderCode(code: string): string | null {
  if (code === "any") return "любой";
  return fromGenderCode(code);
}

function toTitleCase(value: string): string {
  const trimmed = value.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function initiatorDisplayNick(user: User): string {
  if (user.username) return `@${user.username}`;
  if (user.firstName) return user.firstName;
  return `user_${user.telegramId}`;
}
