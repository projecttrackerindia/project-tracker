#!/usr/bin/env python3
"""One-off production migration runner.

Run this before/after deploy when schema changes are needed:
    RUN_STARTUP_MIGRATIONS=1 python migrate.py

Web workers intentionally do NOT run DDL at import time; doing so caused cold-start
499 storms because every Gunicorn worker ran CREATE/ALTER statements concurrently.
"""
import os
os.environ["RUN_STARTUP_MIGRATIONS"] = "1"
os.environ.setdefault("RUN_SCALE_INDEX_WARMUP", "1")
import app  # noqa: F401 - importing runs guarded startup migrations once in this process
print("Migrations completed.")
