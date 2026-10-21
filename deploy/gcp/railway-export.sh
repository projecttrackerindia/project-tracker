#!/usr/bin/env bash
# Exports the Railway settings of each service into ~/.pt-gcp/railway-<name>.env (KEY=value lines), straight from Railway's API.
# Works with an account or workspace token, read from ~/.pt-gcp/railway-token or Secret Manager (secret "railway-token").
# Nothing is printed except how many settings each service has.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
RW_PROJECT="${RW_PROJECT:-76ff27e1-cd35-41ae-89c9-203cc8c6784d}"
RW_ENV="${RW_ENV:-90c4f58a-9e31-43ff-bf16-cd4d0aca259c}"
[ -s "$STATE/railway-token" ] || gcloud secrets versions access latest --secret=railway-token > "$STATE/railway-token"
chmod 600 "$STATE/railway-token"
export RW_TOKEN_FILE="$STATE/railway-token" RW_PROJECT RW_ENV STATE
python3 - <<'PY'
import json, os, urllib.request
token = open(os.environ["RW_TOKEN_FILE"]).read().strip()
def gql(query, variables=None):
    req = urllib.request.Request("https://backboard.railway.com/graphql/v2",
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "pt-gcp-move"})
    out = json.load(urllib.request.urlopen(req, timeout=30))
    if out.get("errors"): raise SystemExit("Railway said: " + out["errors"][0]["message"])
    return out["data"]
p = os.environ["RW_PROJECT"]; e = os.environ["RW_ENV"]
services = gql("query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }", {"id": p})["project"]["services"]["edges"]
names = {"API": "api", "MeetBot": "meetbot", "Postgres": "postgres", "FrontEnd": "web"}
for edge in services:
    s = edge["node"]
    v = gql("query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }", {"p": p, "e": e, "s": s["id"]})["variables"]
    key = names.get(s["name"], s["name"].lower())
    path = os.path.join(os.environ["STATE"], f"railway-{key}.env")
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        for k in sorted(v): f.write(f"{k}={v[k]}\n")
    multi = [k for k in v if "\n" in str(v[k])]
    print(f"{s['name']}: {len(v)} settings -> {path}" + (f"  (several lines: {', '.join(multi)})" if multi else ""))
PY
