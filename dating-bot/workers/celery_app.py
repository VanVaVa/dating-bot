from __future__ import annotations

import os

from celery import Celery
from celery.schedules import crontab

broker_url = os.environ["CELERY_BROKER_URL"]
result_backend = os.environ.get("CELERY_RESULT_BACKEND", "rpc://")

app = Celery("dating-workers", broker=broker_url, backend=result_backend)
app.conf.timezone = "UTC"

app.conf.beat_schedule = {
    "purge-feed-cache": {
        "task": "tasks.purge_feed_queues",
        "schedule": crontab(minute="*/10"),
    },
    "reconcile-user-metrics": {
        "task": "tasks.reconcile_user_metrics",
        "schedule": crontab(minute="*/30"),
    },
    "redis-worker-heartbeat": {
        "task": "tasks.redis_worker_heartbeat",
        "schedule": crontab(minute="*/15"),
    },
}


import tasks  # noqa: F401,E402 — регистрация задач Celery
