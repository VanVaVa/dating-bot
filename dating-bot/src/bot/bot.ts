import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import { AppDataSource } from "../data-source.js";
import { Interaction } from "../entities/Interaction.js";
import { Photo } from "../entities/Photo.js";
import { Rating } from "../entities/Rating.js";
import { Referral } from "../entities/Referral.js";
import { User } from "../entities/User.js";
import { UserMetric } from "../entities/UserMetric.js";
import type { EventPublisher } from "../messaging/domain-events.js";
import { profileFlowErrorsTotal } from "../monitoring/metrics-http.js";
import { FeedCacheClient, FeedCacheService } from "../services/feed-cache.service.js";
import type { PhotoStorageService } from "../services/photo-storage.service.js";
import { ProfilePayload, ProfileService } from "../services/profile.service.js";
import { RankingService } from "../services/ranking.service.js";
import { ReferralService } from "../services/referral.service.js";
import { recordDailyActiveSessionPing } from "../services/redis-stats.service.js";
import { UserService } from "../services/user.service.js";
import { HELP_TEXT, mainMenuKeyboard } from "./main-menu.js";

type ProfileStep =
  | "age"
  | "gender"
  | "city"
  | "interests"
  | "preferredGender"
  | "ageMin"
  | "ageMax"
  | "photo";

interface ProfileDraft {
  step: ProfileStep;
  data: Partial<ProfilePayload>;
}

function nextStepAfter(step: ProfileStep): ProfileStep | null {
  const order: ProfileStep[] = [
    "age",
    "gender",
    "city",
    "interests",
    "preferredGender",
    "ageMin",
    "ageMax",
    "photo",
  ];
  const idx = order.indexOf(step);
  if (idx === -1 || idx >= order.length - 1) return null;
  return order[idx + 1] ?? null;
}

function hasSavedValueForStep(user: User, step: ProfileStep): boolean {
  switch (step) {
    case "age":
      return user.age !== null && user.age !== undefined;
    case "gender":
      return !!user.gender;
    case "city":
      return !!user.city;
    case "interests":
      return !!user.interests;
    case "preferredGender":
      return !!user.preferredGender;
    case "ageMin":
      return user.ageMin !== null && user.ageMin !== undefined;
    case "ageMax":
      return user.ageMax !== null && user.ageMax !== undefined;
    case "photo":
      return (user.photos?.length ?? 0) > 0;
  }
}

const profileDrafts = new Map<number, ProfileDraft>();
const awaitingPhotoUploads = new Set<number>();

const PROFILE_FLOW_HELP =
  "Заполнение анкеты идет пошагово отдельными сообщениями (8 шагов; в конце — фото).\n" +
  "Отвечайте на каждый вопрос бота в чате. Если поле уже было сохранено, можно нажать «Оставить как есть».\n" +
  "Чтобы прервать заполнение, отправьте /cancel_profile.";

function profileLog(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.log(`[profile-flow] ${message}`, meta);
    return;
  }
  console.log(`[profile-flow] ${message}`);
}

export function createBot(
  token: string,
  redis: FeedCacheClient,
  publisher: EventPublisher,
  photoStorage: PhotoStorageService | null,
): Bot {
  const bot = new Bot(token);
  const userRepo = AppDataSource.getRepository(User);
  const interactionRepo = AppDataSource.getRepository(Interaction);
  const ratingRepo = AppDataSource.getRepository(Rating);
  const photoRepo = AppDataSource.getRepository(Photo);
  const referralRepo = AppDataSource.getRepository(Referral);
  const metricsRepo = AppDataSource.getRepository(UserMetric);

  const users = new UserService(userRepo);
  const referrals = new ReferralService(userRepo, referralRepo, publisher);
  const profiles = new ProfileService(userRepo, publisher);
  const ranking = new RankingService(
    userRepo,
    interactionRepo,
    ratingRepo,
    metricsRepo,
    publisher,
  );
  const feedCache = new FeedCacheService(redis);

  async function deleteStoredPhotos(userId: string): Promise<void> {
    const stored = await photoRepo.find({ where: { userId } });
    if (!stored.length) {
      await photoRepo.delete({ userId });
      return;
    }

    if (photoStorage) {
      await Promise.all(
        stored.map((photo) =>
          photoStorage.deleteObject(photo.s3Key).catch((error) => {
            console.error(
              `[profile-photos] Не удалось удалить объект ${photo.s3Key} пользователя ${userId} из MinIO/S3`,
              error,
            );
          }),
        ),
      );
    }

    await photoRepo.delete({ userId });
  }

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

    const startPayload = extractStartPayload(ctx.message?.text);
    const { user, isNew } = await users.registerFromTelegram(from);
    await referrals.tryAttachReferral(user, startPayload);

    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') ||
      "пользователь";

    const greeting = isNew
      ? `Привет, ${name}! Вы зарегистрированы в боте знакомств.`
      : `С возвращением, ${name}! Ваша учётная запись уже есть в системе.`;

    const inviteHint = referrals.inviteHint(user);
    await ctx.reply(
      `${greeting}${
        inviteHint ? `\n\n${inviteHint}` : ""
      }\n\nВыберите действие в меню ниже.`,
      {
        reply_markup: mainMenuKeyboard(),
      },
    );

    void recordDailyActiveSessionPing(redis).catch((error: unknown) => {
      console.error("[redis-stats] Не удалось записать счётчик активности:", error);
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
    awaitingPhotoUploads.delete(from.id);
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

    await deleteStoredPhotos(user.id);
    awaitingPhotoUploads.delete(from.id);

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

  bot.command("matches", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await showMatches(ctx, user.id);
  });

  bot.command("invite", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    await ctx.reply(`${referrals.inviteHint(user) ?? "Не удалось сформировать код приглашения."}`, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.command("upload_photo", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    if (!photoStorage) {
      await ctx.reply("Загрузка фото временно недоступна — не настроен MinIO/S3.");
      return;
    }

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    awaitingPhotoUploads.add(from.id);
    await ctx.reply(
      [
        "Отправьте одно сообщение с фото (можно без подписи).",
        `Лимит: до 5 фото на аккаунт.`,
        `Для отмены отправьте /cancel_photo.`,
      ].join("\n"),
    );
  });

  bot.command("cancel_photo", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    awaitingPhotoUploads.delete(from.id);
    await ctx.reply("Режим загрузки фото отменён.", { reply_markup: mainMenuKeyboard() });
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
    const u = (await loadUserWithPhotos(from.id)) ?? (await users.findByTelegramId(from.id));
    if (!u) {
      await ctx.reply("Профиль не найден.");
      return;
    }
    await sendPromptForStep(ctx, draft, u);
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
    const u = (await loadUserWithPhotos(from.id)) ?? (await users.findByTelegramId(from.id));
    if (!u) {
      await ctx.reply("Профиль не найден.");
      return;
    }
    await sendPromptForStep(ctx, draft, u);
  });

  bot.callbackQuery(/^profile_keep:(age|gender|city|interests|preferredGender|ageMin|ageMax|photo)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const step = ctx.callbackQuery.data.split(":")[1] as ProfileStep;
    const draft = profileDrafts.get(from.id);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: "Сначала начните заполнение анкеты." });
      return;
    }
    if (draft.step !== step) {
      await ctx.answerCallbackQuery({ text: "Сейчас ожидается другой шаг." });
      return;
    }

    const user = await loadUserWithPhotos(from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Профиль не найден." });
      return;
    }
    if (!hasSavedValueForStep(user, step)) {
      await ctx.answerCallbackQuery({ text: "Нет сохранённого значения для этого шага." });
      return;
    }

    if (step === "photo") {
      await ctx.answerCallbackQuery({ text: "Сохраняем анкету с текущими фото…" });
      await finalizeProfileDraft(ctx, user, draft);
      return;
    }

    switch (step) {
      case "age":
        draft.data.age = user.age as number;
        break;
      case "gender":
        draft.data.gender = user.gender as string;
        break;
      case "city":
        draft.data.city = user.city as string;
        break;
      case "interests":
        draft.data.interests = user.interests as string;
        break;
      case "preferredGender":
        draft.data.preferredGender = user.preferredGender as string;
        break;
      case "ageMin":
        draft.data.ageMin = user.ageMin as number;
        break;
      case "ageMax":
        draft.data.ageMax = user.ageMax as number;
        break;
      default:
        await ctx.answerCallbackQuery({ text: "Неизвестный шаг." });
        return;
    }

    const next = nextStepAfter(step);
    if (!next) {
      await ctx.answerCallbackQuery({ text: "Ошибка сценария." });
      return;
    }

    draft.step = next;
    await ctx.answerCallbackQuery({ text: "Оставляем как есть, дальше." });

    if (draft.step === "photo" && !photoStorage) {
      await finalizeProfileDraft(ctx, user, draft);
      return;
    }
    await sendPromptForStep(ctx, draft, user);
  });

  bot.callbackQuery("profile_photo:skip", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const draft = profileDrafts.get(from.id);
    if (!draft || draft.step !== "photo") {
      await ctx.answerCallbackQuery({ text: "Сейчас не шаг загрузки фото." });
      return;
    }
    const user = await loadUserWithPhotos(from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Профиль не найден." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Сохраняем анкету…" });
    await finalizeProfileDraft(ctx, user, draft);
  });

  bot.callbackQuery("profile_photo:keep", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const draft = profileDrafts.get(from.id);
    if (!draft || draft.step !== "photo") {
      await ctx.answerCallbackQuery({ text: "Сейчас не шаг загрузки фото." });
      return;
    }
    const user = await loadUserWithPhotos(from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Профиль не найден." });
      return;
    }
    if (!hasSavedValueForStep(user, "photo")) {
      await ctx.answerCallbackQuery({ text: "Нет сохранённых фото." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Оставляем текущие фото…" });
    await finalizeProfileDraft(ctx, user, draft);
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

  bot.hears("Мэтчи", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
      return;
    }

    await showMatches(ctx, user.id);
  });

  bot.hears("Пригласить", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    await ctx.reply(`${referrals.inviteHint(user) ?? "Не удалось сформировать код приглашения."}`, {
      reply_markup: mainMenuKeyboard(),
    });
  });

  bot.hears("Фото профиля", async (ctx) => {
    await ctx.reply("Используйте /upload_photo и отправьте фото одним сообщением.");
  });

  bot.on("message:photo", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const draftForPhoto = profileDrafts.get(from.id);
    if (draftForPhoto?.step === "photo" && photoStorage) {
      const user = await users.findByTelegramId(from.id);
      if (!user) {
        profileDrafts.delete(from.id);
        await ctx.reply("Профиль не найден. Нажмите /start для регистрации.");
        return;
      }

      if (!ctx.message.photo?.length) {
        await ctx.reply("Не удалось прочитать файл фото из Telegram.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      try {
        const existingCount = await photoRepo.count({ where: { userId: user.id } });
        if (existingCount >= 5) {
          await ctx.reply("Достигнут лимит 5 фотографий на профиль.", {
            reply_markup: mainMenuKeyboard(),
          });
          return;
        }

        const file = await ctx.getFile();
        if (!file.file_path) {
          throw new Error("Telegram не вернул путь файла после getFile()");
        }

        const sourceUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const remote = await fetch(sourceUrl);
        if (!remote.ok) {
          throw new Error(`Не удалось скачать фото Telegram (HTTP ${remote.status}).`);
        }

        const buffer = Buffer.from(await remote.arrayBuffer());
        const objectKey = photoStorage.buildObjectKey(user.id);
        await photoStorage.uploadJpeg(objectKey, buffer);

        const savedPhoto = photoRepo.create({
          userId: user.id,
          s3Key: objectKey,
          order: existingCount,
          isPrimary: existingCount === 0,
        });
        await photoRepo.save(savedPhoto);

        await finalizeProfileDraft(ctx, user, draftForPhoto);
      } catch (error) {
        profileFlowErrorsTotal.inc();
        console.error("[photo-upload] Ошибка при сохранении фото в сценарии анкеты:", error);
        const messageText = error instanceof Error ? error.message : String(error);
        await ctx.reply(
          `Не удалось сохранить фото и анкету. Проверьте журнал: «${messageText}».`,
        );
      }
      return;
    }

    if (!awaitingPhotoUploads.has(from.id)) {
      return;
    }

    if (!photoStorage) {
      awaitingPhotoUploads.delete(from.id);
      await ctx.reply("MinIO/S3 временно недоступен для загрузки фото.", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const user = await users.findByTelegramId(from.id);
    if (!user) {
      awaitingPhotoUploads.delete(from.id);
      await ctx.reply("Сначала выполните /start.");
      return;
    }

    if (!ctx.message.photo?.length) {
      awaitingPhotoUploads.delete(from.id);
      await ctx.reply("Не удалось прочитать файл фото из Telegram.", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    try {
      const existingCount = await photoRepo.count({ where: { userId: user.id } });
      if (existingCount >= 5) {
        awaitingPhotoUploads.delete(from.id);
        await ctx.reply("Достигнут лимит 5 фотографий на профиль.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      const file = await ctx.getFile();
      if (!file.file_path) {
        throw new Error("Telegram не вернул путь файла после getFile()");
      }

      const sourceUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const remote = await fetch(sourceUrl);
      if (!remote.ok) {
        throw new Error(`Не удалось скачать фото Telegram (HTTP ${remote.status}).`);
      }

      const buffer = Buffer.from(await remote.arrayBuffer());
      const objectKey = photoStorage.buildObjectKey(user.id);
      await photoStorage.uploadJpeg(objectKey, buffer);

      const savedPhoto = photoRepo.create({
        userId: user.id,
        s3Key: objectKey,
        order: existingCount,
        isPrimary: existingCount === 0,
      });

      await photoRepo.save(savedPhoto);

      awaitingPhotoUploads.delete(from.id);
      await ranking.recalculateAndPersistForUser(user.id).catch((error: unknown) => {
        profileLog("rating recalculation after photo upload failed", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      await ctx.reply("Фото сохранено в MinIO/S3 и отображается как часть вашей анкеты.", {
        reply_markup: mainMenuKeyboard(),
      });
    } catch (error) {
      awaitingPhotoUploads.delete(from.id);
      profileFlowErrorsTotal.inc();
      console.error("[photo-upload] Ошибка при сохранении фото профиля:", error);
      const messageText = error instanceof Error ? error.message : String(error);
      await ctx.reply(
        `Не удалось сохранить фото профиля. Проверьте журнал событий: «${messageText}».`,
      );
    }
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

    await processProfileStep(ctx, user, draft, text);
  });



  async function showMyProfile(ctx: any, telegramId: number): Promise<void> {
    const user = await userRepo.findOne({
      where: { telegramId: String(telegramId) },
      relations: { photos: true },
    });

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

    const extras = [
      `Код для друзей: ${user.referralCode ?? "—"}`,
      `Фотографии в профиле: ${user.photos?.length ?? 0}`,
      `Заработанные приглашения: ${user.referralCount}`,
    ];

    const caption = formatProfile(user, extras);
    const avatar =
      user.photos?.find((photo) => photo.isPrimary) ?? user.photos?.[0] ?? undefined;

    if (photoStorage && avatar) {
      try {
        const bytes = await photoStorage.getObjectBytes(avatar.s3Key);
        await ctx.replyWithPhoto(new InputFile(Buffer.from(bytes), "profile.jpg"), {
          caption,
          reply_markup: mainMenuKeyboard(),
        });
        return;
      } catch (error) {
        console.error("[profile] Ошибка MinIO при отдаче фото профиля:", error);
        await ctx.reply(
          `${caption}\n\n(Не удалось загрузить фото из хранилища, показывается только текст.)`,
          { reply_markup: mainMenuKeyboard() },
        );
        return;
      }
    }

    await ctx.reply(caption, {
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

    const candidate = await userRepo.findOne({
      where: { id: candidateId },
      relations: { photos: true },
    });
    if (!candidate) {
      await ctx.reply("Не удалось загрузить анкету, попробуйте снова.");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("❤️ Лайк", `like:${candidate.id}`)
      .text("⏭️ Пропуск", `skip:${candidate.id}`);

    const caption = [
      "Кандидат:",
      `${candidate.firstName ?? "Без имени"}, ${candidate.age ?? "?"}`,
      `Город: ${candidate.city ?? "не указан"}`,
      `Интересы: ${candidate.interests ?? "не указаны"}`,
      `Фото в анкете: ${candidate.photos?.length ?? 0}`,
      `Рейтинг: ${(candidate.combinedRating ?? 0).toFixed(2)}`,
    ].join("\n");

    const photoList = [...(candidate.photos ?? [])].sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) {
        return a.isPrimary ? -1 : 1;
      }
      return (a.order ?? 0) - (b.order ?? 0);
    });

    const files: InputFile[] = [];
    if (photoStorage && photoList.length > 0) {
      for (let i = 0; i < photoList.length; i += 1) {
        const photo = photoList[i]!;
        try {
          const bytes = await photoStorage.getObjectBytes(photo.s3Key);
          files.push(new InputFile(Buffer.from(bytes), `profile_${candidate.id}_${i}.jpg`));
        } catch (error) {
          console.error("[browse] Ошибка MinIO при чтении фото кандидата:", photo.s3Key, error);
        }
      }
    }

    if (files.length === 1) {
      try {
        await ctx.replyWithPhoto(files[0]!, {
          caption,
          reply_markup: keyboard,
        });
        return;
      } catch (error) {
        console.error("[browse] Ошибка отправки фото кандидата в Telegram:", error);
        await ctx.reply(
          `${caption}\n\n(Не удалось отправить фото в Telegram.)`,
          { reply_markup: keyboard },
        );
        return;
      }
    }

    if (files.length > 1) {
      try {
        await ctx.replyWithPhoto(files[0]!, {
          caption,
          reply_markup: keyboard,
        });
        for (let i = 1; i < files.length; i += 1) {
          await ctx.replyWithPhoto(files[i]!);
        }
        return;
      } catch (error) {
        console.error("[browse] Ошибка отправки нескольких фото кандидата:", error);
        await ctx.reply(
          `${caption}\n\n(Не удалось отправить все фото.)`,
          { reply_markup: keyboard },
        );
        return;
      }
    }

    await ctx.reply(caption, { reply_markup: keyboard });
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

  async function showMatches(ctx: any, userId: string): Promise<void> {
    const interactions = await interactionRepo.find({
      where: { fromUserId: userId, type: "match" },
      relations: { toUser: true },
      order: { createdAt: "DESC" },
      take: 50,
    });

    if (!interactions.length) {
      await ctx.reply("Пока нет совпадений типа мэтч.", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const deduped = new Map<string, Interaction>();
    for (const item of interactions) {
      if (!deduped.has(item.toUserId)) {
        deduped.set(item.toUserId, item);
      }
    }

    const lines = Array.from(deduped.values())
      .slice(0, 15)
      .map((item, index) => {
        const opponent = item.toUser;
        const name = opponent?.firstName ?? "Без имени";
        const age = opponent?.age ?? "?";
        const city = opponent?.city ?? "не указан";
        const date = item.createdAt.toLocaleString("ru-RU");
        return `${index + 1}. ${name}, ${age} (${city}) — мэтч: ${date}`;
      });

    await ctx.reply(`Последние мэтчи:\n\n${lines.join("\n")}`, {
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

  async function loadUserWithPhotos(telegramId: number): Promise<User | null> {
    return userRepo.findOne({
      where: { telegramId: String(telegramId) },
      relations: { photos: true },
    });
  }

  function keepOnlyKeyboard(user: User, step: ProfileStep): InlineKeyboard | undefined {
    if (!hasSavedValueForStep(user, step)) return undefined;
    return new InlineKeyboard().text("⏭ Оставить как есть", `profile_keep:${step}`);
  }

  function genderKeyboardWithKeep(user: User): InlineKeyboard {
    const kb = genderKeyboard();
    if (hasSavedValueForStep(user, "gender")) {
      kb.row().text("⏭ Оставить как есть", "profile_keep:gender");
    }
    return kb;
  }

  function preferredGenderKeyboardWithKeep(user: User): InlineKeyboard {
    const kb = preferredGenderKeyboard();
    if (hasSavedValueForStep(user, "preferredGender")) {
      kb.row().text("⏭ Оставить как есть", "profile_keep:preferredGender");
    }
    return kb;
  }

  type StepPromptOptions = { ageIntro?: string };

  async function finalizeProfileDraft(ctx: any, user: User, draft: ProfileDraft): Promise<void> {
    const telegramId = Number(user.telegramId);
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
      awaitingPhotoUploads.delete(telegramId);
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

      void recordDailyActiveSessionPing(redis).catch((error: unknown) => {
        console.error("[redis-stats] Не удалось записать счётчик активности:", error);
      });
    } catch (error) {
      profileFlowErrorsTotal.inc();
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
  }

  async function promptPhotoStep(ctx: any, user: User, draft: ProfileDraft): Promise<void> {
    if (!photoStorage) {
      await finalizeProfileDraft(ctx, user, draft);
      return;
    }
    const kb = new InlineKeyboard().text("Пропустить без фото", "profile_photo:skip");
    if (hasSavedValueForStep(user, "photo")) {
      kb.text("Оставить текущие фото", "profile_photo:keep");
    }
    await ctx.reply(
      "Шаг 8/8: Пришлите одно фото для анкеты (одним сообщением) или выберите действие ниже.\n" +
        "Подсказка: фото сохраняется в хранилище и отображается в ленте и в «Мой профиль».",
      { reply_markup: kb },
    );
  }

  async function sendPromptForStep(
    ctx: any,
    draft: ProfileDraft,
    user: User,
    options?: StepPromptOptions,
  ): Promise<void> {
    const telegramId = Number(user.telegramId);
    const u = (await loadUserWithPhotos(telegramId)) ?? user;
    switch (draft.step) {
      case "age": {
        const kb = keepOnlyKeyboard(u, "age");
        await ctx.reply(
          (options?.ageIntro ?? "") +
            "Шаг 1/8: Сколько вам лет?\nПодсказка: отправьте число от 18 до 99.\n\n" +
            "Для отмены в любой момент: /cancel_profile",
          kb ? { reply_markup: kb } : undefined,
        );
        return;
      }
      case "gender":
        await ctx.reply("Шаг 2/8: Укажите ваш пол.\nПодсказка: нажмите кнопку ниже.", {
          reply_markup: genderKeyboardWithKeep(u),
        });
        return;
      case "city": {
        const kb = keepOnlyKeyboard(u, "city");
        await ctx.reply(
          "Шаг 3/8: Из какого вы города?\nПодсказка: например, Москва, Казань, Минск.",
          kb ? { reply_markup: kb } : undefined,
        );
        return;
      }
      case "interests": {
        const kb = keepOnlyKeyboard(u, "interests");
        await ctx.reply(
          "Шаг 4/8: Напишите ваши интересы.\nПодсказка: перечислите через запятую, например: кино, спорт, путешествия.",
          kb ? { reply_markup: kb } : undefined,
        );
        return;
      }
      case "preferredGender":
        await ctx.reply("Шаг 5/8: Кого вы ищете?\nПодсказка: нажмите кнопку ниже.", {
          reply_markup: preferredGenderKeyboardWithKeep(u),
        });
        return;
      case "ageMin": {
        const kb = keepOnlyKeyboard(u, "ageMin");
        await ctx.reply(
          "Шаг 6/8: Минимальный возраст партнера?\nПодсказка: число от 18 до 99.",
          kb ? { reply_markup: kb } : undefined,
        );
        return;
      }
      case "ageMax": {
        const min = draft.data.ageMin ?? u.ageMin ?? 18;
        const kb = keepOnlyKeyboard(u, "ageMax");
        await ctx.reply(
          `Шаг 7/8: Максимальный возраст партнера?\nПодсказка: число от ${min} до 99.`,
          kb ? { reply_markup: kb } : undefined,
        );
        return;
      }
      case "photo":
        await promptPhotoStep(ctx, u, draft);
        return;
    }
  }

  async function startProfileFlow(ctx: any, user: User): Promise<void> {
    const telegramId = Number(user.telegramId);
    const draftRef: ProfileDraft = { step: "age", data: {} };
    profileDrafts.set(telegramId, draftRef);
    profileLog("flow started", { telegramId, userId: user.id });

    const u = (await loadUserWithPhotos(telegramId)) ?? user;
    await sendPromptForStep(ctx, draftRef, u, { ageIntro: "Начинаем заполнение анкеты.\n\n" });
  }

  async function processProfileStep(ctx: any, user: User, draft: ProfileDraft, text: string): Promise<void> {
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        await sendPromptForStep(ctx, draft, u);
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
        draft.step = "photo";
        profileLog("step completed", { telegramId, nextStep: draft.step, ageMax });
        const u = (await loadUserWithPhotos(telegramId)) ?? user;
        if (!photoStorage) {
          await finalizeProfileDraft(ctx, user, draft);
          return;
        }
        await sendPromptForStep(ctx, draft, u);
        return;
      }
      case "photo": {
        await ctx.reply(
          "На этом шаге отправьте фото одним сообщением или нажмите кнопку под предыдущим вопросом.",
        );
        return;
      }
    }
  }

  return bot;
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

function formatProfile(user: User, extras: string[] = []): string {
  const base = [
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
  ];

  if (!extras.length) {
    return base.join("\n");
  }

  return [...base, ...extras].join("\n");
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

function extractStartPayload(text?: string | null): string | null {
  if (!text) {
    return null;
  }

  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  if (!parts.length || !parts[0].startsWith("/start")) {
    return null;
  }

  const payload = parts.slice(1).join(" ").trim();
  return payload.length ? payload : null;
}
