import type { DomainEvent, EventPublisher } from "./domain-events.js";

export class NoopEventPublisher implements EventPublisher {
  async publish(_event: DomainEvent): Promise<void> {}

  async close(): Promise<void> {}
}
