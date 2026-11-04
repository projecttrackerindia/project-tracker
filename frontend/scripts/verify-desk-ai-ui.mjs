import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appCsp } from './lib/csp.mjs';
import { fitsPhone } from './lib/phone.mjs';

// Desk phase 1 (omnichannel): the ticket from WhatsApp shows the live chat, the AI summary with its confidence, the assignment (Accept, Next
// engineer, Override…), the SLA clocks and voice calls with their transcript; the availability switch sits in the toolbar. Desk › Integrations:
// WhatsApp intake, AI routing, engineers, Sarvam (write-only key), consent and retention, telephony (honestly not connected), SLA and the
// queue's dead letters. 1440 light and dark, 390 phone. Synthetic API with fictional people only; every write is checked.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/desk-ai-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const g = (n) => `92000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const user = { id: g(1), displayName: 'Anika Rao', email: 'anika@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const me = { id: user.id, name: user.displayName };
const dev = { id: g(2), name: 'Dev Malhotra' }, isha = { id: g(3), name: 'Isha Verma' }, caller = { id: g(4), name: 'Lakshmi Iyer' };
const ws = { id: g(9), slug: 'preview-org', name: 'Lumen Lending', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const members = [me, dev, isha].map((x, i) => ({ userId: x.id, displayName: x.name, email: `${x.name.split(' ')[0].toLowerCase()}@example.test`, role: i ? 'Member' : 'Owner', joinedAt: '2026-01-01T00:00:00Z', jobRole: null }));
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const ahead = (min) => new Date(Date.now() + min * 60e3).toISOString();
const T1 = g(100), T2 = g(101);

function state() {
  const tickets = [
    { id: T1, key: 'WT-41', title: 'Cannot log in after OTP reset', priority: 'High', assignee: me, reporter: caller, channel: 'whatsapp', left: 42, description: 'From WhatsApp (Branch helpdesk)…' },
    { id: T2, key: 'WT-40', title: 'EMI debited twice for March', priority: 'Medium', assignee: dev, reporter: { id: g(5), name: 'Rahul Menon' }, channel: 'phone', left: 180, description: 'Voice request' },
  ];
  return {
    writes: [],
    tickets,
    routing: {
      [T1]: { workTaskId: T1, key: 'WT-41', routingEnabled: true, threshold: 70,
        insight: { channel: 'whatsapp', category: 'Login and access', priority: 'High', department: 'IT', skills: ['access'], confidence: 86, summary: 'Customer cannot sign in to the app after resetting the OTP; blocked from paying the EMI due today.', source: 'ai', needsReview: false, reviewedBy: null, reviewedAt: null, contact: null, organization: null },
        current: { id: g(200), assignee: me, method: 'auto', reason: 'skills access · 2 of 8 tickets · IT', score: 82, assignedAt: ago(3), acceptDueAt: ahead(7), acceptedAt: null, reassignments: 0, escalatedAt: null, active: true, assignedBy: null },
        history: [], candidates: [{ userId: me.id, name: me.name, score: 82, reason: 'skills access · 2 of 8 tickets · IT' }, { userId: dev.id, name: dev.name, score: 54, reason: '5 of 8 tickets · IT' }],
        responseDueAt: ahead(12), resolutionDueAt: ahead(42), canOverride: true, canAccept: true },
      [T2]: { workTaskId: T2, key: 'WT-40', routingEnabled: true, threshold: 70,
        insight: { channel: 'voice', category: 'Payments', priority: 'Medium', department: 'Finance operations', skills: ['payments'], confidence: 58, summary: 'Two EMI debits on the same day; wants one refunded.', source: 'rules', needsReview: true, reviewedBy: null, reviewedAt: null, contact: null, organization: null },
        current: { id: g(201), assignee: null, method: 'review', reason: 'AI is 58% sure (below 70%): a person decides', score: 0, assignedAt: ago(20), acceptDueAt: null, acceptedAt: null, reassignments: 0, escalatedAt: null, active: true, assignedBy: null },
        history: [], candidates: [], responseDueAt: null, resolutionDueAt: ahead(180), canOverride: true, canAccept: false },
    },
    thread: { chat: { id: g(300), contact: '+91 98•••••210', contactName: 'Lakshmi Iyer', language: 'en', canReply: true, mode: 'human' }, messages: [
      { from: 'contact', text: 'Hi, I cannot log in to the app since I reset my OTP. My EMI is due today.', at: ago(9), by: null, media: null },
      { from: 'update', text: 'Thanks for writing to us. We have received your request (ticket WT-41) and will update you here.', at: ago(9), by: 'Desk', media: null },
      { from: 'contact', text: '[photo] error screen', at: ago(8), by: null, media: { kind: 'image', id: '123', mime: 'image/jpeg', fileName: null } },
      { from: 'agent', text: 'Thanks Lakshmi, checking your account now.', at: ago(2), by: 'Anika Rao', media: null },
    ] },
    voice: { [T2]: [{ id: g(400), workTaskId: T2, ticketKey: 'WT-40', channel: 'web', language: 'hi', status: 'completed', consentGiven: true, consentAt: ago(25), recorded: true, recordingBytes: 48213, retainUntil: ahead(60 * 24 * 90),
      startedAt: ago(26), endedAt: ago(22), provider: 'sarvam', summary: 'Two EMI debits on the same day; wants one refunded.',
      transcript: [{ index: 0, role: 'assistant', text: 'Hello, this is an automated assistant. This call may be recorded… Do you agree?', at: ago(26), hasAudio: false },
        { index: 1, role: 'caller', text: 'Yes, I agree.', at: ago(26), hasAudio: false }, { index: 2, role: 'caller', text: 'My EMI got debited twice on the 5th.', at: ago(25), hasAudio: true }] }] },
    settings: { intakeEnabled: true, autoAcknowledge: true, autoCreateTicket: true, ackMessage: 'Thanks for writing to us. We have received your request{ticket} and will update you here.', routingEnabled: true,
      confidenceThreshold: 70, acceptMinutes: 10, maxReassignments: 2, supervisor: me, notifyOnWhatsApp: false, voiceEnabled: true, hasSarvamKey: true, sarvamFromServer: false, voiceLanguages: ['en', 'hi', 'te'],
      consentPrompt: 'Hello, this is an automated assistant. This call may be recorded to help us resolve your request. Do you agree?', recordCalls: true, retentionDays: 90, telephonyProvider: 'none',
      hasTelephonyKey: false, telephonyReady: false, whatsAppNumbers: 1, canManage: true },
    engineers: [
      { userId: me.id, name: me.name, status: 'available', statusChangedAt: ago(60), skills: ['access', 'network'], department: 'IT', maxActive: 8, shiftStartMinutes: 540, shiftEndMinutes: 1080, onCall: false, active: 2, configured: true },
      { userId: dev.id, name: dev.name, status: 'busy', statusChangedAt: ago(30), skills: ['payments'], department: 'Finance operations', maxActive: 8, shiftStartMinutes: null, shiftEndMinutes: null, onCall: false, active: 5, configured: true },
      { userId: isha.id, name: isha.name, status: 'offline', statusChangedAt: null, skills: [], department: '', maxActive: 8, shiftStartMinutes: null, shiftEndMinutes: null, onCall: false, active: 0, configured: false },
    ],
    queue: { pending: 0, done: 128, dead: 1, recent: [{ id: g(500), provider: 'whatsapp', messageType: 'document', status: 'dead', attempts: 5, createdAt: ago(300), nextAttemptAt: ago(240), lastError: 'WhatsApp did not give the file.', workTaskId: null }] },
  };
}
const row = (w) => ({ kind: 'ticket', id: w.id, key: w.key, title: w.title, projectId: null, projectKey: null, projectName: null, status: 'To Do', category: 'Todo', priority: w.priority, dueDate: null, isOverdue: false,
  assignee: w.assignee, typeName: 'Customer support', updatedAt: ago(1), slaStartAt: ago(30), slaDueAt: ahead(w.left), slaState: 'OnTrack' });
const detail = (w) => ({ ...row(w), description: w.description, startDate: null, reporter: w.reporter, version: 3, createdAt: ago(30), completedAt: null, loggedMinutes: 0,
  detail: { id: w.id, status: 'ToDo', workTypeId: g(81), workType: 'Customer support', relatedProject: null, can: { edit: true, delete: true } }, activity: [], channel: w.channel });

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async (theme, s) => {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
  await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.endsWith('/thumbnail')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
      return;
    }
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : data) });
    const t = ep.match(/^\/api\/v1\/desk\/tickets\/([0-9a-f-]{36})\/(routing|whatsapp|voice|accept|override|reassign|review|callback)$/);
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) {
      const b = req.postDataJSON();
      s.writes.push({ ep, method, b });
      if (t && t[2] === 'accept') { const r = s.routing[t[1]]; r.current = { ...r.current, acceptedAt: new Date().toISOString() }; r.canAccept = false; return json(r); }
      if (t && t[2] === 'review') { const r = s.routing[t[1]]; assert.equal(typeof b.approve, 'boolean'); r.insight = { ...r.insight, needsReview: false }; return json(r); }
      if (t && t[2] === 'callback') return json({ errors: [{ code: 'TELEPHONY_NOT_CONFIGURED', message: 'Phone calls are not set up yet: connect a telephony provider.' }] }, 409);
      if (ep === '/api/v1/operations/triage') return json({ duplicates: [] });
      if (ep === '/api/v1/desk/engineers/me/status') { assert.ok(['available', 'busy', 'away', 'offline'].includes(b.status)); s.engineers[0].status = b.status; return json(s.engineers[0]); }
      if (ep === '/api/v1/desk/settings' && method === 'PUT') {
        assert.ok(!('hasSarvamKey' in b), 'saves the request shape'); assert.ok(b.sarvamApiKey === null || typeof b.sarvamApiKey === 'string');
        s.settings = { ...s.settings, ...b, supervisor: me, hasSarvamKey: b.sarvamApiKey === '' ? false : s.settings.hasSarvamKey || !!b.sarvamApiKey };
        delete s.settings.sarvamApiKey; delete s.settings.telephonyKey; delete s.settings.supervisorId;
        return json(s.settings);
      }
      assert.fail(`Unexpected write: ${method} ${ep}`);
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 0, permissions: ['work.view', 'work.create', 'work.edit', 'work.types.manage', 'org.manage'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 0, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
    else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: true };
    else if (ep === '/api/v1/workspace/members') data = members;
    else if (ep === '/api/v1/work-items') data = { items: s.tickets.map(row), offset: 0, limit: 200, hasMore: false };
    else if (ep.match(/^\/api\/v1\/work-items\/([0-9a-f-]{36})$/)) data = detail(s.tickets.find((w) => ep.endsWith(w.id)));
    else if (t && t[2] === 'routing') data = s.routing[t[1]];
    else if (t && t[2] === 'whatsapp') data = t[1] === T1 ? s.thread : null;
    else if (t && t[2] === 'voice') data = s.voice[t[1]] ?? [];
    else if (ep === '/api/v1/desk/settings') data = s.settings;
    else if (ep === '/api/v1/desk/engineers') data = s.engineers;
    else if (ep === '/api/v1/desk/queue') data = s.queue;
    else if (ep === '/api/v1/desk/voice') data = { enabled: true, speechReady: true, telephonyReady: false, telephonyProvider: 'none', languages: ['en', 'hi', 'te'] };
    else if (ep === '/api/v1/work/sla') data = { entitled: true, canManage: true, defaults: [{ priority: 'Critical', responseMinutes: 15, resolutionMinutes: 240 }, { priority: 'High', responseMinutes: 30, resolutionMinutes: 480 }, { priority: 'Medium', responseMinutes: 120, resolutionMinutes: 1440 }], overrides: [] };
    else if (ep === '/api/v1/operations/triage') data = { duplicates: [] };
    else if (ep === '/api/v1/desk/reply-templates') data = [];
    else if (ep.endsWith('/ai/status')) data = { enabled: false, configured: false, entitled: true, allowedHere: false };
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/priorities') data = null;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
  });
  return ctx;
};
const errors = [], checks = [], shots = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error' && !e.text().startsWith('Failed to load resource')) errors.push(e.text()); });
};
const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(600); const p = path.join(out, name); await page.screenshot({ path: p, fullPage: false, animations: 'disabled' }); shots.push(p); };
const waitFor = async (fn, what) => { for (let i = 0; i < 40; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };

try {
  for (const theme of ['light', 'dark']) {
    const s = state();
    const ctx = await make(theme, s);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/desk?ticket=${T1}`);
    await page.locator('.cdq-work .dq-cols').first().waitFor();   // a ticket link opens the calm queue (demo shot 07)

    // The live WhatsApp chat replaces the copy taken when the ticket was raised.
    const wa = page.getByTestId('dai-wa-thread');
    await wa.getByText('Checking your account now', { exact: false }).waitFor();
    assert.equal(await wa.locator('.dai-wa-m.in').count(), 2);
    await wa.getByText('🖼 Photo').waitFor();
    checks.push('whatsapp thread');

    // AI summary, confidence, assignment with its acceptance clock, SLA.
    const card = page.getByTestId('dai-routing');
    await card.getByText('86%').waitFor();
    await card.getByText('Login and access').waitFor();
    await card.getByText(/Accept within \d+m/).waitFor();
    await card.getByText('Resolve by').waitFor();
    await card.getByRole('button', { name: 'Accept' }).click();
    await waitFor(() => s.writes.some((w) => w.ep === `/api/v1/desk/tickets/${T1}/accept`), 'accept');
    await card.getByText(/^Accepted \d\d:\d\d$/).waitFor();
    await card.getByRole('button', { name: 'Override…' }).click();
    await card.getByRole('listbox', { name: 'Give the ticket to' }).getByRole('option', { name: /Dev Malhotra/ }).waitFor();
    await card.getByRole('button', { name: 'Override…' }).click();
    checks.push('routing');

    // The availability switch in the toolbar.
    await page.getByLabel('Your availability').selectOption('busy');
    await waitFor(() => s.writes.some((w) => w.ep === '/api/v1/desk/engineers/me/status' && w.b.status === 'busy'), 'status');
    checks.push('availability');
    if (theme === 'light') await shot(page, 'desk-ai-1440.png');

    // The voice ticket: review below the threshold, the call with its transcript and recording, callback refused honestly.
    await page.getByRole('option', { name: /EMI debited twice/ }).click();
    const card2 = page.getByTestId('dai-routing');
    await card2.getByText('Below the 70% threshold — a person decides.').waitFor();
    await card2.getByRole('button', { name: 'Approve' }).click();
    await waitFor(() => s.writes.some((w) => w.ep === `/api/v1/desk/tickets/${T2}/review` && w.b.approve === true), 'review');
    const voice = page.getByTestId('dai-voice');
    await voice.getByText('Two EMI debits on the same day; wants one refunded.').waitFor();
    await voice.getByRole('button', { name: /recorded/ }).click();
    await voice.getByRole('list', { name: 'Transcript' }).getByText('My EMI got debited twice on the 5th.').waitFor();
    assert.equal(await voice.getByRole('button', { name: 'Play the recording' }).count(), 1);
    page.once('dialog', (d) => void d.accept('+91 98765 00000'));
    await voice.getByRole('button', { name: 'Call back' }).click();
    await waitFor(() => s.writes.some((w) => w.ep === `/api/v1/desk/tickets/${T2}/callback`), 'callback');
    await page.getByText('Phone calls are not set up yet', { exact: false }).first().waitFor();
    checks.push('voice');
    if (theme === 'dark') {
      await shot(page, 'desk-ai-1440-dark.png');
      const bg = await page.getByTestId('dai-voice').evaluate((e) => getComputedStyle(e).backgroundColor);
      const [r, gg, b] = bg.match(/\d+/g).map(Number); assert.ok(r < 50 && gg < 50 && b < 50, `dark card (${bg})`);
    }

    // Desk › Integrations.
    await page.getByRole('link', { name: 'Integrations' }).click();
    const dix = page.getByTestId('desk-integrations');
    await dix.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
    for (const h of ['WhatsApp Business', 'AI routing', 'Engineers', 'Voice agent · Sarvam AI', 'Recording and consent', 'Telephony', 'SLA policies', 'Inbound queue']) await dix.getByRole('heading', { name: h }).waitFor();
    await dix.getByText('does not support WhatsApp groups', { exact: false }).waitFor();
    await dix.getByText('Not connected').waitFor();
    assert.equal(await dix.getByLabel('Sarvam API key').inputValue(), '');   // write-only: never filled back
    await dix.getByText('respond 30m · resolve 8h').waitFor();
    await dix.getByText('WhatsApp did not give the file.').waitFor();
    await dix.getByLabel('Sarvam API key').fill('sk_fictional_key_0000111122223333');
    await dix.getByLabel('Accept within minutes').fill('15');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await waitFor(() => s.writes.some((w) => w.ep === '/api/v1/desk/settings' && w.b.acceptMinutes === 15 && w.b.sarvamApiKey === 'sk_fictional_key_0000111122223333'), 'settings saved');
    await page.getByText('Desk integrations saved.').waitFor();
    assert.equal(await dix.getByLabel('Sarvam API key').inputValue(), '');
    checks.push('integrations');
    if (theme === 'light') { await page.evaluate(() => { for (const el of [document.scrollingElement, ...document.querySelectorAll('main, #main-content, [class*="scroll"]')]) el?.scrollTo?.(0, 0); }); await page.waitForTimeout(3500); await shot(page, 'desk-integrations-1440.png'); }
    await ctx.close();
  }

  // Phone: the Desk ticket and Integrations at 390, no sideways scroll.
  {
    const s = state();
    const ctx = await make('light', s);
    const page = await ctx.newPage();
    watch(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/preview-org/desk?ticket=${T1}`);
    await page.getByTestId('dai-routing').getByText('86%').waitFor();
    await fitsPhone(page, 'Desk 390', assert);
    await page.getByTestId('dai-routing').scrollIntoViewIfNeeded();
    await shot(page, 'desk-ai-390.png');
    await page.goto(`${origin}/preview-org/desk/integrations`);
    await page.getByTestId('desk-integrations').getByRole('heading', { name: 'AI routing' }).waitFor();
    await fitsPhone(page, 'Integrations 390', assert);
    await shot(page, 'desk-integrations-390.png');
    checks.push('phone');
    await ctx.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, shots, errors }));
} finally { await browser.close(); }
