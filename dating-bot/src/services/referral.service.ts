import { Repository } from "typeorm";
import type { Referral } from "../entities/Referral.js";
import type { User } from "../entities/User.js";
import { auditLog } from "../logging/audit-log.js";
import type { EventPublisher } from "../messaging/domain-events.js";

export class ReferralService {
  constructor(
    private readonly users: Repository<User>,
    private readonly referrals: Repository<Referral>,
    private readonly events: EventPublisher,
  ) {}

  async tryAttachReferral(referredUser: User, rawCode?: string | null): Promise<boolean> {
    const code = ReferralService.normalize(rawCode);
    if (!code) {
      return false;
    }

    if (referralApplied(referredUser)) {
      return false;
    }

    if (code === referredUser.referralCode) {
      return false;
    }

    const referrer = await this.users.findOne({ where: { referralCode: code } });
    if (!referrer || referrer.id === referredUser.id) {
      return false;
    }

    const existing = await this.referrals.exist({ where: { referredId: referredUser.id } });
    if (existing) {
      return false;
    }

    const referral = this.referrals.create({
      referrerId: referrer.id,
      referredId: referredUser.id,
      bonusAwarded: true,
    });

    referrer.referralCount = (referrer.referralCount ?? 0) + 1;
    referredUser.referredById = referrer.id;

    const savedReferral = await this.referrals.save(referral);
    await this.users.save([referrer, referredUser]);

    await this.events.publish({
      type: "referral.created",
      payload: {
        referralId: savedReferral.id,
        referrerId: referrer.id,
        referredId: referredUser.id,
        createdAt: savedReferral.createdAt.toISOString(),
      },
    });

    auditLog("referral.attached", {
      referralId: savedReferral.id,
      referrerId: referrer.id,
      referredId: referredUser.id,
    });

    return true;
  }

  private static normalize(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const upper = value.trim().toUpperCase();
    const withoutPrefix = upper.startsWith("REF") ? upper.replace(/^REF[_-]?/i, "") : upper;
    const cleaned = withoutPrefix.replace(/[^A-Z0-9]/g, "");
    return cleaned.length >= 6 ? cleaned.slice(0, 32) : null;
  }

  inviteHint(user: User): string | null {
    if (!user.referralCode) {
      return null;
    }

    const code = user.referralCode;
    return [
      `Ваш код приглашения: ${code}`,
      "Передайте его другу. Друг добавляет параметр после /start, например:",
      `/start REF_${code}`,
    ].join("\n");
  }
}

function referralApplied(user: User): boolean {
  return Boolean(user.referredById);
}
