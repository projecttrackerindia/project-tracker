// Action item review over work items (apple2 design: review, review-pop, review-summary, review-my, review-phone):
//  - the series' items grouped by owner, "N of M reviewed", status counts and the key legend;
//  - one key per decision: D (done) and C (carry) post the decision and move on; J/K walk; U undoes; R opens Re-plan, which needs a
//    reason chip or text and sends the new owner and date; X asks why before dropping;
//  - Finish & write minutes shows the counts and the grouped lines; Send to attendees sends the (edited) text once;
//  - My action items: tabs with counts, grouped by meeting, a one-line update with On track / Need help / Ask to move date / Done;
//  - the phone review is one card with big buttons and fits 390.
// 1440 light and dark, 390. Synthetic data only.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/action-review-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Riverline Payments', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const pid = '00000000-0000-0000-0000-000000000003', mid = '00000000-0000-0000-0000-0000000000a1';
const people = { tomas: { id: '00000000-0000-0000-0000-000000000013', name: 'Tomas Rivera' }, ravi: { id: '00000000-0000-0000-0000-000000000011', name: 'Ravi Menon' }, mira: { id: '00000000-0000-0000-0000-000000000012', name: 'Mira Okafor' } };
const NOW = new Date('2026-11-02T11:40:00+05:30');
const iso = (d, hm = '11:30') => new Date(`${d}T${hm}:00+05:30`).toISOString();

const item = (o) => ({ key: 'AI-1', projectId: pid, projectName: 'UPI AutoPay', dueDate: '2026-11-03', isOverdue: false, daysOverdue: 0, state: 'in_progress', statusLabel: 'In Progress', sourceTitle: 'AutoPay weekly',
  sourceOccurrence: iso('2026-10-26'), seriesRef: `p:${mid}`, latestNote: null, lastUpdateAt: null, noUpdateDays: 1, noUpdate: false, ownerLeft: false, canEdit: true, decision: null, createdAt: iso('2026-10-26'), ...o });
const base = () => [
  item({ id: 'i1', key: 'AI-21', title: 'Confirm HSM vendor slot', owner: people.tomas, dueDate: '2026-10-28', isOverdue: true, daysOverdue: 5, state: 'open', statusLabel: 'Open', sourceTitle: 'Vault stand-up',
    latestNote: 'Vendor offered 4 Nov or 6 Nov. Holding 4 Nov until Ravi confirms.', lastUpdateAt: iso('2026-11-02', '09:40') }),
  item({ id: 'i2', key: 'AI-22', title: 'Get bank sandbox date from NPCI liaison', owner: people.ravi, dueDate: '2026-10-27', isOverdue: true, daysOverdue: 6, state: 'open', noUpdate: true, noUpdateDays: 9 }),
  item({ id: 'i3', key: 'AI-23', title: 'Draft fraud rule thresholds', owner: people.ravi, latestNote: 'First draft in doc, needs Mira’s numbers.', lastUpdateAt: iso('2026-11-01') }),
  item({ id: 'i4', key: 'AI-24', title: 'Weekly SMS report', owner: people.mira, state: 'open' }),
];
function review(items, draft = []) {
  const reviewed = items.filter((i) => i.decision).length;
  return { sessionId: 's1', scope: 'series', seriesRef: `p:${mid}`, title: 'AutoPay weekly review', cadence: 'Weekly', occurrence: iso('2026-11-02'), previousSession: iso('2026-10-26'), nextSession: iso('2026-11-09'),
    attendees: 5, counts: { total: items.length, reviewed, done: items.filter((i) => i.state === 'done').length, inProgress: items.filter((i) => i.state === 'in_progress').length, overdue: items.filter((i) => i.isOverdue).length,
      blocked: 0, noUpdate: items.filter((i) => i.noUpdate).length }, items, finished: false, sent: false, draft, projectId: pid };
}
const minutes = { sessionId: 's1', title: 'AutoPay weekly review', occurrence: iso('2026-11-02'), nextSession: iso('2026-11-09', '11:00'), reviewed: 4, total: 4, durationMinutes: 14, done: 1, carried: 1, replanned: 1, dropped: 1, new: 1,
  reassignedCount: 1, redatedCount: 1, sent: false, attendees: 5, text: 'Minutes: AutoPay weekly review · 2 Nov 2026\n\nDecided\n- Confirm HSM vendor slot — Tomas Rivera',
  lines: [{ group: 'decided', text: 'Confirm HSM vendor slot', owner: people.tomas, date: null, workItemId: 'i1' }, { group: 'carried', text: 'Draft fraud rule thresholds', owner: people.ravi, date: '2026-11-09', workItemId: 'i3' },
    { group: 'replanned', text: 'Get bank sandbox date from NPCI liaison · Ravi → Mira · “Mira owns the NPCI relationship”', owner: people.mira, date: '2026-11-07', workItemId: 'i2' },
    { group: 'new', text: 'Book PCI assessor call', owner: people.mira, date: '2026-11-05', workItemId: 'n1' }, { group: 'dropped', text: 'Weekly SMS report · “Replaced by dashboard”', owner: people.mira, date: null, workItemId: 'i4' }] };
const mine = { needsUpdate: [item({ id: 'm1', title: 'Retry & notification rules sign-off', owner: { id: user.id, name: 'Asha Rao' }, dueDate: '2026-10-31', isOverdue: true, daysOverdue: 2, latestNote: 'Asked Lena for final copy; on track.', lastUpdateAt: iso('2026-11-01') }),
  item({ id: 'm2', title: 'Escalation matrix for failed mandates', owner: { id: user.id, name: 'Asha Rao' }, dueDate: '2026-10-28', isOverdue: true, daysOverdue: 5, state: 'open', noUpdate: true, noUpdateDays: 6 }),
  item({ id: 'm3', title: 'Q4 budget variance note', owner: { id: user.id, name: 'Asha Rao' }, dueDate: '2026-11-04', state: 'open', seriesRef: 'p:00000000-0000-0000-0000-0000000000b9', sourceTitle: 'Steering committee' })],
  dueThisWeek: [], waitingOnOthers: [item({ id: 'm4', title: 'Collect PCI evidence', owner: people.mira })], done: [],
  series: [{ seriesRef: `p:${mid}`, title: 'AutoPay weekly review', cadence: 'Weekly', nextSession: iso('2026-11-02') }, { seriesRef: 'p:00000000-0000-0000-0000-0000000000b9', title: 'Steering committee', cadence: 'Monthly', nextSession: iso('2026-11-04', '16:00') }] };

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  async function setup(theme, width, height = 1000) {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...(width <= 430 ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.clock.setFixedTime(NOW);
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    const writes = [];
    let items = base();
    const history = [];
    await ctx.route('**/*', async (route) => {
      const req = route.request(); const url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream';
        await route.fulfill({ contentType: type, body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return;
      }
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, body: req.postDataJSON?.() ?? null });
      let data = [];
      const decided = () => items.map((i) => i);
      if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'work.view', 'work.edit', 'work.create', 'tasks.create', 'tasks.edit'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, chat: 3, documents: 3, people: 3, reports: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/meet/review') data = review(items);
      else if (ep === '/api/v1/meet/review/s1/decide') {
        const b = req.postDataJSON(); history.push(structuredClone(items));
        items = items.map((i) => (i.id === b.workItemId ? { ...i, state: b.decision === 'done' ? 'done' : b.decision === 'drop' ? 'cancelled' : i.state,
          decision: { id: `d${history.length}`, decision: b.decision, reason: b.reason ?? null, by: { id: user.id, name: 'Asha Rao' }, at: NOW.toISOString(), fromDue: i.dueDate, toDue: b.dueDate ?? i.dueDate, fromOwner: i.owner, toOwner: i.owner, convertedTaskId: null, convertedKey: null } } : i));
        data = review(decided(), items.filter((i) => i.decision).map((i) => ({ group: i.decision.decision === 'done' ? 'decided' : i.decision.decision === 'carry' ? 'carried' : i.decision.decision === 'replan' ? 'replanned' : 'dropped', text: i.title, owner: i.owner, date: i.decision.toDue, workItemId: i.id })));
      }
      else if (ep === '/api/v1/meet/review/s1/undo') { items = history.pop() ?? items; data = review(items); }
      else if (ep === '/api/v1/meet/review/s1/finish') data = minutes;
      else if (ep === '/api/v1/meet/review/s1/send') data = { ...minutes, sent: true, text: req.postDataJSON().text };
      else if (ep === '/api/v1/meet/my-action-items') data = mine;
      else if (/\/api\/v1\/meet\/action-items\/[^/]+\/(update|nudge)$/.test(ep)) data = {};
      else if (ep === `/api/v1/projects/${pid}/meetings/participants`) data = [{ userId: user.id, name: 'Asha Rao', email: '', role: 'Owner', rsvpStatus: 'Accepted' }, ...Object.values(people).map((p) => ({ userId: p.id, name: p.name, email: '', role: 'Member', rsvpStatus: 'Accepted' }))];
      else if (ep === '/api/v1/meet/time-proposals') data = [];
      else if (ep === '/api/v1/work-items') data = { items: [], offset: 0, limit: 50, hasMore: false };
      else if (ep === '/api/v1/meet') data = { items: [], from: '', to: '', truncated: false };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep === '/api/v1/me/ui/mywork') data = { value: {} };
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${theme} ${width}: ${e.message}`));
    await page.setViewportSize({ width, height });
    return { ctx, page, writes };
  }
  const reviewUrl = `/preview-org/messages?f=meetings&review=${encodeURIComponent(`p:${mid}`)}&at=${encodeURIComponent(iso('2026-11-02'))}`;

  // ---------------------------------------------------------------- 1440 light
  let { ctx, page, writes } = await setup('light', 1440);
  await page.goto(origin + reviewUrl);
  await page.getByTestId('action-review').waitFor({ timeout: 15000 });
  assert.equal(await page.getByTestId('review-progress').innerText(), '0 of 4 reviewed');
  assert.match(await page.locator('.rv-head p').innerText(), /Since last meeting on 26 Oct · Weekly · 5 attendees/);
  assert.deepEqual(await page.locator('.rv-grp h2').evaluateAll((h) => h.map((x) => x.textContent.replace(/\s+/g, ' ').trim().replace(/^\w\w/, ''))), ['Mira Okafor · 1 item', 'Ravi Menon · 2 items', 'Tomas Rivera · 1 item']);
  assert.match(await page.getByTestId('review-row').filter({ hasText: 'Get bank sandbox date' }).innerText(), /No update since it was assigned 9 days ago\.\s*Nudge Ravi/);
  assert.match(await page.locator('.rv-rail').innerText(), /Aura: 1 item has no update/);
  await page.screenshot({ path: path.join(out, 'review-light-1440.png'), animations: 'disabled' });

  // D on the first row (Mira's): done, then on to the next; C carries the next one to the next session.
  await page.locator('body').press('d');
  await page.getByTestId('review-progress').getByText('1 of 4 reviewed').waitFor();
  assert.deepEqual(writes.at(-1), { ep: '/api/v1/meet/review/s1/decide', body: { workItemId: 'i4', decision: 'done' } });
  await page.locator('body').press('c');
  await page.getByTestId('review-progress').getByText('2 of 4 reviewed').waitFor();
  assert.equal(writes.at(-1).body.decision, 'carry');
  assert.equal(writes.at(-1).body.workItemId, 'i2');
  assert.match(await page.locator('.rv-rail').innerText(), /Carried over/);
  // U undoes the carry; K walks back to it.
  await page.locator('body').press('u');
  await page.getByTestId('review-progress').getByText('1 of 4 reviewed').waitFor();
  assert.equal(writes.at(-1).ep, '/api/v1/meet/review/s1/undo');
  await page.locator('body').press('k');
  assert.ok(await page.locator('.rv-row.on').filter({ hasText: 'Get bank sandbox date' }).count() === 1, 'K walks back');
  checks.push('keys: D done, C carry, U undo, K back');

  // R: re-plan needs a reason; the new owner is told.
  await page.locator('body').press('r');
  const pop = page.getByRole('dialog', { name: /Re-plan Get bank sandbox date/ });
  await pop.waitFor();
  await pop.getByLabel('New owner').selectOption(people.mira.id);
  assert.ok(await pop.getByRole('button', { name: 'Save & next ↵' }).isDisabled(), 'a reason is required');
  await pop.getByRole('button', { name: 'Next meeting' }).click();
  await pop.getByRole('button', { name: 'Owner changed' }).click();
  await pop.getByRole('textbox', { name: 'Reason' }).fill('Mira owns the NPCI relationship now; Ravi on leave till 5 Nov');
  assert.match(await pop.innerText(), /Mira gets notified/);
  await page.screenshot({ path: path.join(out, 'review-pop-light-1440.png'), animations: 'disabled' });
  await pop.getByRole('button', { name: 'Save & next ↵' }).click();
  await page.getByTestId('review-progress').getByText('2 of 4 reviewed').waitFor();
  assert.deepEqual(writes.at(-1).body, { workItemId: 'i2', decision: 'replan', reason: 'Owner changed: Mira owns the NPCI relationship now; Ravi on leave till 5 Nov', ownerId: people.mira.id, dueDate: '2026-11-09' });
  checks.push('R: re-plan with owner, next-meeting date and reason (required)');

  // X asks why before dropping.
  await page.getByTestId('review-row').filter({ hasText: 'Draft fraud rule thresholds' }).click();
  await page.locator('body').press('x');
  const drop = page.getByRole('dialog', { name: /Drop Draft fraud rule thresholds/ });
  await drop.getByRole('button', { name: 'Replaced' }).click();
  await drop.getByRole('button', { name: 'Save & next ↵' }).click();
  await page.getByTestId('review-progress').getByText('3 of 4 reviewed').waitFor();
  assert.deepEqual(writes.at(-1).body, { workItemId: 'i3', decision: 'drop', reason: 'Replaced' });

  // Finish & write minutes, then send.
  await page.getByRole('button', { name: 'Finish & write minutes' }).click();
  const min = page.getByTestId('minutes');
  await min.waitFor();
  assert.match(await min.locator('.rv-head p').innerText(), /4 of 4 reviewed in 14 min · Next meeting Mon 9 Nov, 11:00/);
  assert.deepEqual(await min.locator('.rv-min-g h3').allInnerTexts(), ['DECIDED', 'CARRIED OVER', 'RE-PLANNED', 'NEW ACTION ITEMS', 'DROPPED']);
  await page.screenshot({ path: path.join(out, 'review-summary-light-1440.png'), animations: 'disabled' });
  await min.getByRole('button', { name: 'Edit any line before sending.' }).click();
  await min.getByRole('textbox', { name: 'Minutes' }).fill('Minutes: AutoPay weekly review\n- Sandbox date moves to Mira');
  await min.getByRole('button', { name: 'Send to 5 attendees' }).click();
  await min.locator('h1').getByText('Minutes sent').waitFor();
  assert.deepEqual(writes.filter((w) => w.ep.endsWith('/send')).map((w) => w.body.text), ['Minutes: AutoPay weekly review\n- Sandbox date moves to Mira']);
  checks.push('Finish & write minutes → grouped lines → edited text sent once');

  // My action items.
  await page.goto(origin + '/preview-org/work?view=actions');
  await page.getByTestId('my-action-items').waitFor({ timeout: 15000 });
  assert.deepEqual(await page.getByTestId('my-action-items').getByRole('tab').allInnerTexts(), ['Needs my update · 3', 'Due this week · 0', 'Waiting on others · 1', 'Done · 0']);
  assert.deepEqual(await page.locator('.mai-grp h2').evaluateAll((h) => h.map((x) => x.textContent.trim())), ['AutoPay weekly review · Mon 2 NovWeekly', 'Steering committee · Wed 4 NovMonthly']);
  await page.screenshot({ path: path.join(out, 'review-my-light-1440.png'), animations: 'disabled' });
  const r2 = page.getByTestId('my-action-item').filter({ hasText: 'Escalation matrix' });
  await r2.getByRole('textbox').fill('Waiting on ops for the template');
  await r2.getByRole('button', { name: 'Need help' }).click();
  await page.waitForTimeout(200);
  assert.deepEqual(writes.at(-1), { ep: '/api/v1/meet/action-items/m2/update', body: { note: 'Waiting on ops for the template', signal: 'need_help' } });
  checks.push('My action items: tabs with counts, grouped by meeting, one-line update + Need help');
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- 1440 dark
  ({ ctx, page, writes } = await setup('dark', 1440));
  await page.goto(origin + reviewUrl);
  await page.getByTestId('action-review').waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(out, 'review-dark-1440.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Finish & write minutes' }).click();
  await page.getByTestId('minutes').waitFor();
  await page.screenshot({ path: path.join(out, 'review-summary-dark-1440.png'), animations: 'disabled' });
  await page.close(); await ctx.close();

  // ---------------------------------------------------------------- 390 phone: one card, big buttons
  ({ ctx, page, writes } = await setup('light', 390, 844));
  await page.goto(origin + reviewUrl);
  await page.getByTestId('action-review-phone').waitFor({ timeout: 15000 });
  assert.match(await page.locator('.rvp-sub').innerText(), /AutoPay weekly review · 0 of 4/);
  await fitsPhone(page, 'review-phone', assert);
  await page.screenshot({ path: path.join(out, 'review-phone-light-390.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '✓ Done' }).click();
  await page.locator('.rvp-sub').getByText(/1 of 4/).waitFor();
  assert.equal(writes.at(-1).body.decision, 'done');
  await page.goto(origin + '/preview-org/work?view=actions');
  await page.getByTestId('my-action-items').waitFor({ timeout: 15000 });
  await fitsPhone(page, 'my-action-items-phone', assert);
  await page.screenshot({ path: path.join(out, 'review-my-phone-light-390.png'), animations: 'disabled' });
  await page.close(); await ctx.close();
  checks.push('phone: one card with big buttons; My action items fit 390');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`action review UI OK (${checks.length} checks)\n- ${checks.join('\n- ')}\nScreenshots: ${out}`);
} finally {
  await browser.close();
}
