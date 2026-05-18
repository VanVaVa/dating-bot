import http from "node:http";
import client from "prom-client";

const register = new client.Registry();

client.collectDefaultMetrics({
  register,
  prefix: "dating_bot_system_",
});

export const telegramUpdatesTotal = new client.Counter({
  name: "dating_bot_telegram_updates_total",
  help: "Обработанные Telegram updates (middleware grammy)",
  labelNames: ["kind"],
  registers: [register],
});

export const domainEventsPublishedTotal = new client.Counter({
  name: "dating_bot_domain_events_published_total",
  help: "Количество опубликованных доменных событий через RabbitMQ",
  labelNames: ["event"],
  registers: [register],
});

export const domainEventsConsumeTotal = new client.Counter({
  name: "dating_bot_domain_events_processed_total",
  help: "Количество обработанных доменных событий процессором",
  labelNames: ["event"],
  registers: [register],
});

export const profileFlowErrorsTotal = new client.Counter({
  name: "dating_bot_profile_flow_errors_total",
  help: "Ошибки в многошаговом профиле",
  registers: [register],
});

export const rankingRecalculateDurationSeconds = new client.Histogram({
  name: "dating_bot_ranking_recalculate_duration_seconds",
  help: "Длительность пересчёта рейтинга для одного пользователя",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

export function createMetricsRegistrar(): typeof register {
  return register;
}

export async function listenMetricsHttp(port: number): Promise<{ close(): Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      try {
        res.setHeader("content-type", register.contentType);
        res.statusCode = 200;
        res.end(await register.metrics());
      } catch (error) {
        console.error("[metrics] Ошибка выдачи /metrics:", error);
        res.statusCode = 500;
        res.end("metrics_error");
      }
      return;
    }

    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
      return;
    }

    res.statusCode = 404;
    res.end("not_found");
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  console.log(`[metrics] Prometheus endpoint http://0.0.0.0:${port}/metrics, health=/health`);

  return {
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
