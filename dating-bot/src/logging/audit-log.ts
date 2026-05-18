/**
 * Структурированный аудит в stdout для проверки заявки «метрики и логирование»
 * (рядом с Prometheus — отдельный поток наблюдаемости по доменным событиям).
 */
export function auditLog(event: string, payload: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      channel: "audit",
      event,
      ...payload,
    }),
  );
}
