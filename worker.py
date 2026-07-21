#!/usr/bin/env python3
"""Background worker for Project Tracker scale mode.

Run as a separate service when ASYNC_BACKEND=rq and REDIS_URL are configured:
    python worker.py

Heavy tasks such as imports, payslip mapping, email/push fanout, analytics and
file processing should be queued here instead of running inside web requests.
"""
import os
import sys

if __name__ == "__main__":
    redis_url = os.getenv("REDIS_URL", "")
    if not redis_url:
        print("REDIS_URL is required for the RQ worker", file=sys.stderr)
        sys.exit(1)
    try:
        import redis
        from rq import Worker, Queue, Connection
    except Exception as exc:
        print(f"rq/redis dependencies missing: {exc}", file=sys.stderr)
        sys.exit(1)

    listen = [q.strip() for q in os.getenv("RQ_QUEUES", "default,imports,notifications,analytics").split(",") if q.strip()]
    conn = redis.from_url(redis_url)
    with Connection(conn):
        worker = Worker([Queue(name) for name in listen])
        worker.work(with_scheduler=True)
