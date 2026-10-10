#!/usr/bin/env python3
"""Read-only synthetic inference benchmark. Does not execute tools, download models or use production conversations."""
import argparse
import json
import math
import os
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path


def score(case, content, calls):
    """Score selection only. Extra/duplicate calls must not conceal an unsafe operation."""
    if case.get("expectText"):
        return bool(content.strip()) and not calls
    if not isinstance(calls, list) or len(calls) != 1 or not isinstance(calls[0], dict):
        return False
    function = calls[0].get("function", {})
    if not isinstance(function, dict):
        return False
    arguments = function.get("arguments", {})
    return (function.get("name") == case["expectTool"] and isinstance(arguments, dict)
            and all(arguments.get(k) == v for k, v in case.get("arguments", {}).items()))


def run(base, key, model, case, corpus, context, threads, timeout):
    body = {"model": model, "stream": True, "think": False, "keep_alive": "10m",
            "messages": [{"role": "system", "content": corpus["system"]}, {"role": "user", "content": case["request"]}],
            "options": {"num_ctx": context, "num_predict": 256, "num_thread": threads}}
    if case.get("tools", True):
        body["tools"] = corpus["tools"]
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    request = urllib.request.Request(base.rstrip("/").removesuffix("/v1") + "/api/chat", data=json.dumps(body).encode(), headers=headers)
    start = time.monotonic()
    first = None
    content = ""
    calls = []
    final = None
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            # HTTP read timeouts alone do not bound a stream that keeps emitting. Check a whole-run deadline too.
            for line in response:
                if time.monotonic() - start > timeout:
                    raise TimeoutError()
                part = json.loads(line)
                if "error" in part:
                    raise ValueError("model error")
                message = part.get("message", {})
                delta = message.get("content", "")
                if delta and first is None:
                    first = time.monotonic() - start
                content += delta
                calls.extend(message.get("tool_calls", []))
                if part.get("done"):
                    final = part
        if final is None:
            raise ValueError("incomplete stream")
        valid = score(case, content, calls)
        generation = final.get("eval_duration", 0) / 1e9
        return {"model": model, "case": case["id"], "passed": valid, "elapsed_s": time.monotonic() - start, "first_token_s": first,
                "input_tokens": final.get("prompt_eval_count"), "output_tokens": final.get("eval_count"),
                "load_s": final.get("load_duration", 0) / 1e9, "prompt_s": final.get("prompt_eval_duration", 0) / 1e9,
                "generation_s": generation, "tokens_per_s": final.get("eval_count", 0) / generation if generation else None}
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError, TypeError):
        # Never print response text or credentials, even on failure.
        return {"model": model, "case": case["id"], "passed": False, "elapsed_s": time.monotonic() - start, "error": "inference_or_transport_failed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="append", required=True, help="Installed Ollama tag; repeat to compare models")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--context", type=int, default=8192)
    parser.add_argument("--threads", type=int, required=True, help="Actual inference service CPU allocation")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 100 or not 1 <= args.threads <= 64 or not 256 <= args.context <= 131072 or not 1 <= args.timeout <= 600:
        parser.error("Use 1–100 repeats, 1–64 CPU threads, context 256–131072 and timeout 1–600 seconds")
    base = os.environ.get("OLLAMA_BASE_URL")
    if not base:
        parser.error("Set OLLAMA_BASE_URL in your execution environment")
    corpus = json.loads(Path(__file__).with_name("cases.json").read_text())
    samples = [run(base, os.environ.get("OLLAMA_API_KEY"), model, case, corpus, args.context, args.threads, args.timeout)
               for model in args.model for _ in range(args.repeats) for case in corpus["cases"]]
    summary = []
    for model in args.model:
        mine = [s for s in samples if s["model"] == model]
        timings = sorted(s["elapsed_s"] for s in mine)
        summary.append({"model": model, "samples": len(mine), "passed": sum(s["passed"] for s in mine),
                        "mean_s": statistics.mean(timings), "p50_s": statistics.median(timings), "p95_s": timings[math.ceil(len(timings) * .95) - 1],
                        "failure_rate": sum(not s["passed"] for s in mine) / len(mine)})
    report = {"dataset_version": corpus["version"], "context": args.context, "threads": args.threads,
              "scope": "synthetic provider/tool-selection benchmark; does not verify application side effects or security",
              "summary": summary, "samples": samples}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
