import type { InteractionType } from "../entities/Interaction.js";

export type DomainEvent =
  | {
      type: "interaction.created";
      payload: {
        interactionId: string;
        fromUserId: string;
        toUserId: string;
        interactionType: InteractionType;
        createdAt: string;
      };
    }
  | {
      type: "profile.updated";
      payload: {
        userId: string;
        updatedAt: string;
      };
    }
  | {
      type: "referral.created";
      payload: {
        referralId: string;
        referrerId: string;
        referredId: string;
        createdAt: string;
      };
    };

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
  close(): Promise<void>;
}
