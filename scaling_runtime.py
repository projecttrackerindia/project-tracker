"""Production scaling helpers for WorkspaceOS.

This module is intentionally optional-first: the app keeps running locally without
Redis, RQ, boto3, or Prometheus, but production can enable each feature through
environment variables.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

_executor = ThreadPoolExecutor(max_workers=int(os.getenv("ASYNC_FALLBACK_WORKERS", "6")))


def bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class RuntimeStatus:
    redis_ok: bool = False
    queue_ok: bool = False
    object_store_ok: bool = False
    object_store_provider: str = "local"


class JobQueue:
    """RQ-backed queue with safe in-process fallback for local/dev.

    Production:
      REDIS_URL=redis://...
      ASYNC_BACKEND=rq
      run: python worker.py
    """
    def __init__(self, redis_url: str = "", name: str = "default") -> None:
        self.redis_url = redis_url or os.getenv("REDIS_URL", "")
        self.name = name
        self.backend = os.getenv("ASYNC_BACKEND", "thread").lower()
        self.queue = None
        self.redis = None
        if self.redis_url and self.backend == "rq":
            try:
                import redis  # type: ignore
                from rq import Queue  # type: ignore
                self.redis = redis.from_url(self.redis_url)
                self.redis.ping()
                self.queue = Queue(name, connection=self.redis, default_timeout=int(os.getenv("JOB_TIMEOUT_SECONDS", "900")))
            except Exception:
                self.queue = None
                self.redis = None

    @property
    def ready(self) -> bool:
        return self.queue is not None

    def enqueue(self, fn, *args, queue_name: Optional[str] = None, **kwargs):
        if self.queue is not None:
            if queue_name and queue_name != self.name:
                try:
                    from rq import Queue  # type: ignore
                    q = Queue(queue_name, connection=self.redis, default_timeout=int(os.getenv("JOB_TIMEOUT_SECONDS", "900")))
                    return q.enqueue(fn, *args, **kwargs)
                except Exception:
                    pass
            return self.queue.enqueue(fn, *args, **kwargs)
        return _executor.submit(fn, *args, **kwargs)


class ObjectStore:
    """S3/R2 object storage helper with local fallback.

    Required env for S3/R2:
      OBJECT_STORE_PROVIDER=s3
      S3_BUCKET=...
      AWS_ACCESS_KEY_ID=...
      AWS_SECRET_ACCESS_KEY=...
      S3_ENDPOINT_URL=...   # optional for Cloudflare R2/MinIO
      S3_REGION=auto       # optional
    """
    def __init__(self, local_dir: str) -> None:
        self.local_dir = local_dir
        self.provider = os.getenv("OBJECT_STORE_PROVIDER", "local").lower().strip() or "local"
        self.bucket = os.getenv("S3_BUCKET", "")
        self.endpoint = os.getenv("S3_ENDPOINT_URL", "")
        self.region = os.getenv("S3_REGION", "auto")
        self.client = None
        if self.provider in {"s3", "r2", "minio"} and self.bucket:
            try:
                import boto3  # type: ignore
                kwargs: Dict[str, Any] = {"region_name": self.region}
                if self.endpoint:
                    kwargs["endpoint_url"] = self.endpoint
                self.client = boto3.client("s3", **kwargs)
            except Exception:
                self.client = None
                self.provider = "local"

    @property
    def ready(self) -> bool:
        return self.client is not None and bool(self.bucket)

    def make_key(self, workspace_id: str, file_id: str, filename: str) -> str:
        safe = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "_" for ch in filename)[:120]
        return f"workspaces/{workspace_id}/files/{file_id}/{safe}"

    def put_bytes(self, key: str, data: bytes, mime: str) -> str:
        if self.ready:
            self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=mime or "application/octet-stream")
            return key
        os.makedirs(self.local_dir, exist_ok=True)
        path = os.path.join(self.local_dir, key.replace("/", "__"))
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def get_presigned_download(self, key: str, filename: str, expires: int = 300) -> Optional[str]:
        if not self.ready:
            return None
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key, "ResponseContentDisposition": f'attachment; filename="{filename}"'},
            ExpiresIn=expires,
        )

    def get_presigned_upload(self, key: str, mime: str, expires: int = 900) -> Optional[Dict[str, Any]]:
        if not self.ready:
            return None
        url = self.client.generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": mime or "application/octet-stream"},
            ExpiresIn=expires,
        )
        return {"url": url, "method": "PUT", "headers": {"Content-Type": mime or "application/octet-stream"}, "key": key, "expires_in": expires}

    def delete(self, key_or_path: str) -> None:
        if self.ready and key_or_path and not os.path.isabs(key_or_path):
            self.client.delete_object(Bucket=self.bucket, Key=key_or_path)
            return
        try:
            if key_or_path and os.path.exists(key_or_path):
                os.remove(key_or_path)
        except Exception:
            pass


def parse_cursor_args(args, default_limit: int = 50, max_limit: int = 200) -> Tuple[int, str]:
    try:
        limit = int(args.get("limit", default_limit))
    except Exception:
        limit = default_limit
    limit = max(1, min(limit, max_limit))
    cursor = (args.get("cursor") or "").strip()
    return limit, cursor


def build_next_cursor(rows, field: str = "created") -> str:
    if not rows:
        return ""
    last = rows[-1]
    try:
        return str(last[field] if isinstance(last, dict) else last[field])
    except Exception:
        return ""


def etag_for_payload(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:24]


def incr_metric(redis_client, name: str, labels: Optional[Dict[str, str]] = None, count: int = 1) -> None:
    if redis_client is None:
        return
    try:
        label_suffix = ""
        if labels:
            label_suffix = ":" + ":".join(f"{k}={v}" for k, v in sorted(labels.items()))
        redis_client.incrby(f"metric:{name}{label_suffix}", count)
        redis_client.expire(f"metric:{name}{label_suffix}", 86400)
    except Exception:
        pass


def record_latency(redis_client, endpoint: str, ms: float) -> None:
    if redis_client is None:
        return
    try:
        bucket = "lt100" if ms < 100 else "lt500" if ms < 500 else "lt1000" if ms < 1000 else "gte1000"
        redis_client.incr(f"metric:http_latency_bucket:endpoint={endpoint}:bucket={bucket}")
        redis_client.expire(f"metric:http_latency_bucket:endpoint={endpoint}:bucket={bucket}", 86400)
    except Exception:
        pass
