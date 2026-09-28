#!/usr/bin/env node
/**
 * Creates a sample organization ("Acme Software Pvt Ltd") with users of every role, an org chart, teams, projects on different
 * timelines, tasks, subtasks, checklists, comments, dependencies, milestones, a sprint, time entries, custom fields,
 * automation and chat, so the whole application can be tested with different access levels.
 *
 * Everything goes through the real HTTP API (so the app's own rules apply). Run it against an API that does NOT send email
 * (Email__Provider=Log) - see README.md in this folder for the exact command, including the one SQL statement that puts the
 * new joiner back into "must choose a new password" state. It refuses to run twice.
 *
 *   API=http://localhost:18081 node seed-sample-org.mjs
 */
const API = (process.env.API ?? 'http://localhost:18081').replace(/\/$/, '');
const DOMAIN = 'acme-sample.test';            // reserved TLD: can never receive real mail
const PASSWORD = 'Acme@Test2026!';            // every sample account signs in with this
const ORG_NAME = 'Acme Software Pvt Ltd';

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const log = (...a) => console.log(...a);

async function raw(method, path, { token, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Token-Delivery': 'body', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 8) { await sleep((Number(res.headers.get('retry-after')) || 5) * 1000 + 500); continue; }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.status < 400, data: json?.data ?? null, message: json?.errors?.[0]?.message ?? json?.message ?? text.slice(0, 200), code: json?.errors?.[0]?.code };
  }
}

class Client {
  constructor(person) { this.person = person; this.password = PASSWORD; this.workspaceId = null; this.token = null; }
  get id() { return this.userId; }
  async login(password = this.password) {
    const r = await raw('POST', '/auth/login', { body: { email: this.person.email, password } });
    if (!r.ok) throw new Error(`login ${this.person.email}: ${r.message}`);
    this.token = r.data.accessToken; this.userId = r.data.user.id; this.password = password;
    if (this.workspaceId) await this.switchTo(this.workspaceId);
  }
  async switchTo(id) { const r = await raw('POST', `/workspaces/${id}/switch`, { token: this.token, body: {} }); if (!r.ok) throw new Error(`switch: ${r.message}`); this.token = r.data.accessToken; this.workspaceId = id; }
  /** Calls the API as this person; signs in again once if the access token has expired. */
  async call(method, path, body) {
    let r = await raw(method, path, { token: this.token, body });
    if (r.status === 401) { await this.login(); r = await raw(method, path, { token: this.token, body }); }
    return r;
  }
  /** Like call, but a refusal is fatal. */
  async must(method, path, body) { const r = await this.call(method, path, body); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.message}`); return r.data; }
  /** Like call, but a refusal is only logged (used for optional extras). */
  async try(method, path, body, what = '') { const r = await this.call(method, path, body); if (!r.ok) log(`   ! ${what || `${method} ${path}`}: ${r.message}`); return r.ok ? r.data : null; }
}

const pick = (data, name) => (Array.isArray(data) ? data.find((x) => x.name === name) : data);

// ------------------------------------------------------------------ the people
const PEOPLE = [
  { key: 'arjun', local: 'owner', name: 'Arjun Mehta', role: 'Owner', job: 'CTO' },
  { key: 'divya', local: 'admin', name: 'Divya Krishnan', role: 'Admin', job: 'Principal Manager', boss: 'arjun' },
  { key: 'rahul', local: 'manager.delivery', name: 'Rahul Verma', role: 'Manager', job: 'Delivery Manager', boss: 'divya' },
  { key: 'sneha', local: 'manager.product', name: 'Sneha Iyer', role: 'Manager', job: 'Product Manager', boss: 'divya' },
  { key: 'karthik', local: 'lead', name: 'Karthik Raman', role: 'Member', job: 'Project Lead', boss: 'rahul' },
  { key: 'meera', local: 'dev.frontend', name: 'Meera Nair', role: 'Member', job: 'Developer', boss: 'karthik' },
  { key: 'vikram', local: 'dev.backend', name: 'Vikram Singh', role: 'Member', job: 'Developer', boss: 'karthik' },
  { key: 'lakshmi', local: 'devops', name: 'Lakshmi Menon', role: 'Member', job: 'Developer', boss: 'karthik' },
  { key: 'ananya', local: 'qa', name: 'Ananya Das', role: 'Member', job: 'Tester (QA)', boss: 'karthik' },
  { key: 'rohan', local: 'designer', name: 'Rohan Gupta', role: 'Member', job: 'Business Analyst', boss: 'sneha' },
  { key: 'pooja', local: 'newjoiner', name: 'Pooja Patel', role: 'Member' },
  { key: 'sanjay', local: 'client', name: 'Sanjay Kapoor', role: 'Guest' },
];
for (const p of PEOPLE) p.email = `${p.local}@${DOMAIN}`;
const U = {}; // key -> Client

async function acceptTerms(c) {
  const st = await c.call('GET', '/consent/status');
  if (st.ok && !st.data.upToDate) await c.call('POST', '/consent/accept', { types: st.data.pending.map((d) => d.type) });
}

async function silenceEmail(c) {
  // Sample accounts must never trigger real email: switch every optional email notification off straight away.
  const prefs = await c.call('GET', '/me/notification-preferences');
  if (!prefs.ok) return;
  await c.call('PUT', '/me/notification-preferences', { items: prefs.data.map((p) => ({ type: p.type, inApp: p.inApp, email: p.locked ? p.email : false, browser: p.browser })) });
}

// ------------------------------------------------------------------ 1. organization, plan, org chart, users
async function createOrganizationAndPeople() {
  const owner = PEOPLE[0];
  const reg = await raw('POST', '/auth/register', { body: { email: owner.email, password: PASSWORD, displayName: owner.name, acceptedTerms: true } });
  if (reg.status === 409) throw new Error(`${owner.email} already exists - the sample organization has been created before. Delete it (or use a fresh database) to run again.`);
  if (!reg.ok) throw new Error(`register owner: ${reg.message}`);
  U.arjun = new Client(owner); await U.arjun.login();
  const org = await U.arjun.must('POST', '/workspaces', { name: ORG_NAME, description: 'Sample organization for testing every role, workflow and screen.' });
  await U.arjun.switchTo(org.id);
  await silenceEmail(U.arjun);
  await U.arjun.must('POST', '/billing/checkout', { planCode: 'BUSINESS', startTrial: false });
  log(`Organization "${ORG_NAME}" created on the Business plan.`);

  await U.arjun.must('POST', '/org/template', { template: 'software' });
  const chart = await U.arjun.must('GET', '/org');
  const jobs = Object.fromEntries(chart.roles.map((r) => [r.name, r.id]));
  await U.arjun.must('PUT', `/org/members/${U.arjun.id}/role`, { roleId: jobs.CTO });

  for (const p of PEOPLE.slice(1)) {
    const temp = 'Tmp#Seed2026x';
    await U.arjun.must('POST', '/workspace/members', {
      email: p.email, displayName: p.name, role: p.role, password: temp,
      orgRoleId: p.job ? jobs[p.job] : null, reportsToUserId: p.boss ? U[p.boss].id : null,
    });
    const c = new Client(p); U[p.key] = c;
    await c.login(temp);                       // a single membership, so this lands in the organization
    await acceptTerms(c);                      // published terms come first, then the forced password change
    await c.must('POST', '/me/password', { currentPassword: temp, newPassword: PASSWORD });
    c.password = PASSWORD; c.workspaceId = org.id;
    await silenceEmail(c);
    log(`  user ${p.email.padEnd(34)} ${p.role.padEnd(8)} ${p.job ?? ''}`);
  }
  U.arjun.workspaceId = org.id;
  return org;
}

// ------------------------------------------------------------------ 2. teams and labels
async function teamsAndLabels() {
  const eng = (await U.arjun.must('POST', '/teams', { name: 'Engineering', description: 'Builds and ships the products.' })).team;
  const prod = (await U.arjun.must('POST', '/teams', { name: 'Product & Design', description: 'Product management, design and marketing.' })).team;
  const add = (team, key, lead = false) => U.arjun.try('POST', `/teams/${team.id}/members`, { userId: U[key].id, isLead: lead }, `team member ${key}`);
  await add(eng, 'rahul', true); for (const k of ['karthik', 'meera', 'vikram', 'lakshmi', 'ananya']) await add(eng, k);
  await add(prod, 'sneha', true); for (const k of ['rohan', 'pooja']) await add(prod, k);
  const labels = {};
  for (const [name, color] of [['Bug', '#ef4444'], ['Feature', '#8b5cf6'], ['Frontend', '#38bdf8'], ['Backend', '#f97316'], ['Security', '#fb7185'], ['Design', '#c084fc'], ['Urgent', '#dc2626'], ['Documentation', '#94a3b8'], ['Marketing', '#34d399']]) {
    const l = await U.arjun.try('POST', '/labels', { name, color }, `label ${name}`); if (l) labels[name] = l.id;
  }
  // Project groups: the workspace already has "Other Projects"; add the rest of the master list.
  const groups = Object.fromEntries((await U.arjun.must('GET', '/project-groups')).map((g) => [g.name, g.id]));
  for (const name of ['Salesforce Projects', 'Employee Portal', 'Data Team', 'Payment Engine', 'HRMS', 'Mobile Applications']) {
    const g = await U.arjun.try('POST', '/project-groups', { name }, `project group ${name}`); if (g) groups[name] = g.id;
  }
  return { eng, prod, labels, groups };
}

// ------------------------------------------------------------------ 3. projects & tasks
const PRIORITY = { L: 'Low', M: 'Medium', H: 'High', C: 'Critical' };

/** What each sample project is for (the project type is required when a project is created). */
const TYPE_BY_KEY = { CPR: 'Enhancement', MOB: 'NewProject', PAY: 'Upgrade', MKT: 'Other', WEB: 'Enhancement', RET: 'Integration', OFC: 'Other', SFC: 'Integration' };

async function makeProject(by, spec, ctx) {
  const d = await by.must('POST', '/projects', {
    name: spec.name, key: spec.key, description: spec.description, priority: spec.priority ?? 'Medium', status: spec.status ?? 'Active',
    ownerId: U[spec.owner].id, teamId: spec.team ? ctx[spec.team].id : null, startDate: iso(spec.start), dueDate: iso(spec.due),
    memberIds: spec.members.map((k) => U[k].id), timelineTemplate: spec.timeline ?? 'software', projectGroupId: ctx.groups[spec.group ?? 'Other Projects'],
    projectType: spec.type ?? TYPE_BY_KEY[spec.key] ?? 'NewProject',
  });
  const statuses = Object.fromEntries(d.statuses.map((s) => [s.name, s.id]));
  const stages = Object.fromEntries(d.stages.map((s) => [s.name, s.id]));
  log(`  project ${spec.key.padEnd(4)} ${spec.name} (${spec.timeline ?? 'software'} timeline)`);
  return { id: d.project.id, by, statuses, stages, ctx, tasks: {} };
}

/** Creates a task in a stage, then moves it to the wanted status (stages unlock in order as their tasks are completed). */
async function task(p, title, o = {}) {
  const body = {
    title, description: o.desc, priority: PRIORITY[o.pri ?? 'M'], assigneeId: o.who ? U[o.who].id : null,
    startDate: o.start !== undefined ? iso(o.start) : null, dueDate: o.due !== undefined ? iso(o.due) : null, estimatedHours: o.est ?? null,
    labelIds: (o.labels ?? []).map((l) => p.ctx.labels[l]).filter(Boolean), stageId: o.parent ? undefined : p.stages[o.stage], parentTaskId: o.parent?.id ?? null,
    milestoneId: o.milestone?.id ?? null,
  };
  const t = await p.by.try('POST', `/projects/${p.id}/tasks`, body, `task "${title}"`);
  if (!t) return null;
  for (const status of o.path ?? (o.status && o.status !== 'Yet To Start' ? [o.status] : [])) {
    await p.by.try('PATCH', `/tasks/${t.id}/move`, { statusId: p.statuses[status] }, `move "${title}" to ${status}`);
  }
  for (const [i, item] of (o.checklist ?? []).entries()) {
    const done = i < (o.checked ?? 0);
    const list = await p.by.try('POST', `/tasks/${t.id}/checklist`, { title: item }, `checklist "${item}"`);
    if (done && list) await p.by.try('PUT', `/tasks/${t.id}/checklist/${list.items.at(-1).id}`, { isDone: true });
  }
  p.tasks[title] = { ...t, who: o.who };
  return t;
}
/** Moves a task's due date, saying why (a later date needs a reason): this is what the Project Status page shows as a delivery change. */
async function reschedule(c, t, offset, reason, dependency) {
  if (!t) return;
  const k = (await c.must('GET', `/tasks/${t.id}`)).task;
  await c.try('PUT', `/tasks/${t.id}`, {
    title: k.title, description: k.description, statusId: k.statusId, priority: k.priority, assigneeId: k.assignee?.id ?? null, startDate: k.startDate, dueDate: iso(offset),
    estimatedHours: k.estimatedHours, actualHours: k.actualHours, labelIds: k.labels.map((l) => l.id), version: k.version, milestoneId: k.milestoneId, stageId: k.stageId,
    dueDateReason: reason, dueDateDependency: dependency,
  }, `new due date for "${k.title}"`);
}
async function rescheduleProject(c, p, offset, reason, dependency) {
  const q = (await c.must('GET', `/projects/${p.id}`)).project;
  await c.try('PUT', `/projects/${p.id}`, {
    name: q.name, description: q.description, priority: q.priority, status: q.status, ownerId: q.owner?.id, teamId: q.teamId, startDate: q.startDate, dueDate: iso(offset),
    version: q.version, projectGroupId: q.projectGroupId, dueDateReason: reason, dueDateDependency: dependency,
  }, `new due date for project ${q.name}`);
}
const done = { status: 'Done' };
const ip = { status: 'In Progress' };

async function comment(c, t, body, mention = []) { if (t) await c.try('POST', `/tasks/${t.id}/comments`, { body, mentionUserIds: mention.map((k) => U[k].id) }, 'comment'); }

async function logTime(p, t, who, minutes, daysAgo, note) { if (t) await U[who].try('POST', `/tasks/${t.id}/time`, { minutes, workDate: iso(-daysAgo), note }, `time on "${t.title}"`); }

async function buildProjects(ctx) {
  const R = U.rahul, S = U.sneha, D = U.divya;

  // ---------------- P1: Customer Portal Revamp (software timeline, well under way, most features in use)
  log('Projects:');
  const p1 = await makeProject(U.arjun, { name: 'Customer Portal Revamp', key: 'CPR', group: 'Employee Portal', owner: 'rahul', team: 'eng', priority: 'High', start: -20, due: 40,
    description: 'Rebuild the customer portal: SSO login, a new dashboard, notifications and role-based menus.', members: ['karthik', 'meera', 'vikram', 'lakshmi', 'ananya', 'rohan', 'sneha'] }, ctx);
  p1.by = R;
  const ms1 = pick(await R.try('POST', `/projects/${p1.id}/milestones`, { name: 'Design freeze', description: 'Wireframes and visual design approved.', startDate: iso(-20), dueDate: iso(-5), status: 'Completed', ownerId: U.rohan.id, sortOrder: 1 }), 'Design freeze');
  const ms2 = pick(await R.try('POST', `/projects/${p1.id}/milestones`, { name: 'Beta release', description: 'First customers get the new portal.', startDate: iso(-5), dueDate: iso(21), status: 'InProgress', ownerId: U.karthik.id, sortOrder: 2 }), 'Beta release');
  await R.try('POST', `/projects/${p1.id}/milestones`, { name: 'UAT sign-off', description: 'Business users accept the release.', startDate: iso(21), dueDate: iso(35), status: 'Pending', ownerId: U.sneha.id, sortOrder: 3 });

  const fs = await U.arjun.try('POST', '/custom-fields', { name: 'Story points', type: 'Number' });
  const fe = await U.arjun.try('POST', '/custom-fields', { name: 'Environment', type: 'Dropdown', options: ['Development', 'Staging', 'Production'] });
  await U.arjun.try('POST', '/custom-fields', { name: 'Needs client approval', type: 'Checkbox' });
  const sp = pick(fs, 'Story points'), env = pick(fe, 'Environment');

  await task(p1, 'Gather portal requirements from stakeholders', { stage: 'Requirements & Planning', who: 'sneha', pri: 'H', due: -16, est: 12, labels: ['Documentation'], ...done });
  await task(p1, 'Define user personas and journeys', { stage: 'Requirements & Planning', who: 'rohan', due: -14, est: 10, labels: ['Design'], ...done });
  await task(p1, 'Sign off scope and wireframes', { stage: 'Requirements & Planning', who: 'rahul', pri: 'H', due: -10, est: 4, milestone: ms1, ...done });

  const login = await task(p1, 'Build login and SSO API', { stage: 'Development', who: 'vikram', pri: 'C', due: -8, est: 16, labels: ['Backend', 'Security'], milestone: ms2, ...done,
    desc: 'OAuth2 / SAML login with refresh tokens and session limits.' });
  const screens = await task(p1, 'Login and SSO screens', { stage: 'Development', who: 'meera', pri: 'H', due: -4, est: 14, labels: ['Frontend', 'Feature'], milestone: ms2 });
  for (const s of ['Login form validation', 'SSO provider buttons', 'Forgot-password flow']) await task(p1, s, { parent: screens, who: 'meera', ...done });
  await p1.by.try('PATCH', `/tasks/${screens?.id}/move`, { statusId: p1.statuses.Done }, 'finish login screens');

  const dash = await task(p1, 'Dashboard UI', { stage: 'Development', who: 'meera', pri: 'H', due: 5, est: 24, labels: ['Frontend', 'Feature'], milestone: ms2, ...ip,
    desc: 'KPI cards, progress charts and the activity feed.', checklist: ['Design tokens applied', 'Responsive on tablet', 'Dark mode checked', 'Accessibility pass'], checked: 2 });
  await task(p1, 'KPI cards', { parent: dash, who: 'meera', ...done });
  await task(p1, 'Charts and trends', { parent: dash, who: 'meera', ...ip });
  await task(p1, 'Empty and loading states', { parent: dash, who: 'meera' });
  const api = await task(p1, 'Dashboard API endpoints', { stage: 'Development', who: 'vikram', pri: 'H', due: 2, est: 16, labels: ['Backend'], milestone: ms2, status: 'Review' });
  await task(p1, 'Role-based menus', { stage: 'Development', who: 'karthik', due: 6, est: 10, labels: ['Feature', 'Security'], ...ip });
  await task(p1, 'Fix: session expires too early', { stage: 'Development', who: 'vikram', pri: 'C', due: -1, est: 4, labels: ['Bug', 'Urgent'], ...ip, desc: 'Users are signed out after 5 minutes of inactivity instead of 30.' });
  await task(p1, 'Notification centre', { stage: 'Development', who: 'meera', due: 12, est: 20, labels: ['Frontend', 'Feature'] });
  await task(p1, 'Audit log export', { stage: 'Development', who: 'vikram', pri: 'L', due: 20, est: 8, labels: ['Backend'] });
  await task(p1, 'Performance budget for the portal', { stage: 'Development', who: 'karthik', due: 15, est: 6, labels: ['Documentation'] });
  await task(p1, 'Review authentication pull requests', { stage: 'Code Review', who: 'karthik', pri: 'H', due: 8, est: 6, labels: ['Security'], ...ip });
  await task(p1, 'Security review of SSO', { stage: 'Code Review', who: 'lakshmi', pri: 'H', due: 10, est: 8, labels: ['Security'] });
  const e2e = await task(p1, 'Write end-to-end regression suite', { stage: 'Testing / QA', who: 'ananya', pri: 'H', due: 18, est: 24, labels: ['Feature'] });
  await task(p1, 'Cross-browser test matrix', { stage: 'Testing / QA', who: 'ananya', due: 20, est: 10 });
  await task(p1, 'Prepare UAT scripts', { stage: 'UAT', who: 'sneha', due: 26, est: 8, labels: ['Documentation'] });
  await task(p1, 'Blue/green deployment plan', { stage: 'Production Deployment', who: 'lakshmi', due: 34, est: 12 });

  if (e2e && dash) await R.try('POST', `/tasks/${e2e.id}/dependencies`, { dependsOnTaskId: dash.id, type: 'FinishToStart' }, 'dependency');
  if (dash && api) await R.try('POST', `/tasks/${dash.id}/dependencies`, { dependsOnTaskId: api.id, type: 'StartToStart' }, 'dependency');
  if (sp && env) for (const [t, pts, e] of [[login, '8', 'Production'], [dash, '13', 'Staging'], [api, '8', 'Development']]) if (t) await R.try('PUT', `/tasks/${t.id}/custom-fields`, { values: { [sp.id]: pts, [env.id]: e } }, 'custom field values');

  await comment(U.vikram, login, 'API is merged. Token refresh is behind a feature flag until QA signs off.', ['karthik']);
  await comment(U.karthik, login, 'Thanks Vikram. Please add rate limiting on the refresh endpoint before we ship.', ['vikram']);
  await comment(U.meera, dash, 'Charts are blocked on the trend endpoint - @Vikram can you expose 30-day data?', ['vikram']);
  await comment(U.sneha, dash, 'Product wants the KPI cards to link straight to the filtered project list.', ['meera']);
  await comment(R, p1.tasks['Fix: session expires too early'], 'This is hurting the pilot customers. Top priority today.', ['vikram']);
  await comment(U.ananya, e2e, 'I will start once the dashboard is stable. Test data is ready in staging.', ['karthik']);

  const s12 = pick(await R.try('POST', `/projects/${p1.id}/sprints`, { name: 'Sprint 12 - Login and Dashboard', goal: 'Finish login and get the dashboard to review.', startDate: iso(-7), endDate: iso(7) }), 'Sprint 12 - Login and Dashboard');
  await R.try('POST', `/projects/${p1.id}/sprints`, { name: 'Sprint 13 - Notifications', goal: 'Notification centre and menus.', startDate: iso(8), endDate: iso(21) });
  const inSprint = ['Dashboard UI', 'Dashboard API endpoints', 'Role-based menus', 'Fix: session expires too early'].map((n) => p1.tasks[n]?.id).filter(Boolean);
  if (s12 && inSprint.length) { await R.try('POST', `/projects/${p1.id}/sprints/${s12.id}/tasks`, { taskIds: inSprint }, 'plan sprint'); await R.try('POST', `/projects/${p1.id}/sprints/${s12.id}/start`, {}, 'start sprint'); }

  await R.try('POST', `/projects/${p1.id}/automations`, { name: 'Assign QA when a task reaches Testing', isEnabled: true, trigger: 'StatusChanged', whenStatusId: p1.statuses.Testing, action: 'SetAssignee', actionTarget: 'User', actionUserId: U.ananya.id }, 'automation');
  await R.try('POST', `/projects/${p1.id}/automations`, { name: 'New tasks in this project start as High priority', isEnabled: true, trigger: 'TaskCreated', action: 'SetPriority', actionPriority: 'High' }, 'automation');

  // ---------------- P2: Mobile App v2 (just started: Development is still locked behind Requirements & Planning)
  const p2 = await makeProject(S, { name: 'Mobile App v2', key: 'MOB', group: 'Mobile Applications', owner: 'sneha', team: 'prod', priority: 'High', start: -5, due: 75,
    description: 'A native mobile app for customers, starting with sign-in, projects and notifications.', members: ['karthik', 'meera', 'lakshmi', 'rohan', 'ananya'] }, ctx);
  await task(p2, 'Competitor app teardown', { stage: 'Requirements & Planning', who: 'rohan', due: -2, est: 8, labels: ['Design'], ...done });
  await task(p2, 'Define the MVP feature list', { stage: 'Requirements & Planning', who: 'sneha', pri: 'H', due: 3, est: 10, ...ip, checklist: ['Interview five customers', 'Rank features', 'Agree scope with engineering'], checked: 1 });
  await task(p2, 'Wireframes v1', { stage: 'Requirements & Planning', who: 'rohan', due: 6, est: 16, labels: ['Design'], ...ip });
  await task(p2, 'Decide the tech stack (React Native or Flutter)', { stage: 'Requirements & Planning', who: 'karthik', pri: 'H', due: 4, est: 6 });
  await task(p2, 'Set up the mobile CI pipeline', { stage: 'Development', who: 'lakshmi', due: 18, est: 12, labels: ['Feature'] });
  await task(p2, 'Sign-in and biometric screens', { stage: 'Development', who: 'meera', due: 25, est: 20, labels: ['Frontend', 'Feature'] });

  // ---------------- P3: Q4 Marketing Campaign (marketing timeline)
  const p3 = await makeProject(S, { name: 'Q4 Marketing Campaign', key: 'MKT', owner: 'sneha', team: 'prod', timeline: 'marketing', start: -10, due: 45,
    description: 'Autumn campaign: landing page, email sequence, social posts and a customer story.', members: ['rohan', 'pooja', 'ananya'] }, ctx);
  await task(p3, 'Write the campaign brief', { stage: 'Brief & Planning', who: 'sneha', pri: 'H', due: -7, est: 6, labels: ['Marketing', 'Documentation'], ...done });
  await task(p3, 'Audience research', { stage: 'Brief & Planning', who: 'rohan', due: -5, est: 10, labels: ['Marketing'], ...done });
  await task(p3, 'Landing page design', { stage: 'Content Creation', who: 'rohan', pri: 'H', due: 4, est: 16, labels: ['Design', 'Marketing'], ...ip });
  await task(p3, 'Email sequence copy (5 emails)', { stage: 'Content Creation', who: 'pooja', due: 6, est: 12, labels: ['Marketing'], ...ip });
  await task(p3, 'Social media calendar', { stage: 'Content Creation', who: 'pooja', pri: 'L', due: 9, est: 6, labels: ['Marketing'] });
  await task(p3, 'Demo video script', { stage: 'Content Creation', who: 'sneha', due: 8, est: 5, labels: ['Marketing'], status: 'Review' });
  await task(p3, 'Legal review of claims', { stage: 'Review & Approval', who: 'sneha', due: 14, est: 4 });
  await task(p3, 'Publish the campaign', { stage: 'Launch', who: 'pooja', pri: 'H', due: 21, est: 3, labels: ['Marketing'] });

  // ---------------- P4: Office Relocation (simple timeline, still in planning)
  const p4 = await makeProject(D, { name: 'Office Relocation 2026', key: 'OFC', owner: 'divya', timeline: 'simple', status: 'Planning', start: 10, due: 90,
    description: 'Move the team to a new office: space, furniture, IT and the move itself.', members: ['pooja', 'lakshmi'] }, ctx);
  await task(p4, 'Shortlist office spaces', { stage: 'Planning', who: 'divya', pri: 'H', due: 14, est: 10 });
  await task(p4, 'Collect furniture vendor quotes', { stage: 'Planning', who: 'pooja', due: 20, est: 8 });
  await task(p4, 'IT and network infrastructure plan', { stage: 'Planning', who: 'lakshmi', due: 24, est: 12 });
  await task(p4, 'Publish the move-in schedule', { stage: 'Execution', who: 'divya', due: 60, est: 4 });

  // ---------------- P5: Payments Gateway Upgrade (behind schedule: overdue tasks, delayed timeline)
  const p5 = await makeProject(R, { name: 'Payments Gateway Upgrade', key: 'PAY', group: 'Payment Engine', owner: 'rahul', team: 'eng', priority: 'Critical', start: -70, due: -7,
    description: 'Move to the new payment provider. Late: code review and load testing are still open.', members: ['karthik', 'vikram', 'lakshmi', 'ananya'] }, ctx);
  await task(p5, 'Vendor API assessment', { stage: 'Requirements & Planning', who: 'karthik', due: -60, est: 8, ...done });
  await task(p5, 'Integration design document', { stage: 'Requirements & Planning', who: 'vikram', due: -55, est: 12, labels: ['Documentation'], ...done });
  await task(p5, 'Implement the new payment client', { stage: 'Development', who: 'vikram', pri: 'C', due: -30, est: 30, labels: ['Backend'], ...done });
  await task(p5, 'Refund and chargeback flows', { stage: 'Development', who: 'vikram', pri: 'H', due: -22, est: 20, labels: ['Backend'], ...done });
  await task(p5, 'Webhook signature verification', { stage: 'Development', who: 'karthik', due: -18, est: 8, labels: ['Security'], ...done });
  await task(p5, 'Code review: idempotency keys', { stage: 'Code Review', who: 'karthik', pri: 'H', due: -10, est: 6, labels: ['Security', 'Urgent'], ...ip });
  await task(p5, 'Reconcile historical invoices', { stage: 'Code Review', who: 'vikram', due: -5, est: 14, labels: ['Backend'], ...ip });
  await task(p5, 'Load test at 10k transactions per second', { stage: 'Testing / QA', who: 'ananya', pri: 'H', due: -3, est: 16 });

  // ---------------- P6: Website Refresh (finished: every stage and task completed, project marked Completed)
  const p6 = await makeProject(R, { name: 'Website Refresh', key: 'WEB', owner: 'rahul', timeline: 'simple', start: -90, due: -30,
    description: 'The public marketing site, redesigned and migrated. Completed.', members: ['meera', 'rohan', 'ananya'] }, ctx);
  await task(p6, 'Audit the current website', { stage: 'Planning', who: 'meera', due: -80, est: 8, ...done });
  await task(p6, 'Content inventory', { stage: 'Planning', who: 'rohan', due: -78, est: 10, ...done });
  await task(p6, 'New homepage design', { stage: 'Execution', who: 'rohan', pri: 'H', due: -60, est: 24, labels: ['Design'], ...done });
  await task(p6, 'Implement the homepage', { stage: 'Execution', who: 'meera', pri: 'H', due: -50, est: 30, labels: ['Frontend'], ...done });
  await task(p6, 'Migrate blog posts', { stage: 'Execution', who: 'meera', due: -45, est: 12, ...done });
  await task(p6, 'Accessibility audit', { stage: 'Review', who: 'ananya', due: -38, est: 8, ...done });
  await task(p6, 'Stakeholder sign-off', { stage: 'Review', who: 'rahul', due: -32, est: 2, ...done });
  await R.try('PUT', `/projects/${p6.id}/stages/${p6.stages['Project Completed']}`, { name: 'Project Completed', status: 'Completed' }, 'complete final stage');
  await R.try('PATCH', `/projects/${p6.id}/move`, { status: 'Completed' }, 'mark project completed');

  // ---------------- P7: Retail Co Client Portal (a client - guest - can see only this project)
  const p7 = await makeProject(R, { name: 'Retail Co Client Portal', key: 'RET', group: 'Employee Portal', owner: 'rahul', team: 'eng', start: -30, due: 60,
    description: 'Delivery project shared with the client. Sanjay (guest) can follow progress here and nowhere else.', members: ['karthik', 'meera', 'sanjay'] }, ctx);
  await task(p7, 'Kick-off and requirements workshop', { stage: 'Requirements & Planning', who: 'rahul', due: -25, est: 6, ...done });
  await task(p7, 'Client branding assets', { stage: 'Requirements & Planning', who: 'meera', due: -20, est: 4, labels: ['Design'], ...done });
  await task(p7, 'Order tracking pages', { stage: 'Development', who: 'meera', pri: 'H', due: 10, est: 24, labels: ['Frontend', 'Feature'], ...ip });
  const inv = await task(p7, 'Invoice download', { stage: 'Development', who: 'karthik', due: 16, est: 12, labels: ['Feature'] });
  await task(p7, 'Client user management', { stage: 'Development', who: 'karthik', due: 24, est: 16 });
  await comment(U.sanjay, inv, 'Can invoices be downloaded as PDF and CSV? Our finance team needs both.', ['karthik']);
  await comment(U.karthik, inv, 'Yes - PDF and CSV are both planned. Added to the scope.', ['sanjay']);

  // ---------------- P8 / P9: small projects in other groups, so the Project Status page has several groups to open
  const p8 = await makeProject(D, { name: 'Salesforce Service Cloud Setup', key: 'SFC', group: 'Salesforce Projects', owner: 'sneha', timeline: 'simple', start: -25, due: 50,
    description: 'Roll Salesforce out to the sales and support teams.', members: ['rohan', 'pooja', 'rahul'] }, ctx);
  await task(p8, 'Requirements workshops with Sales', { stage: 'Planning', who: 'sneha', due: -15, est: 10, ...done });
  await task(p8, 'Configure objects, fields and page layouts', { stage: 'Execution', who: 'rohan', due: 12, est: 24, ...ip });
  await task(p8, 'Migrate accounts and contacts', { stage: 'Execution', who: 'pooja', due: 25, est: 18 });
  await task(p8, 'Train the sales team', { stage: 'Review', who: 'sneha', due: 45, est: 8 });
  const p9 = await makeProject(D, { name: 'Payroll Automation', key: 'HRM', group: 'HRMS', owner: 'divya', timeline: 'simple', start: -12, due: 70,
    description: 'Automate monthly payroll and the payslip hand-out.', members: ['sneha', 'karthik'] }, ctx);
  await task(p9, 'Map the payroll rules', { stage: 'Planning', who: 'divya', due: -4, est: 6, ...done });
  await task(p9, 'Build the payslip generator', { stage: 'Execution', who: 'karthik', due: 30, est: 20, ...ip });
  await task(p9, 'Parallel run for one month', { stage: 'Review', who: 'divya', due: 62, est: 12 });

  // ---------------- delivery date changes, with the reason and what they depended on
  await reschedule(R, p1.tasks['Dashboard UI'], 12, 'The design review asked for changes to the KPI cards', 'Stakeholder design sign-off');
  await reschedule(R, p1.tasks['Dashboard UI'], 18, 'The charting library licence is still waiting for approval', 'Charting library licence');
  await rescheduleProject(R, p1, 55, 'The Beta release moved after the SSO provider delay', 'SSO provider sandbox access');
  await reschedule(R, p5.tasks['Reconcile historical invoices'], 5, 'Finance has not yet supplied the March statements', 'Finance data export');
  const loadTest = p5.tasks['Load test at 10k transactions per second'];
  await reschedule(R, loadTest, 9, 'Cannot start until the invoices are reconciled', 'Reconcile historical invoices');
  if (loadTest && p5.tasks['Reconcile historical invoices']) await R.try('POST', `/tasks/${loadTest.id}/dependencies`, { dependsOnTaskId: p5.tasks['Reconcile historical invoices'].id, type: 'FinishToStart' }, 'load test depends on the reconciliation');
  await rescheduleProject(R, p5, 14, 'The payment vendor sandbox was unavailable for two weeks', 'Payment provider API access');
  await reschedule(R, p7.tasks['Order tracking pages'], 4, 'The client asked for an earlier demo', null);

  // ---------------- time entries for the last week (drives the timesheet, dashboard and reports)
  const week = [['vikram', 'Build login and SSO API'], ['vikram', 'Dashboard API endpoints'], ['meera', 'Dashboard UI'], ['meera', 'Login and SSO screens'], ['karthik', 'Role-based menus'],
    ['lakshmi', 'Security review of SSO'], ['ananya', 'Write end-to-end regression suite'], ['rohan', 'Landing page design'], ['pooja', 'Email sequence copy (5 emails)']];
  const all = { ...p1.tasks, ...p3.tasks };
  for (const [who, title] of week) for (const daysAgo of [1, 2, 3, 4, 6]) await logTime({}, all[title], who, [90, 150, 240, 120, 180][daysAgo % 5], daysAgo, ['Implementation', 'Pairing and review', 'Meetings and planning', 'Testing', 'Documentation'][daysAgo % 5]);
  return { p1, p2, p3, p4, p5, p6, p7, p8, p9 };
}

// ------------------------------------------------------------------ 4. chat
async function chat() {
  const all = ['karthik', 'meera', 'vikram', 'lakshmi', 'ananya'].map((k) => U[k].id);   // the creator (Rahul) is added automatically
  const eng = await U.rahul.try('POST', '/chat/conversations/group', { name: 'Engineering', memberIds: all }, 'engineering chat');
  const lead = await U.arjun.try('POST', '/chat/conversations/group', { name: 'Leadership', memberIds: ['divya', 'rahul', 'sneha'].map((k) => U[k].id) }, 'leadership chat');
  const say = async (conv, who, body) => { if (conv) await U[who].try('POST', `/chat/conversations/${conv.id}/messages`, { body }, 'chat message'); };
  await say(eng, 'rahul', 'Morning team. Sprint 12 review is on Friday - please update your task statuses before then.');
  await say(eng, 'karthik', 'Dashboard API is in review. Vikram, can you look at the pagination comment?');
  await say(eng, 'vikram', 'On it. I will push a fix within the hour.');
  await say(eng, 'ananya', 'Staging is ready for regression runs from tomorrow.');
  await say(lead, 'arjun', 'Payments Gateway Upgrade is late. Rahul, what do you need to get code review and load tests done this week?');
  await say(lead, 'rahul', 'Two more review days and one QA day. I have asked Ananya to book the load-test environment.');
  await say(lead, 'divya', 'I can approve the extra environment budget today.');
  const dm = await U.karthik.try('POST', '/chat/conversations/direct', { userId: U.meera.id }, 'direct chat');
  await say(dm, 'karthik', 'Nice work on the login screens. Can you demo the dashboard on Thursday?');
  await say(dm, 'meera', 'Sure! I will have the charts ready by then.');
}

// ------------------------------------------------------------------ run
const t0 = Date.now();
try {
  log(`Seeding ${ORG_NAME} through ${API} ...`);
  await createOrganizationAndPeople();
  const ctx = await teamsAndLabels();
  await buildProjects(ctx);
  await chat();
  log(`Done in ${Math.round((Date.now() - t0) / 1000)}s.`);
} catch (e) {
  console.error('\nSeeding stopped:', e.message);
  process.exit(1);
}
