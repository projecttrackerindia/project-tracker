#!/usr/bin/env bash
# Checks that Gemini answers through Vertex AI in Mumbai for this project (as you, from Cloud Shell). Usage: ./ai-check.sh [model]
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
MODEL="${1:-${GEMINI_MODEL:-gemini-2.5-flash}}"
curl -sS -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
  "https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${MODEL}:generateContent" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with the single word: ready"}]}],"generationConfig":{"maxOutputTokens":20}}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("OK:", d["candidates"][0]["content"]["parts"][0]["text"].strip()) if "candidates" in d else (print("FAILED:", d.get("error",{}).get("message",d)), sys.exit(1))'
