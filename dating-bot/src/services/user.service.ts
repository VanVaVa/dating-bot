import { QueryFailedError, Repository } from "typeorm";
import type { User as TgUser } from "grammy/types";
import { User } from "../entities/User.js";

export class UserService {
  constructor(private readonly repo: Repository<User>) {}

  async registerFromTelegram(tg: TgUser): Promise<{ user: User; isNew: boolean }> {
    const telegramId = String(tg.id);
    let user = await this.repo.findOne({ where: { telegramId } });

    if (user) {
      user.username = tg.username ?? null;
      user.firstName = tg.first_name ?? null;
      user.lastName = tg.last_name ?? null;
      await this.repo.save(user);
      return { user, isNew: false };
    }

    user = this.repo.create({
      telegramId,
      username: tg.username ?? null,
      firstName: tg.first_name ?? null,
      lastName: tg.last_name ?? null,
    });

    await this.persistWithReferralRetries(user);
    return { user, isNew: true };
  }

  async findByTelegramId(telegramId: number): Promise<User | null> {
    return this.repo.findOne({ where: { telegramId: String(telegramId) } });
  }

  private async persistWithReferralRetries(user: User): Promise<void> {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        await this.repo.save(user);
        return;
      } catch (error) {
        if (!(error instanceof QueryFailedError)) {
          throw error;
        }

        const driverCode =
          typeof error.driverError === "object" ? (error.driverError as { code?: string })?.code : undefined;
        if (driverCode === "23505" && `${error.message}`.includes("referral_code")) {
          console.warn("[user-service] Совпадение referral_code при регистрации, генерируем новое значение.");
          user.referralCode = User.generateReferralCode();
          continue;
        }

        throw error;
      }
    }

    throw new Error("Не удалось создать пользователя из-за повторных коллизий referral_code.");
  }
}
