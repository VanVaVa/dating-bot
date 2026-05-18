import { Repository } from "typeorm";
import { User } from "../entities/User.js";
import { auditLog } from "../logging/audit-log.js";
import type { EventPublisher } from "../messaging/domain-events.js";

export interface ProfilePayload {
  age: number;
  gender: string;
  city: string;
  interests: string;
  preferredGender: string;
  ageMin: number;
  ageMax: number;
}

export class ProfileService {
  constructor(
    private readonly repo: Repository<User>,
    private readonly publisher: EventPublisher,
  ) {}

  async upsertProfile(user: User, payload: ProfilePayload): Promise<User> {
    console.log("[profile-service] upsertProfile called", {
      userId: user.id,
      telegramId: user.telegramId,
      payload,
    });
    user.age = payload.age;
    user.gender = payload.gender;
    user.city = payload.city;
    user.interests = payload.interests;
    user.preferredGender = payload.preferredGender;
    user.ageMin = payload.ageMin;
    user.ageMax = payload.ageMax;
    user.completenessScore = this.calculateCompleteness(user);
    const saved = await this.repo.save(user);
    console.log("[profile-service] upsertProfile saved", {
      userId: saved.id,
      completenessScore: saved.completenessScore,
    });
    await this.publisher.publish({
      type: "profile.updated",
      payload: {
        userId: saved.id,
        updatedAt: saved.updatedAt.toISOString(),
      },
    });
    auditLog("profile.upsert", {
      userId: saved.id,
      telegramId: saved.telegramId,
      completenessScore: saved.completenessScore,
    });
    return saved;
  }

  async getProfileByTelegramId(telegramId: number): Promise<User | null> {
    return this.repo.findOne({ where: { telegramId: String(telegramId) } });
  }

  async deleteProfileData(user: User): Promise<User> {
    user.age = null;
    user.gender = null;
    user.city = null;
    user.interests = null;
    user.preferredGender = null;
    user.ageMin = null;
    user.ageMax = null;
    user.completenessScore = 0;
    user.combinedRating = 0;
    return this.repo.save(user);
  }

  calculateCompleteness(user: User): number {
    const fields = [
      user.age,
      user.gender,
      user.city,
      user.interests,
      user.preferredGender,
      user.ageMin,
      user.ageMax,
    ];
    const filled = fields.filter((value) => value !== null && value !== "").length;
    return Math.round((filled / fields.length) * 100);
  }
}
