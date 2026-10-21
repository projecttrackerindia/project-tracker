#!/usr/bin/env bash
# Opens (on) or closes (off) a temporary public address for the Railway Postgres, only for copying the database to Cloud SQL.
# "on" also writes DATABASE_PUBLIC_URL into ~/.pt-gcp/railway-postgres.env for 4-migrate.sh. The password stays Railway's own.
set -euo pipefail
cd "$(dirname "$0")"; source ./config.sh
export RW_TOKEN_FILE="$STATE/railway-token" RW_ENV="${RW_ENV:-90c4f58a-9e31-43ff-bf16-cd4d0aca259c}" \
  RW_DB_SERVICE="${RW_DB_SERVICE:-4048b1c9-cc4e-4d51-81b4-9111f0611283}" STATE ACTION="${1:-on}"
python3 - <<'PY'
import json, os, time, urllib.request, urllib.parse
token = open(os.environ["RW_TOKEN_FILE"]).read().strip()
env, svc, action, state = os.environ["RW_ENV"], os.environ["RW_DB_SERVICE"], os.environ["ACTION"], os.environ["STATE"]
def gql(query, variables=None):
    req = urllib.request.Request("https://backboard.railway.com/graphql/v2",
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "pt-gcp-move"})
    out = json.load(urllib.request.urlopen(req, timeout=30))
    if out.get("errors"): raise SystemExit("Railway said: " + out["errors"][0]["message"])
    return out["data"]
def proxies():
    return gql("query($e:String!,$s:String!){ tcpProxies(environmentId:$e, serviceId:$s){ id domain proxyPort applicationPort } }", {"e": env, "s": svc})["tcpProxies"]
if action == "off":
    for p in proxies():
        gql("mutation($id:String!){ tcpProxyDelete(id:$id) }", {"id": p["id"]})
        print("Closed", p["domain"])
    raise SystemExit(0)
found = [p for p in proxies() if p["applicationPort"] == 5432]
if not found:
    gql("mutation($i:TCPProxyCreateInput!){ tcpProxyCreate(input:$i){ id } }",
        {"i": {"environmentId": env, "serviceId": svc, "applicationPort": 5432}})
    for _ in range(30):
        found = [p for p in proxies() if p["applicationPort"] == 5432 and p["domain"]]
        if found: break
        time.sleep(5)
p = found[0]
path = os.path.join(state, "railway-postgres.env")
vals = dict(line.rstrip("\n").split("=", 1) for line in open(path) if "=" in line)
user, pw, db = vals["PGUSER"], vals["PGPASSWORD"], vals["PGDATABASE"]
url = f"postgresql://{urllib.parse.quote(user)}:{urllib.parse.quote(pw, safe='')}@{p['domain']}:{p['proxyPort']}/{db}"
lines = [l for l in open(path) if not l.startswith("DATABASE_PUBLIC_URL=")] + [f"DATABASE_PUBLIC_URL={url}\n"]
with open(os.open(path, os.O_WRONLY | os.O_TRUNC, 0o600), "w") as f: f.writelines(lines)
print("Open:", p["domain"], "port", p["proxyPort"], "(close it after the move: ./railway-db-proxy.sh off)")
PY
