#!/usr/bin/env node
/**
 * Adds a demo for the Project Status page to the sample organization ("Acme Software Pvt Ltd", see seed-sample-org.mjs):
 * three project groups - Salesforce Projects, Employee Portal and Data Team - holding ten projects with tasks, a completed
 * project, delayed deliveries with reasons and dependencies, tasks that are waiting on another task, and action items on several projects.
 *
 * Everything goes through the real HTTP API (so the app's own rules apply) as the sample users. The sample accounts have
 * their e-mail notifications switched off, so nothing is ever mailed. Running it again only adds action items to projects that have none.
 *
 *   API=http://localhost:8080 node seed-status-demo.mjs
 */
const API = (process.env.API ?? 'http://localhost:8080').replace(/\/$/, '');
const DOMAIN = 'acme-sample.test';
const PASSWORD = 'Acme@Test2026!';
const ORG_NAME = 'Acme Software Pvt Ltd';

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
    return { status: res.status, ok: res.status < 400, data: json?.data ?? null, message: json?.errors?.[0]?.message ?? json?.message ?? text.slice(0, 200) };
  }
}

class Client {
  constructor(local) { this.email = `${local}@${DOMAIN}`; this.token = null; this.workspaceId = null; }
  async login() {
    const r = await raw('POST', '/auth/login', { body: { email: this.email, password: PASSWORD } });
    if (!r.ok) throw new Error(`login ${this.email}: ${r.message}`);
    this.token = r.data.accessToken; this.userId = r.data.user.id;
    // People with several workspaces land in the personal one: go into the sample organization.
    const spaces = await raw('GET', '/workspaces', { token: this.token });
    const org = spaces.data?.find((w) => w.name === ORG_NAME);
    if (!org) throw new Error(`${this.email} is not a member of "${ORG_NAME}". Run seed-sample-org.mjs first.`);
    const sw = await raw('POST', `/workspaces/${org.id}/switch`, { token: this.token, body: {} });
    if (!sw.ok) throw new Error(`switch: ${sw.message}`);
    this.token = sw.data.accessToken; this.workspaceId = org.id;
  }
  async call(method, path, body) {
    let r = await raw(method, path, { token: this.token, body });
    if (r.status === 401) { await this.login(); r = await raw(method, path, { token: this.token, body }); }
    return r;
  }
  async must(method, path, body) { const r = await this.call(method, path, body); if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.message}`); return r.data; }
  async try(method, path, body, what = '') { const r = await this.call(method, path, body); if (!r.ok) log(`   ! ${what || `${method} ${path}`}: ${r.message}`); return r.ok ? r.data : null; }
}

const TYPE_BY_KEY = { SCI: 'NewProject', SFM: 'Migration', SFI: 'Integration', EPE: 'Enhancement', EPA: 'Upgrade', EPM: 'NewProject', DMG: 'Migration', RAU: 'Enhancement', DQI: 'Compliance', DWR: 'Maintenance' };
const PRIORITY = { L: 'Low', M: 'Medium', H: 'High', C: 'Critical' };
let PEOPLE = {};   // local part of the e-mail (lead, dev.backend ...) -> user id
const NAMES = { arjun: 'owner', divya: 'admin', rahul: 'manager.delivery', sneha: 'manager.product', karthik: 'lead', meera: 'dev.frontend', vikram: 'dev.backend', lakshmi: 'devops', ananya: 'qa', rohan: 'designer', pooja: 'newjoiner' };
const id = (who) => PEOPLE[NAMES[who]];

// ------------------------------------------------------------------ helpers for projects, tasks and delivery date changes
async function makeProject(by, spec, groups) {
  const d = await by.must('POST', '/projects', {
    name: spec.name, key: spec.key, description: spec.description, priority: spec.priority ?? 'Medium', status: spec.status ?? 'Active', ownerId: id(spec.owner),
    startDate: iso(spec.start), dueDate: iso(spec.due), memberIds: spec.members.map(id), timelineTemplate: spec.timeline ?? 'simple', projectGroupId: groups[spec.group], projectType: spec.type ?? TYPE_BY_KEY[spec.key] ?? 'NewProject',
  });
  log(`  ${spec.group.padEnd(20)} ${spec.key.padEnd(4)} ${spec.name}`);
  return {
    id: d.project.id, by, spec, tasks: {},
    statuses: Object.fromEntries(d.statuses.map((s) => [s.name, s.id])), stages: Object.fromEntries(d.stages.map((s) => [s.name, s.id])),
  };
}

/** A task in a stage, then moved to the wanted status (a stage completes on its own once all of its tasks are done, which unlocks the next). */
async function task(p, title, o = {}) {
  const t = await p.by.try('POST', `/projects/${p.id}/tasks`, {
    title, description: o.desc, priority: PRIORITY[o.pri ?? 'M'], assigneeId: o.who ? id(o.who) : null,
    startDate: o.start !== undefined ? iso(o.start) : null, dueDate: o.due !== undefined ? iso(o.due) : null, estimatedHours: o.est ?? null, stageId: p.stages[o.stage],
  }, `task "${title}"`);
  if (!t) return null;
  if (o.status && o.status !== 'Yet To Start') await p.by.try('PATCH', `/tasks/${t.id}/move`, { statusId: p.statuses[o.status] }, `move "${title}" to ${o.status}`);
  p.tasks[title] = t;
  return t;
}
const done = { status: 'Done' };
const ip = { status: 'In Progress' };

/** Moves a task's due date and says why (a later date needs a reason). This is what the Project Status page shows as a delivery change. */
async function reschedule(c, p, title, offset, reason, dependency) {
  const t = p.tasks[title];
  if (!t) return;
  const k = (await c.must('GET', `/tasks/${t.id}`)).task;
  await c.try('PUT', `/tasks/${t.id}`, {
    title: k.title, description: k.description, statusId: k.statusId, priority: k.priority, assigneeId: k.assignee?.id ?? null, startDate: k.startDate, dueDate: iso(offset),
    estimatedHours: k.estimatedHours, actualHours: k.actualHours, labelIds: k.labels.map((l) => l.id), version: k.version, milestoneId: k.milestoneId, stageId: k.stageId,
    dueDateReason: reason, dueDateDependency: dependency,
  }, `new due date for "${title}"`);
}
async function rescheduleProject(c, p, offset, reason, dependency) {
  const q = (await c.must('GET', `/projects/${p.id}`)).project;
  await c.try('PUT', `/projects/${p.id}`, {
    name: q.name, description: q.description, priority: q.priority, status: q.status, ownerId: q.owner?.id, teamId: q.teamId, startDate: q.startDate, dueDate: iso(offset),
    version: q.version, projectGroupId: q.projectGroupId, dueDateReason: reason, dueDateDependency: dependency,
  }, `new due date for project ${q.name}`);
}
/** "successor cannot finish before predecessor does". */
const waitsFor = (c, p, successor, predecessor) => {
  const a = p.tasks[successor], b = p.tasks[predecessor];
  return a && b ? c.try('POST', `/tasks/${a.id}/dependencies`, { dependsOnTaskId: b.id, type: 'FinishToStart' }, `"${successor}" waits for "${predecessor}"`) : null;
};

/** Follow-ups agreed in status meetings, on several projects: some overdue, some completed, some in progress. Only added to a project that has none yet. */
async function addActionItems(by, owner) {
  const projects = (await owner.must('GET', '/projects?pageSize=100')).items;
  const plan = {
    SCI: [by.sneha, [
      { t: 'Get sign-off on the territory rules from Sales operations', who: 'sneha', due: 2, pri: 'High', d: 'Needed before the lead assignment rules can be finished.' },
      { t: 'Confirm the Salesforce licence upgrade date', who: 'sneha', due: 4, pri: 'Critical', status: 'InProgress', d: 'Salesforce account manager promised a date by Thursday.' },
      { t: 'Book the UAT room for the sales team', who: 'pooja', due: 12, pri: 'Low' },
      { t: 'Send the weekly status to the steering group', who: 'sneha', due: -2, pri: 'Medium', status: 'Completed' },
    ]],
    SFM: [by.sneha, [
      { t: 'Approve the duplicate-merge rules', who: 'rohan', due: -1, pri: 'High', d: 'The business owners have not answered yet: this is what is holding the cleansing back.' },
      { t: 'Agree the cut-over weekend with IT', who: 'karthik', due: 8, pri: 'Medium' },
      { t: 'Back up the legacy CRM before loading', who: 'vikram', due: 5, pri: 'Critical', status: 'InProgress' },
    ]],
    EPE: [by.rahul, [
      { t: 'Get HR policy sign-off on the leave approval rules', who: 'rahul', due: 3, pri: 'High', d: 'Blocks the leave request workflow.' },
      { t: 'Share the mock-ups with the pilot group', who: 'rohan', due: 6, pri: 'Medium' },
      { t: 'Schedule the accessibility review', who: 'ananya', due: 10, pri: 'Medium' },
      { t: 'Collect feedback on the new home page', who: 'rohan', due: -4, pri: 'Low', status: 'Completed' },
    ]],
    EPA: [by.rahul, [
      { t: 'Tell the payroll team the v1 shutdown date', who: 'karthik', due: 2, pri: 'High' },
      { t: 'Publish the v2 migration guide', who: 'vikram', due: 6, pri: 'Medium' },
    ]],
    DMG: [by.divya, [
      { t: 'Get the source database maintenance window rebooked', who: 'lakshmi', due: 3, pri: 'Critical', status: 'InProgress', d: 'The DBA team needs two weeks notice.' },
      { t: 'Sign off the validation checklist', who: 'karthik', due: 12, pri: 'Medium' },
    ]],
    DQI: [by.divya, [
      { t: 'Confirm the data quality rules with each data owner', who: 'rohan', due: -2, pri: 'High', d: 'Three of the five owners have replied.' },
      { t: 'Draft the scorecard layout', who: 'pooja', due: 5, pri: 'Low' },
      { t: 'Invite the data stewards to the training', who: 'rohan', due: 9, pri: 'Low' },
    ]],
  };
  log('Action items:');
  for (const [key, [c, items]] of Object.entries(plan)) {
    const project = projects.find((p) => p.key === key);
    if (!project) continue;
    if ((await c.must('GET', `/projects/${project.id}/action-items`)).length > 0) continue;
    for (const it of items) {
      const made = await c.try('POST', `/projects/${project.id}/action-items`, { title: it.t, details: it.d ?? null, assigneeId: id(it.who), dueDate: iso(it.due), priority: it.pri }, `action item "${it.t}"`);
      if (made && it.status) await c.try('PUT', `/projects/${project.id}/action-items/${made.id}/status`, { status: it.status }, `status of "${it.t}"`);
    }
    log(`  ${key.padEnd(4)} ${items.length} action items`);
  }
}

/** Projects made before project types existed are all "Other": give the demo projects their proper type (only those that are still "Other"). */
async function setProjectTypes(owner) {
  const items = (await owner.must('GET', '/projects?pageSize=100&includeArchived=true')).items;
  for (const p of items) {
    const type = TYPE_BY_KEY[p.key];
    if (!type || p.projectType !== 'Other') continue;
    await owner.try('PUT', `/projects/${p.id}`, { name: p.name, description: p.description, priority: p.priority, status: p.status, ownerId: p.owner?.id ?? null, teamId: p.teamId,
      startDate: p.startDate, dueDate: p.dueDate, version: p.version, projectType: type }, `project type of ${p.key}`);
  }
}

/** Operational work that is not a project task: bug fixes, support, analysis ... some of it on completed projects (which stay completed). Only added when there is none yet. */
async function addWorkTasks(owner) {
  if ((await owner.must('GET', '/work-tasks?pageSize=1')).totalItems > 0) return;
  const types = Object.fromEntries((await owner.must('GET', '/work-types')).map((t) => [t.name, t.id]));
  const projects = Object.fromEntries((await owner.must('GET', '/projects?pageSize=100&includeArchived=true')).items.map((p) => [p.key, p.id]));
  const plan = [
    ['Fix rounding error in the refund calculation', 'Bug Fix', 'DWR', 'meera', 'High', -1, 'InProgress'],
    ['Analyse the API timeout on the employee lookup', 'Issue Analysis', 'EPA', 'vikram', 'Critical', 1, 'InProgress'],
    ['Prepare the August payroll data extract', 'Data Preparation', 'EPE', 'ananya', 'Medium', 3, 'ToDo'],
    ['Correct the duplicate customer records', 'Data Correction', 'DMG', 'rohan', 'High', -3, 'ToDo'],
    ['Weekly production support rota', 'Production Support', null, 'lakshmi', 'Medium', 2, 'InProgress'],
    ['Generate the audit report for Q3', 'Report Preparation', 'DWR', 'pooja', 'Medium', 7, 'ToDo'],
    ['Tune the slow dashboard query', 'Performance Analysis', 'RAU', 'vikram', 'Low', 10, 'OnHold'],
    ['Update the SSO callback URLs in production', 'Configuration Change', 'EPE', 'lakshmi', 'High', -1, 'Completed'],
    ['Support the release-night deployment', 'Deployment Support', 'SCI', 'karthik', 'High', 4, 'ToDo'],
    ['Answer the licence question from the client', 'Customer Request', 'SFI', null, 'Medium', 5, 'ToDo'],
    ['Prepare the monthly operational report', 'Report Preparation', null, null, 'Low', 14, 'ToDo'],
  ];
  log('Work tasks:');
  for (const [title, type, project, who, priority, due, status] of plan) {
    await owner.try('POST', '/work-tasks', { title, workTypeId: types[type], relatedProjectId: project ? projects[project] : null, assigneeId: who ? id(who) : null, priority, status, dueDate: iso(due) }, `work task "${title}"`);
  }
  log(`  ${plan.length} work tasks (some on completed projects - those stay completed)`);
}

async function main() {
  const owner = new Client('owner'); await owner.login();
  const rahul = new Client('manager.delivery'); await rahul.login();
  const sneha = new Client('manager.product'); await sneha.login();
  const divya = new Client('admin'); await divya.login();
  PEOPLE = Object.fromEntries((await owner.must('GET', '/workspace/members')).map((m) => [m.email.split('@')[0], m.userId]));

  const listed = await owner.must('GET', '/projects?pageSize=100&includeArchived=true');
  const already = listed.items.some((p) => p.key === 'SCI');
  if (already) log('The demo projects are already there.');
  if (!already) {
  log('Project groups:');
  const groups = Object.fromEntries((await owner.must('GET', '/project-groups')).map((g) => [g.name, g.id]));
  for (const [name, description] of [['Salesforce Projects', 'CRM rollout, migration and integrations'], ['Employee Portal', 'The intranet and its APIs and apps'], ['Data Team', 'Migrations, reporting and data quality']]) {
    if (groups[name]) { log(`  ${name} (already there)`); continue; }
    const g = await owner.must('POST', '/project-groups', { name, description });
    groups[name] = g.id; log(`  ${name}`);
  }

  log('Projects:');
  // =================================================================== Salesforce Projects
  const sci = await makeProject(sneha, { name: 'Salesforce CRM Implementation', key: 'SCI', group: 'Salesforce Projects', owner: 'sneha', timeline: 'software', start: -60, due: 10, priority: 'High',
    description: 'Roll Salesforce out to the sales and support teams: leads, opportunities, cases and dashboards.', members: ['rohan', 'pooja', 'karthik', 'ananya'] }, groups);
  await task(sci, 'Gather CRM requirements from Sales', { stage: 'Requirements & Planning', who: 'rohan', due: -50, est: 12, ...done });
  await task(sci, 'Define the lead and opportunity process', { stage: 'Requirements & Planning', who: 'sneha', due: -44, est: 10, ...done });
  await task(sci, 'Sign off the solution design', { stage: 'Requirements & Planning', who: 'sneha', pri: 'H', due: -40, est: 4, ...done });
  await task(sci, 'Configure objects, fields and page layouts', { stage: 'Development', who: 'rohan', due: -20, est: 24, ...done });
  await task(sci, 'Build lead assignment rules', { stage: 'Development', who: 'karthik', pri: 'H', due: -3, est: 16, ...ip });
  await task(sci, 'Set up sales dashboards and reports', { stage: 'Development', who: 'pooja', due: 6, est: 14, ...ip });
  await task(sci, 'Role hierarchy and permission sets', { stage: 'Development', who: 'karthik', due: 9, est: 10 });
  await task(sci, 'Email-to-case integration', { stage: 'Development', who: 'karthik', due: 14, est: 16 });
  await task(sci, 'Regression test of the sales process', { stage: 'Testing / QA', who: 'ananya', due: 20, est: 16 });
  await task(sci, 'User acceptance testing with Sales', { stage: 'UAT', who: 'sneha', due: 26, est: 12 });
  await waitsFor(sneha, sci, 'Email-to-case integration', 'Build lead assignment rules');
  await reschedule(sneha, sci, 'Build lead assignment rules', 6, 'Sales asked for territory-based assignment on top of round-robin', 'Territory definitions from Sales operations');
  await rescheduleProject(sneha, sci, 20, 'The UAT slot moved after the annual sales conference', 'Sales team availability');
  await rescheduleProject(sneha, sci, 26, 'Salesforce needs to upgrade the licence before the service module can be configured', 'Salesforce licence upgrade');

  const sfm = await makeProject(sneha, { name: 'Salesforce Migration', key: 'SFM', group: 'Salesforce Projects', owner: 'sneha', start: -40, due: -5, priority: 'Critical',
    description: 'Move accounts, contacts and opportunities from the legacy CRM into Salesforce.', members: ['rohan', 'pooja', 'karthik', 'vikram'] }, groups);
  await task(sfm, 'Inventory the legacy CRM data', { stage: 'Planning', who: 'rohan', due: -35, est: 8, ...done });
  await task(sfm, 'Define the field mapping', { stage: 'Planning', who: 'rohan', due: -30, est: 12, ...done });
  await task(sfm, 'Cleanse duplicate accounts', { stage: 'Execution', who: 'pooja', pri: 'H', due: -10, est: 20, ...ip });
  await task(sfm, 'Load contacts into Salesforce', { stage: 'Execution', who: 'vikram', due: 9, est: 14 });
  await task(sfm, 'Migrate open opportunities', { stage: 'Execution', who: 'vikram', due: 12, est: 16 });
  await task(sfm, 'Reconcile record counts', { stage: 'Review', who: 'rohan', due: 14, est: 8 });
  await task(sfm, 'Cut-over rehearsal', { stage: 'Review', who: 'sneha', due: 15, est: 6 });
  await waitsFor(sneha, sfm, 'Load contacts into Salesforce', 'Cleanse duplicate accounts');
  await waitsFor(sneha, sfm, 'Migrate open opportunities', 'Load contacts into Salesforce');
  await reschedule(sneha, sfm, 'Cleanse duplicate accounts', 7, 'The duplicate rate was three times the estimate', 'Business owners to approve the merges');
  await rescheduleProject(sneha, sfm, 15, 'Data cleansing of the legacy accounts took longer than planned', 'Legacy data cleansing');

  const sfi = await makeProject(sneha, { name: 'Salesforce Integration', key: 'SFI', group: 'Salesforce Projects', owner: 'sneha', start: -15, due: 45,
    description: 'Keep orders and invoices in sync between the ERP and Salesforce.', members: ['karthik', 'vikram', 'lakshmi'] }, groups);
  await task(sfi, 'Map the ERP and Salesforce data flows', { stage: 'Planning', who: 'karthik', due: -8, est: 10, ...done });
  await task(sfi, 'Set up the integration user and API limits', { stage: 'Planning', who: 'lakshmi', due: -6, est: 4, ...done });
  await task(sfi, 'Build the order sync (ERP to Salesforce)', { stage: 'Execution', who: 'vikram', pri: 'H', due: 10, est: 24, ...ip });
  await task(sfi, 'Build the invoice sync', { stage: 'Execution', who: 'vikram', due: 20, est: 18 });
  await task(sfi, 'Error handling and retry queue', { stage: 'Execution', who: 'karthik', due: 24, est: 12 });
  await task(sfi, 'Load test the sync', { stage: 'Review', who: 'lakshmi', due: 35, est: 10 });
  await reschedule(sneha, sfi, 'Set up the integration user and API limits', -8, null, null);   // brought forward: no reason needed

  // =================================================================== Employee Portal
  const epe = await makeProject(rahul, { name: 'Employee Portal Enhancement', key: 'EPE', group: 'Employee Portal', owner: 'rahul', timeline: 'software', start: -45, due: 30, priority: 'High',
    description: 'A new home page, leave requests, payslip download and an announcements feed for all employees.', members: ['karthik', 'meera', 'vikram', 'ananya', 'rohan'] }, groups);
  await task(epe, 'Interview HR and employees', { stage: 'Requirements & Planning', who: 'rohan', due: -38, est: 10, ...done });
  await task(epe, 'Write the portal requirements', { stage: 'Requirements & Planning', who: 'rohan', due: -32, est: 12, ...done });
  await task(epe, 'Approve the design mock-ups', { stage: 'Requirements & Planning', who: 'rahul', due: -28, est: 4, ...done });
  await task(epe, 'Redesign the home page', { stage: 'Development', who: 'meera', pri: 'H', due: -10, est: 20, ...done });
  await task(epe, 'Leave request workflow', { stage: 'Development', who: 'meera', pri: 'H', due: 4, est: 24, ...ip });
  await task(epe, 'Payslip download', { stage: 'Development', who: 'vikram', due: -2, est: 14, ...ip });   // overdue: not re-planned yet
  await task(epe, 'Announcements feed', { stage: 'Development', who: 'meera', due: 15, est: 12 });
  await task(epe, 'Code review: leave request workflow', { stage: 'Code Review', who: 'karthik', due: 17, est: 6 });
  await task(epe, 'Regression test of the portal', { stage: 'Testing / QA', who: 'ananya', due: 24, est: 16 });
  await task(epe, 'HR user acceptance testing', { stage: 'UAT', who: 'rahul', due: 28, est: 10 });
  await waitsFor(rahul, epe, 'Announcements feed', 'Leave request workflow');
  await reschedule(rahul, epe, 'Leave request workflow', 11, 'HR changed the approval rules after the design review', 'HR policy sign-off');
  await rescheduleProject(rahul, epe, 42, 'Scope grew: mobile-friendly leave approvals were added', 'HR policy sign-off');

  const epa = await makeProject(rahul, { name: 'EP API Upgrade', key: 'EPA', group: 'Employee Portal', owner: 'rahul', start: -30, due: 12, priority: 'High',
    description: 'Version the employee API (v2) and retire the old endpoints.', members: ['karthik', 'vikram', 'lakshmi'] }, groups);
  await task(epa, 'Inventory the current API consumers', { stage: 'Planning', who: 'karthik', due: -22, est: 6, ...done });
  await task(epa, 'Design the v2 contract', { stage: 'Planning', who: 'vikram', due: -16, est: 10, ...done });
  await task(epa, 'Build the employee API v2', { stage: 'Execution', who: 'vikram', pri: 'H', due: 2, est: 24, ...ip });
  await task(epa, 'Deprecate the v1 endpoints', { stage: 'Execution', who: 'lakshmi', due: 9, est: 8 });
  await task(epa, 'Update the API documentation', { stage: 'Review', who: 'karthik', due: 11, est: 6 });
  await waitsFor(rahul, epa, 'Deprecate the v1 endpoints', 'Build the employee API v2');
  await reschedule(rahul, epa, 'Deprecate the v1 endpoints', 14, 'The payroll team needs two more weeks to move to v2', 'Payroll system migration');
  await rescheduleProject(rahul, epa, 18, 'Deprecation of v1 waits for the payroll system to move', 'Payroll system migration');

  const epm = await makeProject(rahul, { name: 'EP Mobile Application', key: 'EPM', group: 'Employee Portal', owner: 'rahul', timeline: 'software', status: 'Planning', start: -10, due: 90,
    description: 'A native app for the employee portal, starting with leave and payslips.', members: ['meera', 'karthik', 'rohan'] }, groups);
  await task(epm, 'Choose the mobile framework', { stage: 'Requirements & Planning', who: 'karthik', due: 3, est: 6, ...ip });
  await task(epm, 'Draft the app requirements', { stage: 'Requirements & Planning', who: 'rohan', due: 10, est: 10 });
  await task(epm, 'Design the app navigation', { stage: 'Requirements & Planning', who: 'rohan', due: 16, est: 12 });
  await task(epm, 'Build the sign-in and biometric unlock', { stage: 'Development', who: 'meera', due: 40, est: 30 });
  await task(epm, 'Build leave and payslips', { stage: 'Development', who: 'meera', due: 62, est: 40 });

  // =================================================================== Data Team
  const dmg = await makeProject(divya, { name: 'Data Migration', key: 'DMG', group: 'Data Team', owner: 'divya', start: -50, due: 15, priority: 'Critical',
    description: 'Move the legacy reporting database to the new data platform and switch the old one off.', members: ['karthik', 'vikram', 'lakshmi'] }, groups);
  await task(dmg, 'Profile the source databases', { stage: 'Planning', who: 'karthik', due: -42, est: 10, ...done });
  await task(dmg, 'Design the target schema', { stage: 'Planning', who: 'vikram', due: -36, est: 14, ...done });
  await task(dmg, 'Migrate the reference data', { stage: 'Execution', who: 'vikram', due: -24, est: 12, ...done });
  await task(dmg, 'Migrate the transactional history', { stage: 'Execution', who: 'vikram', pri: 'C', due: -2, est: 40, ...ip });
  await task(dmg, 'Validate the migrated data', { stage: 'Review', who: 'lakshmi', due: 14, est: 16 });
  await task(dmg, 'Decommission the legacy database', { stage: 'Review', who: 'lakshmi', due: 24, est: 6 });
  await waitsFor(divya, dmg, 'Validate the migrated data', 'Migrate the transactional history');
  await waitsFor(divya, dmg, 'Decommission the legacy database', 'Validate the migrated data');
  await reschedule(divya, dmg, 'Migrate the transactional history', 8, 'The source system maintenance window was cancelled', 'Source database maintenance window');
  await rescheduleProject(divya, dmg, 25, 'The transactional history is 40% larger than estimated', 'Source database maintenance window');

  const rau = await makeProject(divya, { name: 'Reporting Automation', key: 'RAU', group: 'Data Team', owner: 'divya', start: -20, due: 40,
    description: 'Replace the monthly spreadsheet reports with scheduled dashboards.', members: ['karthik', 'meera', 'pooja'] }, groups);
  await task(rau, 'Inventory the monthly reports', { stage: 'Planning', who: 'pooja', due: -14, est: 6, ...done });
  await task(rau, 'Automate the finance dashboard', { stage: 'Execution', who: 'meera', due: 12, est: 24, ...ip });
  await task(rau, 'Schedule the email delivery', { stage: 'Execution', who: 'karthik', due: 20, est: 10 });
  await task(rau, 'Retire the manual spreadsheets', { stage: 'Review', who: 'pooja', due: 32, est: 8 });
  await reschedule(divya, rau, 'Automate the finance dashboard', 9, null, null);   // brought forward

  const dqi = await makeProject(divya, { name: 'Data Quality Improvement', key: 'DQI', group: 'Data Team', owner: 'divya', start: -35, due: -3, priority: 'High',
    description: 'Agree data quality rules with the data owners and publish a monthly scorecard.', members: ['karthik', 'pooja', 'rohan'] }, groups);
  await task(dqi, 'Define the data quality rules', { stage: 'Planning', who: 'rohan', due: -26, est: 12, ...done });
  await task(dqi, 'Implement the validation checks', { stage: 'Execution', who: 'karthik', pri: 'H', due: -6, est: 20, ...ip });
  await task(dqi, 'Publish the data quality scorecard', { stage: 'Execution', who: 'pooja', due: 8, est: 10 });
  await task(dqi, 'Train the data stewards', { stage: 'Review', who: 'rohan', due: 10, est: 6 });
  await waitsFor(divya, dqi, 'Publish the data quality scorecard', 'Implement the validation checks');
  await reschedule(divya, dqi, 'Implement the validation checks', 4, 'The data owners have not confirmed the rules yet', 'Data owner approvals');
  // The project's own due date has not been re-planned yet, so it shows as Delayed.

  const dwr = await makeProject(divya, { name: 'Data Warehouse Refresh', key: 'DWR', group: 'Data Team', owner: 'divya', start: -90, due: -20,
    description: 'Upgrade the warehouse engine and rebuild the nightly loads. Completed.', members: ['karthik', 'lakshmi'] }, groups);
  await task(dwr, 'Benchmark the new engine', { stage: 'Planning', who: 'lakshmi', due: -80, est: 8, ...done });
  await task(dwr, 'Rebuild the nightly loads', { stage: 'Execution', who: 'karthik', due: -55, est: 30, ...done });
  await task(dwr, 'Switch over and monitor', { stage: 'Review', who: 'lakshmi', due: -25, est: 8, ...done });
  await divya.try('PUT', `/projects/${dwr.id}/stages/${dwr.stages['Project Completed']}`, { name: 'Project Completed', status: 'Completed' }, 'complete the final stage');
  await divya.try('PATCH', `/projects/${dwr.id}/move`, { status: 'Completed' }, 'mark the project completed');
  }   // (the projects above are only created once)

  await addActionItems({ sneha, rahul, divya }, owner);
  await setProjectTypes(owner);
  await addWorkTasks(owner);

  log('\nDone. Sign in as owner@acme-sample.test and open "Project status" in the menu.');
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
