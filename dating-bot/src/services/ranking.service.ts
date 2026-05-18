import { Brackets, In, Repository } from "typeorm";
import type { Interaction, InteractionType } from "../entities/Interaction.js";
import { Rating, RatingType } from "../entities/Rating.js";
import { UserMetric } from "../entities/UserMetric.js";
import { User } from "../entities/User.js";
import { rankingRecalculateDurationSeconds } from "../monitoring/metrics-http.js";
import type { EventPublisher } from "../messaging/domain-events.js";

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
    private readonly metricsRepo: Repository<UserMetric>,
    private readonly publisher: EventPublisher,
  ) {}

  async getRankedCandidatesFor(user: User, limit: number): Promise<User[]> {
    const candidateIds = await this.getCandidateIds(user);
    const candidates =
      candidateIds.length === 0
        ? []
        : await this.userRepo.find({
            where: { id: In(candidateIds) },
            relations: { metrics: true, photos: true },
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

  async saveInteraction(fromUserId: string, toUserId: string, type: InteractionType): Promise<void> {
    const created = this.interactionRepo.create({ fromUserId, toUserId, type });
    const savedLikeOrSkipOrMatchHint = await this.interactionRepo.save(created);
    await this.emitInteraction(savedLikeOrSkipOrMatchHint);

    if (type === "like") {
      const hasBackLike = await this.interactionRepo.exists({
        where: { fromUserId: toUserId, toUserId: fromUserId, type: "like" },
      });
      if (hasBackLike) {
        const matchRecord = this.interactionRepo.create({
          fromUserId,
          toUserId,
          type: "match",
        });
        const savedMatch = await this.interactionRepo.save(matchRecord);
        await this.emitInteraction(savedMatch);
      }
    }
  }

  async recalculateAndPersistForUser(userId: string): Promise<number> {
    const timer = rankingRecalculateDurationSeconds.startTimer();
    try {
      const user = await this.userRepo.findOne({ where: { id: userId }, relations: { metrics: true } });
      if (!user) {
        throw new Error(`User ${userId} не найден в ranking.service`);
      }
      const scores = await this.calculateScores(user, user);
      await this.persistScores(user, scores);
      return scores.combined;
    } finally {
      timer();
    }
  }

  private async emitInteraction(record: Interaction): Promise<void> {
    await this.publisher.publish({
      type: "interaction.created",
      payload: {
        interactionId: record.id,
        fromUserId: record.fromUserId,
        toUserId: record.toUserId,
        interactionType: record.type,
        createdAt: record.createdAt.toISOString(),
      },
    });
  }

  private async getCandidateIds(viewer: User): Promise<string[]> {
    const excluded = await this.buildExcludedIds(viewer.id);

    const strict = await this.queryCandidateIdsForViewer(viewer, excluded, "strict");
    if (strict.length > 0) {
      return strict;
    }

    const viewerOnly = await this.queryCandidateIdsForViewer(viewer, excluded, "viewer_only");
    if (viewerOnly.length > 0) {
      return viewerOnly;
    }

    return this.queryCandidateIdsForViewer(viewer, excluded, "broad");
  }

  private async buildExcludedIds(viewerId: string): Promise<Set<string>> {
    const blocked = await this.interactionRepo.find({
      where: { fromUserId: viewerId },
      select: ["toUserId"],
    });

    const excluded = new Set(blocked.map((item) => item.toUserId));
    excluded.add(viewerId);
    return excluded;
  }

  /**
   * strict — взаимные фильтры по возрасту/полу (кандидат «ищет» кого-то в рамках нашего профиля).
   * viewer_only — только фильтры самого просматривающего (если в малой БД никто не проходит взаимность).
   * broad — все профили, с кем не было взаимодействий (кроме себя).
   */
  private async queryCandidateIdsForViewer(
    viewer: User,
    excluded: Set<string>,
    mode: "strict" | "viewer_only" | "broad",
  ): Promise<string[]> {
    const qb = this.userRepo.createQueryBuilder("u");

    qb.where("u.id != :viewerId", { viewerId: viewer.id });

    if (mode !== "broad") {
      if (viewer.ageMin !== null && viewer.ageMax !== null) {
        qb.andWhere("(u.age IS NULL OR u.age BETWEEN :vmin AND :vmax)", {
          vmin: viewer.ageMin,
          vmax: viewer.ageMax,
        });
      }

      if (viewer.preferredGender && viewer.preferredGender !== "любой") {
        qb.andWhere("(u.gender IS NULL OR u.gender = :wantedGender)", {
          wantedGender: viewer.preferredGender,
        });
      }
    }

    if (mode === "strict" && viewer.age !== null && viewer.gender) {
      qb.andWhere(
        "(u.age_min IS NULL OR u.age_min <= :mirrorAge) AND (u.age_max IS NULL OR u.age_max >= :mirrorAge)",
        { mirrorAge: viewer.age },
      );
      qb.andWhere(
        new Brackets((inner) =>
          inner
            .where("u.preferred_gender IS NULL")
            .orWhere("u.preferred_gender = :neutralGender")
            .orWhere("u.preferred_gender = :mirrorGender"),
        ),
        { neutralGender: "любой", mirrorGender: viewer.gender },
      );
    }

    const rows = await qb.getMany();
    return rows.map((row) => row.id).filter((id) => !excluded.has(id));
  }

  private async calculateScores(viewer: User, candidate: User): Promise<ScoreBundle> {
    const primary = this.calculatePrimary(viewer, candidate);
    const behavioral = await this.calculateBehavioral(candidate);
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

    const photosBoost = candidate.photos?.length ?? 0;
    if (photosBoost > 0) {
      score += Math.min(photosBoost * 4, 12);
    }

    if (
      viewer.preferredGender &&
      viewer.preferredGender !== "любой" &&
      candidate.gender === viewer.preferredGender
    ) {
      score += 15;
    }

    if (
      viewer.ageMin !== null &&
      viewer.ageMax !== null &&
      candidate.age !== null &&
      candidate.age >= viewer.ageMin &&
      candidate.age <= viewer.ageMax
    ) {
      score += 15;
    }

    if (viewer.city && candidate.city && viewer.city.toLowerCase() === candidate.city.toLowerCase()) {
      score += 10;
    }

    return Math.min(score, 100);
  }

  private async calculateBehavioral(candidate: User): Promise<number> {
    const likesReceived = await this.interactionRepo.count({
      where: { toUserId: candidate.id, type: "like" },
    });
    const skipsReceived = await this.interactionRepo.count({
      where: { toUserId: candidate.id, type: "skip" },
    });
    const matches = await this.interactionRepo.count({
      where: { toUserId: candidate.id, type: "match" },
    });

    const total = likesReceived + skipsReceived;
    const heuristic = total > 0 ? (likesReceived / total) * 70 + matches * 8 : 0.5 * 70;
    let behavioral = Math.min(100, heuristic);

    const metricsLoaded =
      candidate.metrics ??
      (await this.metricsRepo.findOne({ where: { userId: candidate.id } })) ??
      undefined;

    if (metricsLoaded) {
      behavioral = RankingService.blendScores(
        behavioral,
        RankingService.scoreFromMetrics(metricsLoaded, heuristic),
      );
    }

    return behavioral;
  }

  private static scoreFromMetrics(metric: UserMetric, fallbackHeuristic: number): number {
    const baseRate = metric.likeSkipRatio;
    const engagements = metric.likesReceived + metric.matches * 10;
    const derived =
      engagements > 0
        ? baseRate * 65 + metric.matches * 12 + metric.likesReceived * 0.5
        : fallbackHeuristic * 0.6 + metric.matches * 12;

    return Math.min(100, derived);
  }

  private static blendScores(a: number, b: number): number {
    return Math.round((Math.min(a, 100) * 0.45 + Math.min(b, 100) * 0.55 + Number.EPSILON) * 100) / 100;
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
