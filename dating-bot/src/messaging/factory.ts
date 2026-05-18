import { PhotoStorageService } from "../services/photo-storage.service.js";
import { NoopEventPublisher } from "./noop-publisher.js";
import type { EventPublisher } from "./domain-events.js";
import { RabbitEventPublisher } from "./rabbit-publisher.js";

export function createEventPublisher(): EventPublisher {
  const url = process.env.RABBITMQ_URL?.trim();
  if (!url) {
    console.warn(
      "[events] RABBITMQ_URL не задан: доменные события из бота без брокера (локальная отладка).",
    );
    return new NoopEventPublisher();
  }

  console.log(
    "[events] Публикатор RabbitMQ создаётся (при необходимости будут автоматические повторы до старта брокера).",
  );
  return new RabbitEventPublisher(url);
}

export function createConfiguredPhotoStorage(): PhotoStorageService | null {
  const bucket = process.env.S3_BUCKET?.trim();
  const accessKeyId = process.env.S3_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.S3_SECRET_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) {
    console.warn(
      "[photos] MinIO/S3 недоступен: задайте S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY (опционально S3_ENDPOINT для MinIO).",
    );
    return null;
  }

  const endpoint = process.env.S3_ENDPOINT?.trim();
  const storage = new PhotoStorageService({
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: endpoint?.length ? endpoint : undefined,
  });

  return storage;
}
