import { connect } from "amqplib";
import type { Channel } from "amqplib";
import { domainEventsPublishedTotal } from "../monitoring/metrics-http.js";
import type { DomainEvent, EventPublisher } from "./domain-events.js";

const QUEUE_NAME = "dating.domain_events";

type AmqpConnection = Awaited<ReturnType<typeof connect>>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RabbitEventPublisher implements EventPublisher {
  private connection: AmqpConnection | null = null;

  private channel: Channel | null = null;

  private ready: Promise<void>;

  constructor(private readonly url: string) {
    this.ready = this.initUntilConnected();
  }

  /**
   * Compose иногда поднимает RabbitMQ после приложений; здесь только повтор до успеха —
   * иначе отклонённый Promise становится необработанным и валит процесс Node.
   */
  private async initUntilConnected(): Promise<void> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let connection: AmqpConnection | undefined;
      try {
        connection = await connect(this.url);
        connection.on("error", (error) =>
          console.error("[rabbit-publisher] Ошибка соединения AMQP:", error.message),
        );
        const channel = await connection.createChannel();
        await channel.assertQueue(QUEUE_NAME, { durable: true });
        this.connection = connection;
        this.channel = channel;
        console.log(`[rabbit-publisher] RabbitMQ доступен после попытки ${attempt}`);
        return;
      } catch (error) {
        if (connection) {
          await connection.close().catch(() => undefined);
        }
        const messageText = error instanceof Error ? error.message : String(error);
        console.warn(
          `[rabbit-publisher] RabbitMQ пока недоступен (${messageText}), попытка ${attempt}. Ждём брокер...`,
        );
        const backoff = Math.min(2_500 * Math.min(attempt, 30), 30_000);
        await sleep(backoff);
      }
    }
  }

  async publish(event: DomainEvent): Promise<void> {
    try {
      await this.ready;
      const channel = this.channel;
      if (!channel) {
        return;
      }

      const payload = Buffer.from(JSON.stringify(event));
      channel.sendToQueue(QUEUE_NAME, payload, {
        persistent: true,
        contentType: "application/json",
      });
      domainEventsPublishedTotal.labels(event.type).inc();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[rabbit-publisher] Ошибка публикации события ${event.type} в очередь:`,
        message,
      );
    }
  }

  async close(): Promise<void> {
    try {
      await this.channel?.close();
    } catch {
      // ignore close errors
    }
    try {
      await this.connection?.close();
    } catch {
      // ignore close errors
    }
    this.channel = null;
    this.connection = null;
  }
}

export const DOMAIN_EVENTS_QUEUE = QUEUE_NAME;
