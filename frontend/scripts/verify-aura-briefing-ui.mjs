import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Aura's briefing on Today (fixtures borrowed from the calm work check): "N things need you today" with one action each (Approve in
// place), At risk and why, meetings with open questions, Ask anything with evidence, the meeting Review & approve sheet (approve all with
// one edit) and the Friday report sheet (preview, edit, Send). 1440 and a 390 phone, light and dark. Fictional fixtures only.
// (Base fixtures: the calm build of Today, My work and Projects (demo shots 01-03, 05, 08-10, 33-36, 40, 42): Today in its morning, afternoon and evening
// states with Start → timer, the insight sheet and Reminders · N today ticked in place; My work's grouped list and right panel; Projects
// as a list and as folders with Info; a project with its journey and phase tree; the task sheet; New project and New task with quick-add
// parsing, opened through the + hook (window event pt:new). Light and dark at 1440, 1920 and on a 390 phone. Built frontend only; fictional
// fixtures; the only writes allowed are the ones each check makes.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/aura-briefing');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `90000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Ravi Menon', email: 'ravi@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: g(2), slug: 'northwind', name: 'Northwind', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 8 };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const wday = (n) => { const d = new Date(`${monday}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = (date, hh, mm) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`).toISOString();
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

const people = [['Ravi Menon', 1], ['Lena Park', 11], ['Ama Kofi', 12], ['Sofia Jensen', 13], ['Tom Nguyen', 14], ['Mei Chen', 15], ['Dev Okafor', 16], ['Priya Gupta', 17]];
const ref = (n) => { const p = people.find((x) => x[1] === n); return { id: g(n), name: p[0] }; };
const members = people.map(([name, n]) => ({ userId: g(n), displayName: name, email: `${name.split(' ')[0].toLowerCase()}@example.test`, role: n === 1 ? 'Owner' : 'Member', joinedAt: ago(900), jobRole: null, isActive: true }));

// Projects (the demo's eight, fictional).
const P = [['Atlas Payments', 'ATL', 1, 78, 'AtRisk', 2], ['Orbit Mobile', 'ORB', 11, 62, 'OnTrack', 2], ['Helix Data', 'HLX', 12, 41, 'OnTrack', 7], ['Terra Infra', 'TRA', 13, 93, 'OnTrack', 8],
  ['Beacon Support', 'BEA', 16, 88, 'OnTrack', 10], ['Nova Analytics', 'NOV', 12, 15, 'OnTrack', 12], ['Quill CMS', 'QL', 11, 54, 'OnTrack', 20], ['Lumen Web', 'LUM', 17, 30, 'OnTrack', 60]];
const projects = P.map(([name, key, owner, progress, health, due], i) => ({ id: g(100 + i), key, name, description: null, status: 'Active', priority: 'Medium', owner: ref(owner), teamId: null, teamName: null,
  startDate: day(-40), dueDate: day(due), progress, health, stats: { total: 20, done: Math.round(progress / 5), inProgress: 2, cancelled: 0, todo: 20 - Math.round(progress / 5) - 2, overdue: i === 2 || i === 6 ? 1 : 0 },
  memberCount: 4, version: 1, position: i, enforceDependencies: false, projectGroupId: g(90), projectGroupName: 'Delivery', projectType: 'NewProject', deliveryMethod: 'Hybrid', stageCount: 5, pendingSignOffs: 3, updatedAt: ago(i) }));
const atlas = projects[0];
const stages = ['Discovery', 'Design & architecture', 'Build core ledger', 'QA & hardening', 'Release 2.4 to production', 'Post-launch review'].map((name, i) => ({ id: g(200 + i), name, order: i,
  plannedStart: day(-40 + i * 8), plannedEnd: day(-32 + i * 8), actualStart: null, actualEnd: null, status: i < 3 ? 'Completed' : i === 3 ? 'InProgress' : 'NotStarted', effectiveStatus: i < 3 ? 'Completed' : i === 3 ? 'InProgress' : 'NotStarted',
  owner: ref(1), assignee: null, description: null, taskTotal: [0, 0, 2, 3, 3, 2][i], taskDone: [0, 0, 2, 0, 0, 0][i], locked: false, lockedBy: null, openIssues: 0, totalIssues: 0 }));
const statuses = [{ id: g(300), name: 'To do', category: 'Todo', color: '#8e8e93', order: 0 }, { id: g(301), name: 'In progress', category: 'Active', color: '#0a84ff', order: 1 }, { id: g(302), name: 'Done', category: 'Done', color: '#30b158', order: 2 }];
const task = (n, title, stage, owner, due, done = false, extra = {}) => ({ id: g(400 + n), projectId: atlas.id, projectKey: 'ATL', projectName: 'Atlas Payments', number: 480 + n, key: `ATL-${480 + n}`, title, description: null,
  statusId: done ? g(302) : g(301), statusName: done ? 'Done' : 'In progress', statusCategory: done ? 'Done' : 'Active', statusColor: '#0a84ff', priority: 'High', assignee: ref(owner), reporter: ref(1), startDate: day(-1), dueDate: due,
  estimatedHours: 0.83, actualHours: 0.2, position: n, parentTaskId: null, subtaskTotal: 0, subtaskDone: 0, commentCount: 2, labels: [], completedAt: done ? ago(30) : null, createdAt: ago(60), updatedAt: ago(1), version: 1,
  isOverdue: !done && due < today, milestoneId: null, milestoneName: null, dependsOnCount: 0, blocksCount: 1, isBlocked: false, sprintId: null, sprintName: null, checklistTotal: 4, checklistDone: 2, canEdit: true,
  stageId: g(200 + stage), stageName: stages[stage].name, ...extra });
const tasks = [task(8, 'Posting service split', 2, 1, day(-3), true), task(6, 'Idempotency keys', 2, 1, day(-2), true), task(2, 'Refund webhook retries', 3, 1, today), task(3, 'Staging API keys', 3, 13, day(-2)),
  task(4, 'Load test 2k tps', 3, 14, day(2)), task(10, 'Release checklist', 4, 15, day(3)), task(11, 'Rollback drill', 4, 14, day(2)), task(12, 'Status page notice', 4, 15, day(3)), task(20, 'Metrics review', 5, 1, day(10)), task(21, 'Retro with Contoso', 5, 11, day(13))];

// My work (work items).
const wi = (n, kind, key, title, pi, due, extra = {}) => ({ kind, id: g(500 + n), key, title, projectId: projects[pi].id, projectKey: projects[pi].key, projectName: projects[pi].name, status: 'In progress', category: 'Active', priority: 'High',
  dueDate: due, isOverdue: due < today, assignee: ref(1), typeName: null, updatedAt: ago(n), version: 1, completedAt: null, reporterId: g(1), dueTime: null, ...extra });
const mine = [wi(1, 'task', 'ATL-482', 'Refund webhook retries', 0, today, { dueTime: '15:00:00', id: tasks[2].id }), wi(2, 'task', 'ATL-490', 'Ledger migration notes', 0, day(2)), wi(3, 'task', 'ORB-211', 'Onboarding empty states', 1, today),
  wi(4, 'task', 'ORB-215', 'Push permission copy', 1, day(3)), wi(5, 'task', 'HLX-77', 'Backfill Oct partitions', 2, day(1)), wi(6, 'task', 'LUM-34', 'Pricing page copy review', 7, day(-1)), wi(7, 'task', 'BEA-96', 'SLA review deck', 4, day(9))];
const closed = [wi(20, 'task', 'ATL-488', 'Idempotency keys', 0, day(-1), { category: 'Done', status: 'Done', completedAt: at(wday(0), 15, 0) }), wi(21, 'task', 'ATL-471', 'Posting service split', 0, day(-1), { category: 'Done', status: 'Done', completedAt: at(wday(0), 11, 0) })];
const raised = [wi(30, 'task', 'ATL-495', 'Staging API keys', 0, day(-2), { assignee: ref(13) }), wi(31, 'task', 'ORB-220', 'Sign-off on empty-state copy', 1, day(2), { assignee: ref(12) })];

// The one timeline.
const tev = (o) => ({ end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false, priority: null, minutes: null, note: null, joinUrl: null, notes: false, userId: user.id, mode: null, running: false, ...o });
const meeting = (n, title, date, hh, mm, len, pi, join) => tev({ id: `meeting:${g(n)}:${date}`, type: 'meeting', title, start: at(date, hh, mm), end: new Date(Date.parse(at(date, hh, mm)) + len * 60e3).toISOString(), date,
  sourceType: 'projectMeeting', sourceId: g(n), projectId: pi == null ? null : projects[pi].id, projectName: pi == null ? null : projects[pi].name.split(' ')[0], joinUrl: join ? 'https://meet.example.test/abc' : null });
const timeline = (from, to, morning = false) => ({ from, to, timeZone: 'Asia/Kolkata', scope: 'me', generatedAt: new Date().toISOString(), events: [
  meeting(600, 'Standup', today, 9, 30, 15, 0), meeting(601, 'Design review', today, 14, 0, 45, 1, true), meeting(602, '1:1 with Lena', today, 16, 30, 30, null), meeting(603, 'Contoso sync', today, 17, 0, 30, 4),
  meeting(604, 'Release sync', day(1), 15, 30, 30, 0, true),
  ...(morning ? [] : [tev({ id: 'time:1', type: 'time', title: 'Ledger refactor', start: at(today, 10, 0), end: at(today, 12, 0), date: today, sourceType: 'timeEntry', sourceId: g(700), minutes: 120 })]),
  ...mine.map((w) => tev({ id: `due:task:${w.id}`, type: 'due', title: w.title, key: w.key, allDay: true, start: at(w.dueDate, 0, 0), date: w.dueDate, sourceType: 'task', sourceId: w.id, projectId: w.projectId, projectName: w.projectName, status: 'In progress', priority: 'High' })),
].filter((t) => t.date >= from && t.date <= to) });
const reminders = { open: [
  { id: g(800), source: 'Personal', state: 'Scheduled', title: 'Call Sofia about staging keys', nextFireAt: at(today, 10, 0), from: null, targetKey: 'ATL-495', lastFiredAt: null },
  { id: g(801), source: 'Nudge', state: 'Scheduled', title: 'Send Contoso the fix date', nextFireAt: at(today, 14, 30), from: ref(11), lastFiredAt: null },
  { id: g(802), source: 'Meeting', state: 'Scheduled', title: 'Prep for Design review', nextFireAt: at(today, 13, 50), from: null, lastFiredAt: null },
], completed: [], sent: [], counts: { now: 0, today: 5, upcoming: 2, completed: 0 }, limits: { open: 100, recurring: 10, openUsed: 3, recurringUsed: 0 } };
const inbox = { rows: [
  { id: 'ticket:1', kind: 'ticket', group: 'assigned', title: 'Contoso SSO reply', sub: 'Sam Lee · SLA 1h 12m', action: { label: 'Open', verb: 'open', endpoint: null }, href: `/work?item=${g(501)}`, at: ago(3), urgent: true },
  { id: 'mention:1', kind: 'mention', group: 'mentions', title: 'Ama Kofi: confirm empty-state copy', sub: 'Mention in Onboarding spec', action: { label: 'Reply', verb: 'open', endpoint: null }, href: '/messages', at: ago(0.2), urgent: false },
], counts: { all: 2, assigned: 1, decisions: 0, mentions: 1 }, later: 0 };
const briefing = { count: 2, headline: '2 things need you.', reasons: ['Contoso has waited 3 hours.'], sources: 'read your work', stats: { overdue: 1, dueToday: 2, decisions: 0, approvals: 0, mentions: 1, reminders: 3 } };
const attendance = (state) => ({ date: today, timeZone: 'Asia/Kolkata', localTime: '13:52', workStart: '09:00', workEnd: '18:00', workingDay: true, onLeave: false, holiday: null, shouldPrompt: false,
  record: state === 'morning' ? null : { id: g(900), userId: g(1), userName: 'Ravi Menon', date: today, checkInAt: at(today, 9, 10), checkOutAt: state === 'evening' ? at(today, 17, 50) : null, mode: 'Office', place: null, note: null, source: 'web', autoClosed: false, minutes: 270, checkInLocal: '09:10', checkOutLocal: null },
  recentPlaces: [], canViewTeam: true, policy: { enabled: true, hoursSource: 'workspace', workDays: '1,2,3,4,5', workStart: '09:00', workEnd: '18:00', checkInGraceMinutes: 15, checkOutGraceMinutes: 15, autoClose: false, autoCloseAfterHours: 12, allowedModes: ['Office', 'Home', 'ClientSite'], requireClientPlace: false, promptAtSignIn: false, timeZone: 'Asia/Kolkata' } });
const dashboard = { counts: { myDueToday: 2, myCompletedToday: 1, myOpen: 7, myOverdue: 1, activeProjects: 8, completedProjects: 0, totalProjects: 8, openTasks: 40, overdueTasks: 3, members: 8, overallProgress: 58, myLoggedMinutesThisWeek: 600 }, myTasks: [], projects: [], activity: [], myWork: [] };
const activity = { items: [['Mei Chen', 'Mei added the release checklist', 0.2], ['Ravi Menon', 'Ravi finished idempotency keys', 1], ['Tom Nguyen', 'Tom booked the load test', 3]].map(([n, s, h], i) => ({ id: g(950 + i), action: 'x', entityType: 'Task', entityId: null, summary: s, actor: { id: g(1), name: n }, projectId: atlas.id, createdAt: ago(h) })), page: 1, pageSize: 20, totalItems: 3, totalPages: 1 };
const templates = [{ key: 'blank', name: 'Blank', description: 'Start with an empty plan', isDefault: false, stages: ['Plan'] }, { key: 'release', name: 'Software release', description: '', isDefault: true, stages: ['Discovery', 'Build', 'QA', 'Release'] }, { key: 'onboard', name: 'Client onboarding', description: '', isDefault: false, stages: ['Kickoff', 'Setup', 'Training', 'Go-live'] }];
const docs = { items: [{ id: g(960), key: 'DOC-1', number: 1, title: 'Atlas payments spec', typeId: g(961), typeCode: 'TECH', typeName: 'Spec', typeColor: '#3b82f6', typeIcon: 'note', projectId: atlas.id, projectKey: 'ATL', projectName: 'Atlas Payments', teamId: null, teamName: null, owner: ref(1), status: 'Published', visibility: 'Project', classification: 'Internal', tags: [], updatedAt: ago(2), createdAt: ago(100), linkedCount: 1, versionLabel: 'v12', sharedCount: 0 }], nextCursor: null, total: 8 };


// ---- Aura fixtures (fictional)
const act = (verb, label, href, endpoint = null, body = null, targetId = null) => ({ verb, label, href, endpoint, body, targetId });
const auraBrief = (opts) => ({ day: today, timeZone: 'Asia/Kolkata', headline: '3 things need you today', line: 'Start with Sofia’s production access. 2 items are at risk.', ai: false,
  needsYou: [
    { id: `approval:${g(1001)}`, kind: 'approval', title: 'Production read access for Sofia', why: 'Sofia asked yesterday · Needs it for the staging key rotation.', projectName: null, projectId: null, tone: 'orange', evidence: null,
      action: act('approve', 'Approve', `/approvals?open=${g(1001)}`, `/api/v1/approvals/${g(1001)}/decide`, { action: 'approve' }, g(1001)) },
    { id: `review:${g(1002)}`, kind: 'review', title: 'Approve the minutes of Design review', why: '4 items drafted from the meeting, waiting for you.', projectName: 'Orbit Mobile', projectId: projects[1].id, tone: 'neutral', evidence: null,
      action: act('review', 'Review', `/?aura=review&run=${g(1002)}`, null, null, g(1002)) },
    { id: `task:${tasks[2].id}`, kind: 'unblock', title: 'ATL-482 Refund webhook retries', why: '2 tasks wait on it (ATL-490, ATL-491) · Mei and Tom are blocked.', projectName: 'Atlas Payments', projectId: atlas.id, tone: 'orange', evidence: null,
      action: act('open', 'Open', `/work?item=${tasks[2].id}`, null, null, tasks[2].id) },
  ], moreNeedsYou: 2,
  atRisk: [
    { id: `risk:${tasks[4].id}`, kind: 'dependency', title: 'ATL-484 Load test 2k tps · Tom', why: 'Waits on ATL-495 “Staging API keys”, 2d overdue.', projectName: 'Atlas Payments', projectId: atlas.id, tone: 'red', evidence: [],
      action: act('open', 'Open ATL-495', `/work?item=${tasks[3].id}`, null, null, tasks[3].id) },
    { id: `risk:${tasks[3].id}`, kind: 'owner', title: 'ATL-483 Staging API keys · Sofia', why: '2 days overdue · Sofia has 3 overdue.', projectName: 'Atlas Payments', projectId: atlas.id, tone: 'red', evidence: [],
      action: act('reassign', 'Reassign', `/work?item=${tasks[3].id}&field=assignee`, null, null, tasks[3].id) },
  ],
  meetings: [
    { id: 'm1', title: 'Design review', start: at(today, 14, 0), end: at(today, 14, 45), projectName: 'Orbit', projectId: projects[1].id, joinUrl: 'https://meet.example.test/abc', link: '/meetings', openQuestions: ['Who signs off the empty-state copy?', 'Dark icons by Friday?'], action: act('join', 'Join', 'https://meet.example.test/abc') },
    { id: 'm2', title: 'Contoso sync', start: at(today, 17, 0), end: at(today, 17, 30), projectName: 'Beacon', projectId: projects[4].id, joinUrl: null, link: '/meetings', openQuestions: [], action: act('open', 'Open', '/meetings') },
  ],
  fridayReport: !!opts.friday, generatedAt: at(today, 8, 2), refreshedAt: new Date().toISOString() });
const answer = { question: 'Why is ATL-484 late?', ai: false, subject: 'ATL-484 Load test 2k tps', subjectHref: `/work?item=${tasks[4].id}`,
  answer: 'ATL-484 is not late yet: it is due in 2 days and is in progress. Its date moved once, from 2 Nov to 7 Nov; the reasons given: “Staging keys not issued”. It waits on ATL-495 “Staging API keys” (Sofia Jensen), still in progress, which is 2 days overdue.',
  evidence: [
    { kind: 'task', label: 'ATL-484 Load test 2k tps', detail: 'In progress · due 7 Nov', href: `/work?item=${tasks[4].id}`, at: null },
    { kind: 'date', label: '2 Nov → 7 Nov', detail: 'Staging keys not issued · Tom Nguyen', href: `/work?item=${tasks[4].id}`, at: ago(70) },
    { kind: 'dependency', label: 'ATL-495 Staging API keys', detail: 'In progress · due 3 Nov · Sofia Jensen', href: `/work?item=${tasks[3].id}`, at: null },
    { kind: 'comment', label: 'Waiting on the bank for the sandbox keys.', detail: 'Sofia Jensen', href: `/work?item=${tasks[3].id}`, at: ago(20) },
  ], suggestions: ['Ask Sofia for a new date', 'Why is ATL-495 late?'] };
const review = { runId: g(1002), projectId: projects[1].id, projectName: 'Orbit Mobile', title: 'Design review', held: at(today, 11, 0), summary: 'Empty states approved with two copy changes; push permission moves to onboarding step 3.',
  decisions: ['Push permission asked at onboarding step 3', 'Dark icons ship with 2.4'], questions: ['Who signs off the empty-state copy?'], pending: 4, canDecide: true,
  people: members.slice(0, 6).map((m) => ({ id: m.userId, name: m.displayName })),
  items: [
    { id: g(1101), kind: 'task', title: 'Update empty-state copy', detail: null, owner: ref(12), dueDate: day(2), status: 'proposed', appliedKey: null, evidence: 'Ama will update the copy by Thursday', approvable: true },
    { id: g(1102), kind: 'actionItem', title: 'Move push prompt to step 3', detail: null, owner: ref(11), dueDate: day(4), status: 'proposed', appliedKey: null, evidence: null, approvable: true },
    { id: g(1103), kind: 'task', title: 'Export dark icon set', detail: null, owner: null, dueDate: null, status: 'proposed', appliedKey: null, evidence: null, approvable: true },
  ] };
const friday = { from: day(-6), to: today, headline: '2 projects · 9 done · 2 slipped · 3 at risk', nextScheduledAt: at(today, 16, 0), timeZone: 'Asia/Kolkata', projects: [
  { projectId: atlas.id, key: 'ATL', name: 'Atlas Payments', health: 'At risk', progress: 78, done: 6, slipped: 2, risks: 2, next: 4, chat: true, href: `/work/projects/${atlas.id}/report`,
    text: '**Atlas Payments — week of 30 Oct to 5 Nov**\nStatus: **At risk** · 78% done · due 7 Nov\n\n**What moved**\n- ATL-488 Idempotency keys\n- ATL-471 Posting service split\n\n**What slipped, and why**\n- ATL-484: 2 Nov → 7 Nov — Staging keys not issued\n\n**Risks**\n- ATL-484 Load test 2k tps is waiting on ATL-495\n\n**Next week**\n- ATL-490 Release checklist · due 8 Nov · Mei Chen' },
  { projectId: projects[1].id, key: 'ORB', name: 'Orbit Mobile', health: 'On track', progress: 62, done: 3, slipped: 0, risks: 1, next: 2, chat: false, href: `/work/projects/${projects[1].id}/report`,
    text: '**Orbit Mobile — week of 30 Oct to 5 Nov**\nStatus: **On track** · 62% done\n\n**What moved**\n- ORB-209 Onboarding flow\n\n**What slipped, and why**\n- No dates moved.' },
] };

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const ALLOWED = [/^POST \/api\/v1\/approvals\/[^/]+\/decide$/, /^POST \/api\/v1\/aura\/ask$/, /^POST \/api\/v1\/aura\/meetings\/[^/]+\/review$/, /^POST \/api\/v1\/aura\/friday\/send$/, /^POST \/api\/v1\/tasks\/[^/]+\/timer\/start$/, /^POST \/api\/v1\/timer\/stop$/, /^POST \/api\/v1\/reminders\/[^/]+\/done$/, /^PATCH \/api\/v1\/work-items\/[^/]+$/, /^POST \/api\/v1\/work-items$/, /^POST \/api\/v1\/projects$/, /^PUT \/api\/v1\/tasks\/[^/]+\/checklist\/[^/]+$/, /^PATCH \/api\/v1\/tasks\/[^/]+\/move$/, /^POST \/api\/v1\/me\/attendance\/check-in$/, /^POST \/api\/v1\/tasks\/[^/]+\/checklist$/];
const make = async (theme, writes, opts = {}) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.clock.setFixedTime(new Date(at(today, opts.hh ?? 13, opts.mm ?? 52)));
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const w = `${method} ${ep}`;
      assert.ok(ALLOWED.some((re) => re.test(w)), `Unexpected write: ${w}`);
      writes.push({ w, body: req.postDataJSON?.() ?? null });
      let data = {};
      if (ep === '/api/v1/aura/ask') data = answer;
      if (ep.startsWith('/api/v1/aura/meetings/')) data = { approved: 3, dismissed: 1, failed: 0, created: ['ATL-499'] };
      if (ep === '/api/v1/aura/friday/send') data = { sent: 2, failed: [] };
      if (ep === '/api/v1/work-items') data = { ...mine[0], id: g(990), key: 'ATL-499', title: 'created', detail: null, activity: [] };
      if (ep === '/api/v1/projects') data = { project: { ...atlas, id: g(991) }, statuses, stages, members: [] };
      if (ep.includes('/checklist/')) data = { items: [{ id: g(970), title: 'Reproduce double refund', isDone: true, position: 0, completedAt: null }, { id: g(971), title: 'Add exponential backoff', isDone: true, position: 1, completedAt: null }, { id: g(972), title: 'Idempotency on retry', isDone: true, position: 2, completedAt: null }], total: 3, done: 3, progress: 100 };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
      return;
    }
    let data = [];
    const sp = url.searchParams;
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'projects.create', 'projects.edit', 'projects.delete', 'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.comment', 'org.manage', 'work.view', 'work.create', 'reports.view', 'reports.broad'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3, teams: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/timer') data = null;
    else if (ep === '/api/v1/aura/briefing') data = auraBrief(opts);
    else if (ep === '/api/v1/aura/meetings/review' || /^\/api\/v1\/aura\/meetings\/[^/]+\/review$/.test(ep)) data = review;
    else if (ep === '/api/v1/aura/friday') data = friday;
    else if (ep === '/api/v1/inbox') data = inbox;
    else if (ep === '/api/v1/inbox/briefing') data = briefing;
    else if (ep === '/api/v1/timeline') data = timeline(sp.get('from'), sp.get('to'), opts.state === 'morning');
    else if (ep === '/api/v1/calendar') data = [{ type: 'meeting', id: g(604), title: 'Release sync', date: day(1), status: 'Scheduled', category: null, overdue: false, projectId: atlas.id, projectName: 'Atlas', priority: null, startsAt: at(day(1), 15, 30), durationMinutes: 30, joinUrl: 'https://meet.example.test/abc', people: [] }];
    else if (ep === '/api/v1/reminders') data = reminders;
    else if (ep === '/api/v1/me/attendance/today') data = attendance(opts.state ?? 'afternoon');
    else if (ep === '/api/v1/dashboard') data = dashboard;
    else if (ep === '/api/v1/work-items') data = { items: sp.get('raisedByMe') === 'true' ? raised : sp.get('status') === 'closed' ? closed : mine, offset: 0, limit: 200, hasMore: false };
    else if (ep === '/api/v1/projects') data = { items: projects, page: 1, pageSize: 100, totalItems: projects.length, totalPages: 1 };
    else if (ep === '/api/v1/projects/timeline-templates') data = templates;
    else if (ep === '/api/v1/project-groups') data = [{ id: g(90), name: 'Other', description: null, order: 0, isActive: true, projectCount: 8, activeProjectCount: 8 }];
    else if (ep === '/api/v1/teams') data = [{ id: g(91), name: 'Data', description: null, memberCount: 4, projectCount: 2, lead: ref(12) }];
    else if (/^\/api\/v1\/projects\/[^/]+$/.test(ep)) { const p = projects.find((x) => ep.endsWith(x.id)) ?? atlas; data = { project: p, statuses, stages: p.id === atlas.id ? stages : [], members: members.slice(0, 5).map((m) => ({ userId: m.userId, name: m.displayName, email: m.email, role: m.role })) }; }
    else if (/^\/api\/v1\/projects\/[^/]+\/tasks$/.test(ep)) data = { items: ep.includes(atlas.id) ? tasks : [], page: 1, pageSize: 500, totalItems: tasks.length, totalPages: 1 };
    else if (/^\/api\/v1\/projects\/[^/]+\/activity$/.test(ep)) data = activity;
    else if (/^\/api\/v1\/projects\/[^/]+\/health$/.test(ep)) data = { health: 'AtRisk', byHand: false, note: null, until: null, reasons: [] };
    else if (/^\/api\/v1\/work-items\/[^/]+$/.test(ep)) { const t = tasks.find((x) => ep.endsWith(x.id)) ?? tasks[2]; data = { kind: 'task', id: t.id, key: t.key, title: t.title, description: 'Retries with backoff.', projectId: t.projectId, projectKey: 'ATL', projectName: 'Atlas Payments',
      status: t.statusName, category: t.statusCategory, priority: t.priority, startDate: t.startDate, dueDate: t.dueDate, isOverdue: t.isOverdue, assignee: t.assignee, reporter: t.reporter, version: 1, createdAt: t.createdAt, updatedAt: t.updatedAt, completedAt: null, loggedMinutes: 70,
      detail: { statusId: t.statusId }, activity: [{ type: 'comment', id: g(985), at: at(today, 11, 2), actor: ref(11), summary: 'commented', body: 'QA is ready to go as soon as this lands.' }] }; }
    else if (/^\/api\/v1\/tasks\/[^/]+$/.test(ep)) data = { task: tasks.find((t) => ep.endsWith(t.id)) ?? tasks[2], subtasks: [] };
    else if (/^\/api\/v1\/tasks\/[^/]+\/checklist$/.test(ep)) data = { items: [{ id: g(970), title: 'Reproduce double refund', isDone: true, position: 0, completedAt: null }, { id: g(971), title: 'Add exponential backoff', isDone: true, position: 1, completedAt: null }, { id: g(972), title: 'Idempotency on retry', isDone: false, position: 2, completedAt: null }], total: 3, done: 2, progress: 67 };
    else if (/^\/api\/v1\/tasks\/[^/]+\/dependencies$/.test(ep)) data = { blockedBy: [{ id: g(980), type: 'FinishToStart', satisfied: true, task: { id: g(406), key: 'ATL-486', title: 'Idempotency keys', category: 'Done', statusName: 'Done', dueDate: day(-2) } }], blocks: [{ id: g(981), type: 'FinishToStart', satisfied: false, task: { id: g(410), key: 'ATL-490', title: 'Release checklist', category: 'Active', statusName: 'In progress', dueDate: day(3) } }], enforced: true, blockedReason: null };
    else if (/^\/api\/v1\/tasks\/[^/]+\/comments$/.test(ep)) data = [{ id: g(985), taskId: tasks[2].id, author: ref(11), body: 'QA is ready to go as soon as this lands.', parentCommentId: null, createdAt: at(today, 11, 2), editedAt: null, canEdit: false, canDelete: false }, { id: g(986), taskId: tasks[2].id, author: ref(1), body: 'Backoff is in. Idempotency next.', parentCommentId: null, createdAt: at(today, 11, 20), editedAt: null, canEdit: true, canDelete: true }];
    else if (/^\/api\/v1\/tasks\/[^/]+\/time$/.test(ep)) data = { entries: [], totalMinutes: 70, estimatedHours: 1.83, myTimer: null, billableByDefault: false };
    else if (ep === '/api/v1/documents') data = docs;
    else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
    else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/chat/projects/unread') data = [];
    else if (ep === '/api/v1/me/ui/pins' || ep.startsWith('/api/v1/me/ui/')) data = { value: null };
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name), animations: 'disabled' }); };
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};
/** Nothing of the page may sit under the floating + button (bottom-right) unless it scrolls clear. */
const noOverlapX = async (page, what) => {
  const bad = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.calm-split *')].filter((e) => getComputedStyle(e).position !== 'fixed');
    const overflow = els.filter((e) => e.scrollWidth > e.clientWidth + 2 && ['hidden', 'clip'].includes(getComputedStyle(e).overflowX) && !getComputedStyle(e).textOverflow.includes('ellipsis') && e.children.length > 0 && !e.closest('.calm-journey, .calm-day-track, .calm-pills, .calm-bar'));
    return overflow.slice(0, 5).map((e) => `${e.tagName}.${e.className}`);
  });
  assert.deepEqual(bad, [], `${what}: content clipped`);
};


try {
  for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 390, 844], ['dark', 390, 844]]) {
    const tag = `${width}${theme === 'dark' ? '-dark' : ''}`;
    const phone = width < 500;
    const writes = [];
    const ctx = await make(theme, writes, { friday: true });
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width, height });

    // ---- the briefing is Today's hero
    await page.goto(`${origin}/northwind/`);
    const brief = page.getByTestId('aura-briefing');
    await brief.getByRole('heading', { name: '3 things need you today' }).waitFor();
    await brief.getByText('Production read access for Sofia').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Do this now' }).count(), 0, 'the briefing replaces the task hero');
    await page.getByRole('region', { name: 'At risk' }).getByText('Waits on ATL-495').waitFor();
    await page.getByRole('region', { name: 'Your meetings today' }).getByText(/Who signs off the empty-state copy\?/).waitFor();
    await brief.getByTestId('aura-friday-chip').waitFor();
    if (phone) await fitsPhone(page, `briefing ${tag}`, assert); else await noOverlapX(page, `briefing ${tag}`);
    await shot(page, `briefing-${tag}.png`);

    // ---- Approve in place: one tap, optimistic
    await brief.getByRole('button', { name: 'Approve', exact: true }).click();
    await brief.getByText('✓ Approved').waitFor();
    assert.ok(writes.some((x) => x.w === `POST /api/v1/approvals/${g(1001)}/decide` && x.body?.action === 'approve'), 'Approve decides the approval');

    // ---- Ask anything: why is it late, with evidence
    await page.getByRole('region', { name: 'At risk' }).getByRole('button', { name: 'Why?' }).first().click();
    const ask = page.getByTestId('aura-ask-sheet');
    await ask.getByTestId('aura-answer').getByText(/waits on ATL-495/i).waitFor();
    await ask.getByRole('link', { name: 'ATL-495 Staging API keys' }).waitFor();
    await ask.getByText('Date change').waitFor();
    assert.ok(writes.some((x) => x.w === 'POST /api/v1/aura/ask' && x.body?.taskId === tasks[4].id), 'Why? asks about that task');
    if (phone) await fitsPhone(page, `ask ${tag}`, assert);
    await shot(page, `ask-${tag}.png`);
    await page.keyboard.press('Escape');
    await ask.waitFor({ state: 'detached' });

    // ---- After the meeting: Review & approve (approve all, one edit, one left out)
    await brief.getByRole('button', { name: 'Review', exact: true }).click();
    const rev = page.getByTestId('aura-review-sheet');
    await rev.getByText('Push permission asked at onboarding step 3').waitFor();
    await rev.getByText('Update empty-state copy').waitFor();
    if (phone) await fitsPhone(page, `review ${tag}`, assert);
    await shot(page, `review-${tag}.png`);
    if (theme === 'light') {
      await rev.getByRole('button', { name: 'Leave out: Export dark icon set' }).click();
      await rev.getByRole('button', { name: 'Edit' }).first().click();
      await rev.getByLabel('Title').fill('Update empty-state copy (v2)');
      await rev.getByRole('button', { name: 'Approve 2' }).first().click();
      await rev.waitFor({ state: 'detached' });
      const w = writes.find((x) => x.w === `POST /api/v1/aura/meetings/${g(1002)}/review`);
      assert.ok(w, 'approving posts the review');
      assert.equal(w.body.items.find((i) => i.id === g(1103)).approve, false);
      assert.equal(w.body.items.find((i) => i.id === g(1101)).title, 'Update empty-state copy (v2)');
      checks.push(`${tag}: review & approve with one edit and one left out`);
    } else { await page.keyboard.press('Escape'); await rev.waitFor({ state: 'detached' }); }

    // ---- Friday report: preview, edit, Send
    await brief.getByTestId('aura-friday-chip').click();
    const fri = page.getByTestId('aura-friday-sheet');
    await fri.getByText('What slipped, and why').first().waitFor();
    await fri.getByText(/to the team by e-mail/).waitFor();
    if (phone) await fitsPhone(page, `friday ${tag}`, assert);
    await shot(page, `friday-${tag}.png`);
    if (theme === 'light') {
      await fri.getByRole('button', { name: 'Edit' }).first().click();
      await fri.getByLabel('Atlas Payments report').fill('**Atlas Payments** — keys landed, load test Monday.');
      await page.getByRole('button', { name: 'Send 2' }).first().click();
      await fri.waitFor({ state: 'detached' });
      const w = writes.find((x) => x.w === 'POST /api/v1/aura/friday/send');
      assert.equal(w.body.projects.length, 2);
      assert.match(w.body.projects[0].text, /keys landed/);
      checks.push(`${tag}: Friday report edited and sent`);
    }

    // ---- a notice deep link opens the review sheet straight away
    await page.goto(`${origin}/northwind/?aura=review&run=${g(1002)}`);
    await page.getByTestId('aura-review-sheet').getByText('Update empty-state copy').waitFor();
    await ctx.close();
    checks.push(`${tag}: briefing hero, Approve in place, Why? with evidence, review sheet, Friday sheet, deep link`);
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log(`aura briefing UI: ${checks.length} checks passed\n- ${checks.join('\n- ')}`);
} finally { await browser.close(); }
