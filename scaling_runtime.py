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

    def worker_status(self) -> Dict[str, Any]:
        """Live view of whatever `python worker.py` processes are actually
        registered with Redis right now — RQ workers self-register and send a
        heartbeat, so this answers "is the worker service actually running?"
        directly instead of needing to check the Railway dashboard by hand.
        Returns {enabled, backend, workers: [{name, state, last_heartbeat}]}."""
        out: Dict[str, Any] = {"enabled": self.ready, "backend": self.backend, "workers": []}
        if not self.ready:
            return out
        try:
            from rq import Worker  # type: ignore
            for w in Worker.all(connection=self.redis):
                hb = getattr(w, "last_heartbeat", None)
                out["workers"].append({
                    "name": w.name,
                    "state": w.get_state() if hasattr(w, "get_state") else "unknown",
                    "last_heartbeat": hb.isoformat() if hb else "",
                })
        except Exception:
            pass
        return out


class ObjectStore:
    """S3-compatible object storage helper (Railway Buckets, Cloudflare R2, MinIO, AWS S3)
    with a local-disk fallback.

    Env vars (first name that is set wins):
      OBJECT_STORE_PROVIDER   s3 | r2 | minio   (anything else => local disk)
      S3_BUCKET               or AWS_S3_BUCKET_NAME
      S3_ENDPOINT_URL         or S3_ENDPOINT or AWS_ENDPOINT_URL
      S3_REGION               or AWS_DEFAULT_REGION   (default: auto)
      S3_ACCESS_KEY_ID        or AWS_ACCESS_KEY_ID
      S3_SECRET_ACCESS_KEY    or AWS_SECRET_ACCESS_KEY
      S3_ADDRESSING_STYLE     virtual (default, required by Railway Buckets) | path
    """

    def __init__(self, local_dir: str) -> None:
        self.local_dir = local_dir
        self.provider = os.getenv("OBJECT_STORE_PROVIDER", "local").lower().strip() or "local"
        self.bucket = _first_env("S3_BUCKET", "AWS_S3_BUCKET_NAME")
        self.endpoint = _first_env("S3_ENDPOINT_URL", "S3_ENDPOINT", "AWS_ENDPOINT_URL")
        self.region = _first_env("S3_REGION", "AWS_DEFAULT_REGION") or "auto"
        self.access_key = _first_env("S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID")
        self.secret_key = _first_env("S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")
        self.addressing = (_first_env("S3_ADDRESSING_STYLE") or "virtual").lower()
        self.client = None
        self.init_error = ""
        if self.provider in {"s3", "r2", "minio"}:
            missing = [n for n, v in (("bucket", self.bucket), ("access key", self.access_key),
                                      ("secret key", self.secret_key)) if not v]
            if missing:
                self.init_error = "missing " + ", ".join(missing)
            else:
                try:
                    import boto3  # type: ignore
                    from botocore.config import Config  # type: ignore
                    self.client = boto3.client(
                        "s3",
                        region_name=self.region,
                        endpoint_url=self.endpoint or None,
                        aws_access_key_id=self.access_key,
                        aws_secret_access_key=self.secret_key,
                        config=Config(
                            signature_version="s3v4",
                            s3={"addressing_style": self.addressing},
                            retries={"max_attempts": 3, "mode": "standard"},
                        ),
                    )
                except Exception as exc:  # boto3 missing, bad config, ...
                    self.init_error = f"{type(exc).__name__}: {exc}"
                    self.client = None
            if self.client is None:
                # Do NOT fail silently: uploads would quietly land on the container disk.
                print(f"[object-store] WARNING: OBJECT_STORE_PROVIDER={self.provider!r} but S3 client "
                      f"is not usable ({self.init_error}). Falling back to LOCAL DISK.", flush=True)
                # Names only (never values): shows typos / trailing spaces / empty values.
                seen = {repr(k): ("set" if (v or "").strip() else "EMPTY")
                        for k, v in os.environ.items()
                        if any(t in k.upper() for t in ("S3", "AWS", "BUCKET", "OBJECT_STORE"))}
                print(f"[object-store] related env vars seen by this container: {seen}", flush=True)
                self.provider = "local"
            else:
                print(f"[object-store] S3 ready: bucket={self.bucket} endpoint={self.endpoint or 'aws-default'} "
                      f"region={self.region} style={self.addressing}", flush=True)

    @property
    def ready(self) -> bool:
        return self.client is not None and bool(self.bucket)

    def check(self) -> Tuple[bool, str]:
        """Live connectivity + credentials check (used by /readyz)."""
        if not self.ready:
            return False, self.init_error or "not configured (local disk mode)"
        try:
            self.client.head_bucket(Bucket=self.bucket)
            return True, ""
        except Exception as exc:
            return False, f"{type(exc).__name__}: {str(exc)[:200]}"

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
        safe_name = (filename or "download").replace('"', "").replace("\r", "").replace("\n", "")
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.bucket, "Key": key, "ResponseContentDisposition": f'attachment; filename="{safe_name}"'},
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

    def delete_object(self, key: str) -> None:
        """Delete one object from the bucket. Raises on failure (S3 delete is idempotent:
        deleting a key that does not exist is not an error)."""
        if not self.ready:
            raise RuntimeError("object store is not configured")
        if not key:
            return
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def delete(self, key_or_path: str) -> None:
        """Legacy helper: delete an S3 key when the store is ready, else a local file."""
        if self.ready and key_or_path and not os.path.isabs(key_or_path):
            self.client.delete_object(Bucket=self.bucket, Key=key_or_path)
            return
        try:
            if key_or_path and os.path.exists(key_or_path):
                os.remove(key_or_path)
        except Exception:
            pass


def _first_env(*names: str) -> str:
    for n in names:
        v = os.getenv(n)
        if v and v.strip():
            return v.strip()
    return ""


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
