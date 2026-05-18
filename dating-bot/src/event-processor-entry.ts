import "reflect-metadata";
import "./env.js";

import type { ConsumeMessage } from "amqplib";
import { connect } from "amqplib";
import type { DomainEvent } from "./messaging/domain-events.js";
import { DOMAIN_EVENTS_QUEUE } from "./messaging/rabbit-publisher.js";
import { AppDataSource } from "./data-source.js";
import { InteractionType } from "./entities/Interaction.js";
import type { Repository } from "typeorm";
import { UserMetric } from "./entities/UserMetric.js";
import { auditLog } from "./logging/audit-log.js";
import { domainEventsConsumeTotal } from "./monitoring/metrics-http.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const rabbitUrl = process.env.RABBITMQ_URL?.trim();
if (!rabbitUrl) {
  console.error("Задайте RABBITMQ_URL для event-processor");
  process.exit(1);
}

await AppDataSource.initialize();
console.log("[event-processor] Подключение к Postgres установлено");

const metricsRepo: Repository<UserMetric> = AppDataSource.getRepository(UserMetric);

async function bootstrap(url: string): Promise<void> {
  let connection: Awaited<ReturnType<typeof connect>>;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      connection = await connect(url);
      break;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(
        `[event-processor] Не удалось подключиться к RabbitMQ (${messageText}), повтор ${attempts}...`,
      );
      await sleep(Math.min(2_500 * Math.min(attempts, 30), 30_000));
    }
  }

  const channel = await connection.createChannel();
  await channel.prefetch(20);
  await channel.assertQueue(DOMAIN_EVENTS_QUEUE, { durable: true });

  channel.consume(DOMAIN_EVENTS_QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) {
      return;
    }

    try {
      const raw = JSON.parse(msg.content.toString("utf8")) as DomainEvent;
      await dispatch(raw);
      channel.ack(msg);
      domainEventsConsumeTotal.labels(raw.type).inc();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(
        "[event-processor] Ошибка обработки сообщения:",
        msg.content.toString("utf8").slice(0, 320),
        messageText,
      );
      domainEventsConsumeTotal.labels("delivery_error").inc();
      channel.nack(msg, false, false);
    }
  });

  console.log("[event-processor] Слушаем очередь", DOMAIN_EVENTS_QUEUE);
}

await bootstrap(rabbitUrl);

async function dispatch(event: DomainEvent): Promise<void> {
  switch (event.type) {
    case "interaction.created":
      await handleInteractionEvent(event.payload.interactionType, event.payload);
      auditLog("processor.interaction_handled", {
        interactionType: event.payload.interactionType,
        fromUserId: event.payload.fromUserId,
        toUserId: event.payload.toUserId,
      });
      return;
    case "profile.updated":
      console.log(`[event-processor] Анкета обновлена: user=${event.payload.userId}`);
      return;
    case "referral.created":
      console.log(
        `[event-processor] Реферал: referrer=${event.payload.referrerId} ← referred=${event.payload.referredId}`,
      );
      return;
    default: {
      const exhaustiveCheck: never = event;
      return exhaustiveCheck;
    }
  }
}

async function handleInteractionEvent(
  type: InteractionType,
  payload: {
    fromUserId: string;
    toUserId: string;
    createdAt: string;
  },
): Promise<void> {
  const bucketHour = deriveHourBucket(payload.createdAt);

  switch (type) {
    case "like": {
      const fromMetric = await ensureMetric(payload.fromUserId);
      const toMetric = await ensureMetric(payload.toUserId);

      fromMetric.likesGiven += 1;
      toMetric.likesReceived += 1;
      bumpActivity(fromMetric, bucketHour);
      bumpActivity(toMetric, bucketHour);

      recomputeRatios(fromMetric);
      recomputeRatios(toMetric);

      await metricsRepo.save([fromMetric, toMetric]);
      return;
    }
    case "skip": {
      const fromMetric = await ensureMetric(payload.fromUserId);
      const toMetric = await ensureMetric(payload.toUserId);

      fromMetric.skipsGiven += 1;
      toMetric.skipsReceived += 1;
      bumpActivity(fromMetric, bucketHour);
      bumpActivity(toMetric, bucketHour);

      recomputeRatios(fromMetric);
      recomputeRatios(toMetric);

      await metricsRepo.save([fromMetric, toMetric]);
      return;
    }
    case "match": {
      const actorMetric = await ensureMetric(payload.fromUserId);
      const partnerMetric = await ensureMetric(payload.toUserId);

      actorMetric.matches += 1;
      partnerMetric.matches += 1;
      bumpActivity(actorMetric, bucketHour);
      bumpActivity(partnerMetric, bucketHour);

      recomputeRatios(actorMetric);
      recomputeRatios(partnerMetric);

      await metricsRepo.save([actorMetric, partnerMetric]);
      return;
    }
    default: {
      const _check: never = type;
      return _check;
    }
  }
}

async function ensureMetric(userId: string): Promise<UserMetric> {
  const existing = await metricsRepo.findOne({ where: { userId } });
  if (existing) {
    return existing;
  }

  const metric = metricsRepo.create({
    userId,
    likesGiven: 0,
    likesReceived: 0,
    skipsGiven: 0,
    skipsReceived: 0,
    matches: 0,
    conversationsStarted: 0,
    likeSkipRatio: 0,
    activityByHour: {},
  });

  await metricsRepo.save(metric);
  return metric;
}

function bumpActivity(metric: UserMetric, hour: string): void {
  const nextMap = { ...metric.activityByHour };
  nextMap[hour] = (nextMap[hour] ?? 0) + 1;
  metric.activityByHour = nextMap;
}

function deriveHourBucket(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return String(new Date().getUTCHours());
  }
  return String(date.getUTCHours());
}

function recomputeRatios(metric: UserMetric): void {
  const denom = metric.likesReceived + metric.skipsReceived;
  metric.likeSkipRatio =
    denom > 0
      ? Math.round((metric.likesReceived / denom) * 1000) / 1000
      : metric.likesReceived > 0
        ? 1
        : 0;
}
