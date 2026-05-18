from __future__ import annotations

import json
import os
from collections import defaultdict
from typing import Any

import psycopg2
import redis
from celery_app import app


def _normalize_database_url(url: str) -> str:
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql://", 1)
    return url


@app.task(name="tasks.purge_feed_queues")
def purge_feed_queues() -> dict[str, Any]:
    redis_url = os.environ["REDIS_URL"]
    client = redis.Redis.from_url(redis_url, decode_responses=False)
    deleted = 0
    for key in client.scan_iter(match="feed:*", count=256):
        deleted += int(client.delete(key))
    return {"deleted_keys": deleted}


@app.task(name="tasks.reconcile_user_metrics")
def reconcile_user_metrics() -> dict[str, Any]:
    database_url = _normalize_database_url(os.environ["DATABASE_URL"])
    aggregates: dict[str, dict[str, float | int]] = defaultdict(
        lambda: {
            "likes_received": 0,
            "likes_given": 0,
            "skips_received": 0,
            "skips_given": 0,
            "matches": 0,
        },
    )

    with psycopg2.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT from_user_id::text, to_user_id::text, type
                FROM interactions
                """,
            )

            for from_id, to_id, interaction_type in cur.fetchall():
                if interaction_type == "like":
                    aggregates[from_id]["likes_given"] += 1
                    aggregates[to_id]["likes_received"] += 1
                elif interaction_type == "skip":
                    aggregates[from_id]["skips_given"] += 1
                    aggregates[to_id]["skips_received"] += 1
                elif interaction_type == "match":
                    aggregates[from_id]["matches"] += 1
                    aggregates[to_id]["matches"] += 1

        with conn.cursor() as cur:
            for user_id, stats in aggregates.items():
                likes_received = int(stats["likes_received"])
                skips_received = int(stats["skips_received"])
                denominator = likes_received + skips_received
                ratio = (likes_received / denominator) if denominator > 0 else 0.0

                cur.execute(
                    """
                    INSERT INTO user_metrics (
                        id,
                        user_id,
                        likes_received,
                        likes_given,
                        skips_received,
                        skips_given,
                        matches,
                        conversations_started,
                        like_skip_ratio,
                        activity_by_hour,
                        updated_at
                    )
                    VALUES (
                        gen_random_uuid(),
                        %s::uuid,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        0,
                        %s,
                        %s::jsonb,
                        NOW()
                    )
                    ON CONFLICT (user_id) DO UPDATE SET
                        likes_received = EXCLUDED.likes_received,
                        likes_given = EXCLUDED.likes_given,
                        skips_received = EXCLUDED.skips_received,
                        skips_given = EXCLUDED.skips_given,
                        matches = EXCLUDED.matches,
                        like_skip_ratio = EXCLUDED.like_skip_ratio,
                        updated_at = NOW();
                    """,
                    [
                        user_id,
                        likes_received,
                        int(stats["likes_given"]),
                        skips_received,
                        int(stats["skips_given"]),
                        int(stats["matches"]),
                        ratio,
                        json.dumps({}),
                    ],
                )

        conn.commit()

    return {"users_touched": len(aggregates)}


@app.task(name="tasks.redis_worker_heartbeat")
def redis_worker_heartbeat() -> dict[str, Any]:
    """Отдельное от purge использование Redis из Celery — наблюдаемость воркера (не брокер задач)."""
    redis_url = os.environ["REDIS_URL"]
    client = redis.Redis.from_url(redis_url, decode_responses=False)
    key = "stats:celery:worker_heartbeat"
    n = int(client.incr(key))
    client.expire(key, 3600)
    return {"incr": n}
