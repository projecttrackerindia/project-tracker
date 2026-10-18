#!/usr/bin/env node
// Measures the project agent against synthetic cases (cases.v1.json) on a running installation, with a sandbox project whose agent is on.
//
//   PT_API=https://api.example.com PT_TOKEN=<access token> PT_PROJECT=<sandbox project id> node evaluation/project-agent/evaluate.mjs [--keep]
//   node evaluation/project-agent/evaluate.mjs --self-test      (checks the scoring only; no server needed)
//
// Each case is given to the agent as a transcript, its proposals are scored (precision: how many proposals were right; recall: how many
// expected items were found), and then dismissed so the sandbox stays clean (--keep leaves them). A report goes to evaluation/project-agent/report.json.
// It uses AI credits of the sandbox's workspace: about two readings per case.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(new URL(import.meta.url).pathname);
const cases = JSON.parse(await fs.readFile(path.join(here, 'cases.v1.json'), 'utf8')).cases;

const text = (f) => `${f.title} ${f.detail ?? ''} ${f.comment ?? ''}`.toLowerCase();
const first = (name) => (name ?? '').split(' ')[0].toLowerCase();
const matches = (f, e) => f.kind === e.kind && e.keywords.every((k) => text(f).includes(k.toLowerCase())) && (!e.owner || first(f.assignee?.name) === e.owner.toLowerCase());

/** Scores one case: which expected items were found, which proposals were not expected, and which forbidden ones appeared. */
export function score(kase, proposals) {
  const used = new Set();
  const found = [], missed = [];
  for (const e of kase.expected) {
    const hit = proposals.findIndex((f, i) => !used.has(i) && matches(f, e));
    if (hit >= 0) { used.add(hit); found.push(e); } else if (!e.optional) missed.push(e);
  }
  const optionalFound = found.filter((e) => e.optional).length;
  const alarms = proposals.filter((f) => (kase.mustNot ?? []).some((m) => matches(f, m)));
  const extra = proposals.filter((_, i) => !used.has(i));
  const required = kase.expected.filter((e) => !e.optional).length;
  return {
    id: kase.id, proposals: proposals.length, expected: required, found: found.length - optionalFound, optionalFound, missed, alarms, extra: extra.map((f) => `${f.kind}: ${f.title}`),
    // Extra proposals are not all wrong (the agent may notice more than the case lists); forbidden ones are.
    precision: proposals.length ? 1 - alarms.length / proposals.length : 1,
    recall: required ? (found.length - optionalFound) / required : 1,
  };
}

if (process.argv.includes('--self-test')) {
  const k = cases.find((c) => c.id === 'standup-basic');
  const s = score(k, [
    { kind: 'CreateIssue', title: 'Refund screens break on small phones', detail: null, comment: null, assignee: { name: 'Priya S' } },
    { kind: 'Missed', title: 'Nobody owns the refund API', detail: null, comment: null, assignee: null },
    { kind: 'CreateTask', title: 'Build the refund API', detail: null, comment: null, assignee: { name: 'Ravi Kumar' } },
  ]);
  assert.equal(s.found, 2); assert.equal(s.recall, 1); assert.equal(s.alarms.length, 1); assert.ok(Math.abs(s.precision - 2 / 3) < 1e-9);
  const quiet = score(cases.find((c) => c.id === 'small-talk'), []);
  assert.equal(quiet.recall, 1); assert.equal(quiet.precision, 1);
  console.log('scoring self-test passed');
  process.exit(0);
}

const api = process.env.PT_API?.replace(/\/$/, ''), token = process.env.PT_TOKEN, project = process.env.PT_PROJECT;
if (!api || !token || !project) { console.error('Set PT_API, PT_TOKEN and PT_PROJECT (a sandbox project with the agent switched on).'); process.exit(2); }
const call = async (method, url, body) => {
  const res = await fetch(`${api}/api/v1${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.data;
};

const results = [];
const stamp = new Date().toISOString().slice(0, 16);
for (const kase of cases) {
  const r = await call('POST', `/projects/${project}/agent/transcript`, { title: `${kase.title} · ${stamp}`, text: kase.text });
  if (!r.run || r.run.status !== 'done') { results.push({ id: kase.id, error: r.run?.error ?? 'not read' }); continue; }
  const page = await call('GET', `/projects/${project}/agent/findings?status=proposed`);
  const proposals = page.items.filter((f) => f.runId === r.run.id);
  const s = score(kase, proposals);
  s.ungrounded = proposals.filter((f) => !f.grounded).length;
  results.push(s);
  if (!process.argv.includes('--keep')) for (const f of proposals) await call('POST', `/agent/findings/${f.id}/dismiss`);
  console.log(`${kase.id.padEnd(18)} found ${s.found}/${s.expected}  proposals ${s.proposals}  false alarms ${s.alarms.length}  unchecked quotes ${s.ungrounded}`);
}
const ok = results.filter((r) => !r.error);
const avg = (k) => ok.length ? ok.reduce((a, r) => a + r[k], 0) / ok.length : 0;
const summary = { at: new Date().toISOString(), cases: results.length, failed: results.length - ok.length, recall: +avg('recall').toFixed(3), precision: +avg('precision').toFixed(3) };
await fs.writeFile(path.join(here, 'report.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\nrecall ${(summary.recall * 100).toFixed(0)}%  precision ${(summary.precision * 100).toFixed(0)}%  (${summary.failed} case(s) not read) - report.json written`);
