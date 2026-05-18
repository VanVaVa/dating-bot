import "reflect-metadata";
import "../env.js";
import { Repository } from "typeorm";
import { AppDataSource } from "../data-source.js";
import { Interaction } from "../entities/Interaction.js";
import { Rating } from "../entities/Rating.js";
import { User } from "../entities/User.js";
import { UserMetric } from "../entities/UserMetric.js";
import { NoopEventPublisher } from "../messaging/noop-publisher.js";
import { RankingService } from "../services/ranking.service.js";

type MockUser = {
  telegramId: string;
  firstName: string;
  age: number;
  gender: string;
  city: string;
  interests: string;
  preferredGender: string;
  ageMin: number;
  ageMax: number;
  referralCount: number;
};

const MOCK_USERS: MockUser[] = [
  {
    telegramId: "8000000001",
    firstName: "Алексей",
    age: 28,
    gender: "мужской",
    city: "Москва",
    interests: "спорт, кино, путешествия",
    preferredGender: "женский",
    ageMin: 22,
    ageMax: 32,
    referralCount: 2,
  },
  {
    telegramId: "8000000002",
    firstName: "Мария",
    age: 25,
    gender: "женский",
    city: "Москва",
    interests: "йога, книги, музыка",
    preferredGender: "мужской",
    ageMin: 24,
    ageMax: 34,
    referralCount: 4,
  },
  {
    telegramId: "8000000003",
    firstName: "Игорь",
    age: 31,
    gender: "мужской",
    city: "Сочи",
    interests: "теннис, бег, горы",
    preferredGender: "женский",
    ageMin: 23,
    ageMax: 30,
    referralCount: 1,
  },
  {
    telegramId: "8000000004",
    firstName: "Екатерина",
    age: 27,
    gender: "женский",
    city: "Сочи",
    interests: "танцы, чтение, искусство",
    preferredGender: "любой",
    ageMin: 24,
    ageMax: 36,
    referralCount: 0,
  },
  {
    telegramId: "8000000005",
    firstName: "Денис",
    age: 29,
    gender: "мужской",
    city: "Казань",
    interests: "разработка, настолки, баскетбол",
    preferredGender: "женский",
    ageMin: 21,
    ageMax: 33,
    referralCount: 3,
  },
  {
    telegramId: "8000000006",
    firstName: "Анна",
    age: 24,
    gender: "женский",
    city: "Казань",
    interests: "фотография, кино, путешествия",
    preferredGender: "мужской",
    ageMin: 24,
    ageMax: 35,
    referralCount: 1,
  },
];

async function upsertMockUsers(userRepo: Repository<User>) {
  const result: User[] = [];

  for (const mock of MOCK_USERS) {
    let user = await userRepo.findOne({
      where: { telegramId: mock.telegramId },
    });

    if (!user) {
      user = userRepo.create({
        telegramId: mock.telegramId,
      });
    }

    user.firstName = mock.firstName;
    user.lastName = null;
    user.username = null;
    user.age = mock.age;
    user.gender = mock.gender;
    user.city = mock.city;
    user.interests = mock.interests;
    user.preferredGender = mock.preferredGender;
    user.ageMin = mock.ageMin;
    user.ageMax = mock.ageMax;
    user.referralCount = mock.referralCount;
    user.completenessScore = 100;

    result.push(await userRepo.save(user));
  }

  return result;
}

async function seedInteractions(
  interactionRepo: Repository<Interaction>,
  users: User[],
) {
  const byTelegramId = new Map(users.map((user) => [user.telegramId, user]));

  const likePairs: Array<[string, string]> = [
    ["8000000001", "8000000002"],
    ["8000000002", "8000000001"],
    ["8000000003", "8000000004"],
    ["8000000005", "8000000006"],
    ["8000000006", "8000000005"],
    ["8000000002", "8000000003"],
  ];

  const skipPairs: Array<[string, string]> = [
    ["8000000004", "8000000001"],
    ["8000000001", "8000000006"],
    ["8000000003", "8000000002"],
  ];

  const allPairs = [
    ...likePairs.map((pair) => ({ pair, type: "like" as const })),
    ...skipPairs.map((pair) => ({ pair, type: "skip" as const })),
  ];

  for (const entry of allPairs) {
    const from = byTelegramId.get(entry.pair[0]);
    const to = byTelegramId.get(entry.pair[1]);
    if (!from || !to) continue;

    const exists = await interactionRepo.exists({
      where: {
        fromUserId: from.id,
        toUserId: to.id,
        type: entry.type,
      },
    });
    if (!exists) {
      await interactionRepo.save(
        interactionRepo.create({
          fromUserId: from.id,
          toUserId: to.id,
          type: entry.type,
        }),
      );
    }

    if (entry.type === "like") {
      const hasBackLike = likePairs.some(([a, b]) => a === entry.pair[1] && b === entry.pair[0]);
      if (hasBackLike) {
        const matchExists = await interactionRepo.exists({
          where: {
            fromUserId: from.id,
            toUserId: to.id,
            type: "match",
          },
        });
        if (!matchExists) {
          await interactionRepo.save(
            interactionRepo.create({
              fromUserId: from.id,
              toUserId: to.id,
              type: "match",
            }),
          );
        }
      }
    }
  }
}

async function main() {
  await AppDataSource.initialize();

  const userRepo = AppDataSource.getRepository(User);
  const interactionRepo = AppDataSource.getRepository(Interaction);
  const ratingRepo = AppDataSource.getRepository(Rating);
  const metricsRepo = AppDataSource.getRepository(UserMetric);
  const noopPublisher = new NoopEventPublisher();
  const ranking = new RankingService(
    userRepo,
    interactionRepo,
    ratingRepo,
    metricsRepo,
    noopPublisher,
  );

  const users = await upsertMockUsers(userRepo);
  await seedInteractions(interactionRepo, users);

  for (const user of users) {
    await ranking.recalculateAndPersistForUser(user.id);
  }

  console.log(`[seed-mocks] created or updated ${users.length} mock users`);
  await AppDataSource.destroy();
}

main().catch(async (error) => {
  console.error("[seed-mocks] failed", error);
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(1);
});
