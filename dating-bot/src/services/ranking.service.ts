import { In, Repository } from "typeorm";
import { Interaction } from "../entities/Interaction.js";
import { Rating, RatingType } from "../entities/Rating.js";
import { User } from "../entities/User.js";

type ScoreBundle = {
  primary: number;
  behavioral: number;
  combined: number;
};

const PRIMARY_WEIGHT = 0.55;
const BEHAVIORAL_WEIGHT = 0.45;
const REFERRAL_BONUS = 2;

export class RankingService {
  constructor(
    private readonly userRepo: Repository<User>,
    private readonly interactionRepo: Repository<Interaction>,
    private readonly ratingRepo: Repository<Rating>,
  ) {}

  async getRankedCandidatesFor(user: User, limit: number): Promise<User[]> {
    const candidates = await this.userRepo.find({
      where: { id: In(await this.getCandidateIds(user.id)) },
    });

    const scored = await Promise.all(
      candidates.map(async (candidate) => {
        const scores = await this.calculateScores(user, candidate);
        await this.persistScores(candidate, scores);
        return { candidate, score: scores.combined };
      }),
    );

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((item) => item.candidate);
  }

  async saveInteraction(fromUserId: string, toUserId: string, type: "like" | "skip"): Promise<void> {
    const interaction = this.interactionRepo.create({ fromUserId, toUserId, type });
    await this.interactionRepo.save(interaction);

    if (type === "like") {
      const hasBackLike = await this.interactionRepo.exists({
        where: { fromUserId: toUserId, toUserId: fromUserId, type: "like" },
      });
      if (hasBackLike) {
        await this.interactionRepo.save(
          this.interactionRepo.create({
            fromUserId,
            toUserId,
            type: "match",
          }),
        );
      }
    }
  }

  async recalculateAndPersistForUser(userId: string): Promise<number> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new Error(`User ${userId} not found`);
    }
    const scores = await this.calculateScores(user, user);
    await this.persistScores(user, scores);
    return scores.combined;
  }

  private async getCandidateIds(userId: string): Promise<string[]> {
    const blocked = await this.interactionRepo.find({
      where: { fromUserId: userId },
      select: ["toUserId"],
    });

    const excluded = new Set(blocked.map((item) => item.toUserId));
    excluded.add(userId);

    const candidates = await this.userRepo.find({
      where: {},
      select: ["id"],
    });

    return candidates.map((item) => item.id).filter((id) => !excluded.has(id));
  }

  private async calculateScores(viewer: User, candidate: User): Promise<ScoreBundle> {
    const primary = this.calculatePrimary(viewer, candidate);
    const behavioral = await this.calculateBehavioral(candidate.id);
    const combined =
      primary * PRIMARY_WEIGHT +
      behavioral * BEHAVIORAL_WEIGHT +
      (candidate.referralCount ?? 0) * REFERRAL_BONUS;

    return {
      primary: this.round(primary),
      behavioral: this.round(behavioral),
      combined: this.round(combined),
    };
  }

  private calculatePrimary(viewer: User, candidate: User): number {
    let score = candidate.completenessScore ?? 0;

    if (
      viewer.preferredGender &&
      viewer.preferredGender !== "любой" &&
      candidate.gender === viewer.preferredGender
    ) {
      score += 15;
    }

    if (
      viewer.ageMin !== null &&
      viewer.ageMin !== undefined &&
      viewer.ageMax !== null &&
      viewer.ageMax !== undefined &&
      candidate.age !== null
    ) {
      if (candidate.age >= viewer.ageMin && candidate.age <= viewer.ageMax) {
        score += 15;
      }
    }

    if (viewer.city && candidate.city && viewer.city.toLowerCase() === candidate.city.toLowerCase()) {
      score += 10;
    }

    return Math.min(score, 100);
  }

  private async calculateBehavioral(candidateId: string): Promise<number> {
    const likesReceived = await this.interactionRepo.count({
      where: { toUserId: candidateId, type: "like" },
    });
    const skipsReceived = await this.interactionRepo.count({
      where: { toUserId: candidateId, type: "skip" },
    });
    const matches = await this.interactionRepo.count({
      where: { toUserId: candidateId, type: "match" },
    });

    const total = likesReceived + skipsReceived;
    const likeRate = total > 0 ? likesReceived / total : 0.5;
    return Math.min(100, likeRate * 70 + matches * 10);
  }

  private async persistScores(user: User, scores: ScoreBundle): Promise<void> {
    user.combinedRating = scores.combined;
    await this.userRepo.save(user);

    const records: Array<{ type: RatingType; value: number }> = [
      { type: "primary", value: scores.primary },
      { type: "behavioral", value: scores.behavioral },
      { type: "combined", value: scores.combined },
    ];

    await this.ratingRepo.save(
      records.map((record) =>
        this.ratingRepo.create({
          userId: user.id,
          ratingType: record.type,
          value: record.value,
        }),
      ),
    );
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
