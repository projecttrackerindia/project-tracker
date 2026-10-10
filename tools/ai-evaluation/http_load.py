#!/usr/bin/env python3
"""Bounded GET-only HTTP ramp. One credential measures concurrent requests, not distinct users."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


def sample(url, key, start, timeout):
    start.wait()
    began = time.monotonic()
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + key}, method="GET")
    status = 0
    code = None
    success = False
    try:
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            body = response.read(2_000_001)
            if len(body) > 2_000_000:
                code = "response_too_large"
            else:
                parsed = json.loads(body)
                success = status == 200 and isinstance(parsed, dict) and parsed.get("success") is True
                if isinstance(parsed, dict) and isinstance(parsed.get("errors"), list):
                    errors = parsed["errors"]
                    if errors and isinstance(errors[0], dict):
                        code = errors[0].get("code")
    except (OSError, ValueError, urllib.error.URLError):
        code = "transport_or_invalid_response"
    # Never retain response content, identity, URL query data or credentials.
    return {"status": status, "success": success, "error": code, "elapsed_s": time.monotonic() - began}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--concurrency", type=int, action="append", required=True)
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--allow-production", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    url = urllib.parse.urlparse(args.url)
    if url.scheme not in ("http", "https") or url.username or url.password:
        parser.error("Use an HTTP(S) URL without embedded credentials")
    if url.hostname not in ("localhost", "127.0.0.1", "::1") and not args.allow_production:
        parser.error("Remote load checks require --allow-production and operator authorization")
    if not all(1 <= c <= 100 for c in args.concurrency) or not 1 <= args.timeout <= 60:
        parser.error("Use concurrency 1–100 and timeout 1–60 seconds")
    key = os.environ.get("APP_LOAD_KEY")
    if not key:
        parser.error("Set APP_LOAD_KEY in the process environment")
    phases = []
    for concurrency in args.concurrency:
        start = threading.Event()
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            pending = [pool.submit(sample, args.url, key, start, args.timeout) for _ in range(concurrency)]
            began = time.monotonic()
            start.set()
            samples = [future.result() for future in pending]
        times = sorted(s["elapsed_s"] for s in samples)
        phase = {"concurrency": concurrency, "requests": len(samples), "succeeded": sum(s["success"] for s in samples),
                 "elapsed_s": time.monotonic() - began, "p50_s": times[math.ceil(len(times) * .5) - 1],
                 "p95_s": times[math.ceil(len(times) * .95) - 1], "p99_s": times[math.ceil(len(times) * .99) - 1],
                 "status_counts": dict(Counter(str(s["status"]) for s in samples)),
                 "error_counts": dict(Counter(s["error"] or "unspecified" for s in samples if not s["success"]))}
        phases.append(phase)
        print(json.dumps(phase), flush=True)
        if phase["succeeded"] != phase["requests"]:
            break  # Stop ramping on errors or rate limits; never disable or retry around admission controls.
    report = {"scope": "GET-only ramp; one API credential, not 100 distinct users; fresh HTTP/TLS connections; no model inference",
              "phases": phases}
    args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
