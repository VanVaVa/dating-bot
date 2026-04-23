const FEED_TTL_SECONDS = 60 * 10;

export interface FeedCacheClient {
  del(key: string): Promise<unknown>;
  rPush(key: string, elements: string[]): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lPop(key: string): Promise<string | null>;
}

export class FeedCacheService {
  constructor(private readonly redis: FeedCacheClient) {}

  private key(userId: string): string {
    return `feed:${userId}`;
  }

  async cacheCandidateIds(userId: string, ids: string[]): Promise<void> {
    if (!ids.length) {
      await this.redis.del(this.key(userId));
      return;
    }

    await this.redis.del(this.key(userId));
    await this.redis.rPush(this.key(userId), ids);
    await this.redis.expire(this.key(userId), FEED_TTL_SECONDS);
  }

  async popNextCandidateId(userId: string): Promise<string | null> {
    return this.redis.lPop(this.key(userId));
  }
}
