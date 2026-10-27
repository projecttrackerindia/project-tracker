import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { appCsp } from './lib/csp.mjs';

// Chat upgrades on screen: questions waiting for me, a pinned message, a task key as a live card, a voice note with its transcript, a
// poll (vote, then close with a decision), a thread beside the conversation (reply in it), suggested replies, AI rewrite of the draft,
// send later, a task made from a message (and linked to it), pin, catch me up, ask the chat, status and do not disturb, and the phone.
// Built frontend, synthetic API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/chat-upgrades-ui');
await fs.mkdir(out, { recursive: true });
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Alex Morgan', email: 'alex@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 3 };
const sam = { userId: '00000000-0000-0000-0000-000000000003', name: 'Sam Rivera', role: 'Member', online: true, lastReadAt: new Date().toISOString(), statusEmoji: '🌴', statusText: 'On leave till Monday', dnd: false };
const priya = { userId: '00000000-0000-0000-0000-000000000004', name: 'Priya Rao', role: 'Member', online: false, lastReadAt: new Date().toISOString() };
const conv = { id: '00000000-0000-0000-0000-000000000010', type: 'Group', name: 'Collections', members: [sam, priya, { userId: user.id, name: user.displayName, role: 'Admin', online: true, lastReadAt: new Date().toISOString() }],
  unread: 0, isMuted: false, canManage: true, otherUserId: null, projectId: null, unreadMentions: 0, lastMessage: null, lastActivityAt: new Date().toISOString() };
const pid = '00000000-0000-0000-0000-000000000020';
const at = (m) => new Date(Date.now() - m * 60000).toISOString();
const id = (n) => '00000000-0000-0000-0000-0000000001' + String(n).padStart(2, '0');
const M = (n, who, body, mins, extra = {}) => ({ id: id(n), conversationId: conv.id, senderId: who.userId ?? who.id, senderName: who.name ?? who.displayName, kind: 'User', replyTo: null, editedAt: null, body,
  createdAt: at(mins), attachments: null, reactions: null, isDeleted: false, threadRootId: null, threadReplies: 0, threadLastAt: null, pinnedAt: null, pinnedBy: null, saved: false, asksMe: false, poll: null, linked: null, ...extra });
const poll = { id: 'poll-1', question: 'Where should the offsite be?', options: [{ index: 0, text: 'Goa', votes: 1, mine: false, names: ['Sam Rivera'] }, { index: 1, text: 'Coorg', votes: 0, mine: false, names: [] }],
  multiple: false, closesAt: null, closedAt: null, decision: null, voters: 1, canClose: true };
let items = [
  M(1, sam, 'We agreed to move the EMI reminder to 9 am', 60, { pinnedAt: at(50), pinnedBy: 'Priya Rao' }),
  M(2, priya, `@[Alex Morgan](${user.id}) can you approve the template by Friday? It is in PAY-12`, 40, { asksMe: true, threadReplies: 2, threadLastAt: at(10) }),
  M(3, user, 'Where should the offsite be?', 30, { kind: 'Poll', poll }),
  M(4, sam, '', 20, { attachments: [{ id: 'voice-1', fileName: 'Voice note.wav', contentType: 'audio/wav', sizeBytes: 3200, isImage: false, isVoice: true, transcript: 'రేపు ఉదయం కాల్ చేస్తాను', transcriptLanguage: 'te-IN', durationSeconds: 7 }] }),
  M(5, user, 'Sure, will check', 5, { linked: [{ kind: 'task', id: 't13', key: 'PAY-13', title: 'Check template wording' }] }),
];
const replies = [M(31, sam, 'I looked at it already, looks fine', 15, { threadRootId: id(2) }), M(32, priya, 'Thanks Sam', 10, { threadRootId: id(2) })];
const wav = (() => { const b = Buffer.alloc(44 + 1600); b.write('RIFF', 0); b.writeUInt32LE(36 + 1600, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(1600, 40); return b; })();
let myStatus = { emoji: null, text: null, clearAt: null, dndUntil: null, dnd: false };
const writes = [], errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (opts = {}) => {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...opts });
    await ctx.addInitScript(() => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', 'light'); });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) { const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep)); await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } }); return; }
      if (ep === '/api/v1/chat/files/voice-1') { await route.fulfill({ contentType: 'audio/wav', body: wav }); return; }
      const json = (d) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: d }) });
      const b = method === 'GET' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
      if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ method, ep, b });
      const msg = (n) => items.find((m) => m.id === id(n));
      if (ep === `/api/v1/chat/conversations/${conv.id}/messages` && method === 'POST') {
        const m = M(90 + writes.length, user, b.body, 0, { threadRootId: b.threadRootId ?? null });
        if (!b.threadRootId) items = [...items, m]; else replies.push(m);
        await json(m); return;
      }
      if (ep === '/api/v1/chat/polls/poll-1/vote') { const p = { ...poll, voters: 2, options: poll.options.map((o) => (b.options.includes(o.index) ? { ...o, votes: o.votes + 1, mine: true, names: [...o.names, 'Alex Morgan'] } : o)) }; items = items.map((m) => (m.id === id(3) ? { ...m, poll: p } : m)); await json(msg(3)); return; }
      if (ep === '/api/v1/chat/polls/poll-1/close') { const p = { ...msg(3).poll, closedAt: at(0), decision: b.decision || 'Coorg', canClose: false }; items = items.map((m) => (m.id === id(3) ? { ...m, poll: p } : m)); await json(msg(3)); return; }
      if (/\/api\/v1\/chat\/messages\/[\w-]+\/(pin|save)$/.test(ep)) { const n = Number(ep.split('/')[5].slice(-2)); const on = method === 'PUT'; const kind = ep.endsWith('pin') ? 'pin' : 'save';
        items = items.map((m) => (m.id === id(n) ? { ...m, ...(kind === 'pin' ? { pinnedAt: on ? at(0) : null, pinnedBy: on ? 'Alex Morgan' : null } : { saved: on }) } : m)); await json(msg(n)); return; }
      if (ep === `/api/v1/chat/messages/${id(2)}/replies`) { await json({ replies: ['Approving it today', 'Can I see it first?', 'Will do by Friday'], model: 'test' }); return; }
      if (ep === `/api/v1/chat/messages/${id(2)}/extract`) { await json({ kind: b.kind, title: 'Approve the new template', description: 'can you approve the template by Friday? It is in PAY-12', due: '2026-10-30', priority: 'High', assigneeId: user.id, assigneeName: user.displayName, projectId: null, byAi: true }); return; }
      if (ep === `/api/v1/projects/${pid}/tasks` && method === 'POST') { await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { id: 't99', key: 'PAY-99', title: b.title } }) }); return; }
      if (ep === `/api/v1/chat/messages/${id(2)}/links`) { items = items.map((m) => (m.id === id(2) ? { ...m, linked: [{ kind: 'task', id: 't99', key: 'PAY-99', title: 'Approve the new template' }] } : m)); await json(msg(2)); return; }
      if (ep === '/api/v1/chat/ai/transform') { await json({ text: 'Dear team, I will review the document by Friday.', blocks: null, model: 'test', inline: true }); return; }
      if (ep === `/api/v1/chat/conversations/${conv.id}/scheduled` && method === 'POST') { await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { id: 's1', conversationId: conv.id, conversationName: conv.name, body: b.body, sendAt: b.sendAt, status: 'Scheduled', threadRootId: null, error: null } }) }); return; }
      if (ep === '/api/v1/chat/ai/catch-up') { await json({ summary: 'The EMI reminder moves to 9 am, and Priya needs your approval of the template.', decisions: [{ text: 'EMI reminder at 9 am', messageId: id(1), conversationId: conv.id, conversationName: 'Collections' }], questions: [{ text: 'Approve the template by Friday', messageId: id(2), conversationId: conv.id, conversationName: 'Collections' }], actions: [], conversations: 1, messages: 4, model: 'test' }); return; }
      if (ep === '/api/v1/chat/ai/ask') { await json({ answer: 'The EMI reminder is sent at 9 am [1].', citations: [{ n: 1, messageId: id(1), conversationId: conv.id, conversationName: 'Collections', senderName: 'Sam Rivera', at: at(60), snippet: 'We agreed to move the EMI reminder to 9 am', threadRootId: null }], searched: 3, found: true, model: 'test' }); return; }
      // Remembered, like the server: the app refetches the status right after saving it.
      if (ep === '/api/v1/chat/status' && method === 'PUT') { myStatus = { emoji: b.emoji ?? null, text: b.text ?? null, clearAt: b.clearAt ?? null, dndUntil: b.dndUntil ?? null, dnd: !!b.dndUntil }; await json(myStatus); return; }
      if (method !== 'GET' && !ep.endsWith('/auth/refresh') && !ep.endsWith('/read')) assert.fail(`Unexpected write: ${method} ${ep}`);
      let data = [];
      if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'projects.view', 'projects.edit', 'docs.create'], modules: { projects: 3, tasks: 3, work: 3, ai: 3, people: 3, documents: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3, CHAT_ATTACHMENTS: 1 } } };
      else if (ep === '/api/v1/chat/conversations') data = [conv];
      else if (ep === `/api/v1/chat/conversations/${conv.id}`) data = conv;
      else if (ep === `/api/v1/chat/conversations/${conv.id}/messages`) data = { items, hasMore: false };
      else if (ep === `/api/v1/chat/conversations/${conv.id}/pins`) data = items.filter((m) => m.pinnedAt);
      else if (ep === `/api/v1/chat/messages/${id(2)}/thread`) data = { root: msg(2), replies: [...replies] };
      else if (ep === '/api/v1/chat/unfurl') data = url.searchParams.get('keys').includes('PAY-12') ? [{ key: 'PAY-12', kind: 'task', id: 't12', title: 'New reminder template', status: 'In review', statusColor: '#d97706', assignee: 'Priya Rao', due: '2026-10-30', done: false, link: `/projects/${pid}?task=t12` }] : [];
      else if (ep === '/api/v1/chat/questions') data = [{ messageId: id(2), conversationId: conv.id, conversationName: 'Collections', senderName: 'Priya Rao', snippet: '@Alex Morgan can you approve the template by Friday?', at: at(40), threadRootId: null }];
      else if (ep === '/api/v1/chat/status') data = myStatus;
      else if (ep === '/api/v1/projects') data = { items: [{ id: pid, key: 'PAY', name: 'Payments Core', status: 'Active' }], page: 1, totalPages: 1, totalItems: 1 };
      else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
      else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
      else if (ep === '/api/v1/timer') data = null;
      else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
      else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
      await json(data);
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name) }); };
  const openMore = async (page, n) => {
    await page.mouse.move(5, 5);
    await page.locator(`[data-msg="${id(n)}"] .bubble`).hover({ force: true });
    await page.locator(`[data-msg="${id(n)}"]`).getByRole('button', { name: 'More actions' }).click({ force: true });
  };
  const waitWrite = async (pred, what) => { for (let i = 0; i < 60; i++) { if (writes.some(pred)) return writes.find(pred); await new Promise((r) => setTimeout(r, 100)); } assert.fail(`no ${what}`); };
  let ctx = await make(); let page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('STACK', e.stack?.split('\n').slice(0, 5).join(' | ')); });
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.goto(`${origin}/preview-org/chat/${conv.id}`);
  await page.locator('.composer').waitFor();

  // What is waiting for me, what is pinned, a key as a live card, a voice note, a link to what was made.
  await page.locator('.q-box', { hasText: 'Waiting for your answer' }).waitFor();
  await page.locator(`[data-msg="${id(2)}"] .asks-flag`).waitFor();
  await page.locator(`[data-msg="${id(1)}"] .pin-flag`).waitFor();
  await page.locator(`[data-msg="${id(2)}"] .unfurl`, { hasText: 'New reminder template' }).waitFor();
  assert.match(await page.locator(`[data-msg="${id(2)}"] .unfurl`).textContent(), /In review.*Priya Rao/);
  await page.locator(`[data-msg="${id(4)}"] .voice-text`, { hasText: 'Telugu' }).waitFor();
  await page.locator(`[data-msg="${id(4)}"] .voice-play`).click();
  await page.locator(`[data-msg="${id(4)}"] audio`).waitFor();
  await page.locator(`[data-msg="${id(5)}"] .msg-link`, { hasText: 'PAY-13' }).waitFor();
  await page.locator('.chat-head', { hasText: 'Collections' }).waitFor();
  await shot(page, 'conversation-1440.png'); checks.push('questions', 'pinned', 'live-card', 'voice-note', 'linked');

  // A poll: vote, then close it with a decision.
  await page.locator(`[data-msg="${id(3)}"] .poll-opt`, { hasText: 'Coorg' }).click();
  assert.deepEqual((await waitWrite((w) => w.ep.endsWith('/vote'), 'vote')).b, { options: [1] });
  await page.locator(`[data-msg="${id(3)}"] .poll-opt.mine`, { hasText: 'Coorg' }).waitFor();
  await page.locator(`[data-msg="${id(3)}"]`).getByRole('button', { name: 'Close and decide' }).click();
  await page.getByLabel('Decision').fill('Coorg, first week of December');
  await page.getByRole('button', { name: 'Close poll' }).click();
  assert.equal((await waitWrite((w) => w.ep.endsWith('/close'), 'close')).b.decision, 'Coorg, first week of December');
  await page.locator(`[data-msg="${id(3)}"] .poll-decision`, { hasText: 'Coorg, first week of December' }).waitFor(); checks.push('poll');

  // A thread beside the conversation; a reply there stays in the thread.
  await page.locator(`[data-msg="${id(2)}"] .thread-link`, { hasText: '2 replies' }).click();
  const side = page.locator('aside.thread-side');
  await side.locator('.msg', { hasText: 'Thanks Sam' }).waitFor();
  await side.locator('.composer-editable').click(); await page.keyboard.type('Approved, thanks both'); await page.keyboard.press('Enter');
  assert.equal((await waitWrite((w) => w.method === 'POST' && w.ep.endsWith('/messages') && w.b.body === 'Approved, thanks both', 'thread reply')).b.threadRootId, id(2));
  await side.locator('.msg', { hasText: 'Approved, thanks both' }).waitFor();
  assert.equal(await page.locator('.chat-messages').first().locator('.msg', { hasText: 'Approved, thanks both' }).count(), 0, 'the reply is not in the conversation');
  await shot(page, 'thread-1440.png');
  await side.getByRole('button', { name: 'Close thread' }).click(); checks.push('thread');

  // Suggested replies fill the composer; AI rewrites the draft; send later.
  await openMore(page, 2);
  await page.getByRole('menuitem', { name: /Suggest replies/ }).click();
  await page.locator('.smart-reply', { hasText: 'Approving it today' }).click();
  await page.waitForFunction(() => document.querySelector('.chat-thread > .composer .composer-editable')?.textContent?.includes('Approving it today'));
  checks.push('smart-replies');
  await page.locator('.chat-thread > .composer .composer-editable').click();
  await page.keyboard.press('Control+a'); await page.keyboard.type('i will check the doc by friday');
  await page.getByRole('button', { name: 'Rewrite or translate with AI' }).click();
  await page.getByRole('menuitem', { name: 'More formal' }).click();
  assert.equal((await waitWrite((w) => w.ep === '/api/v1/chat/ai/transform', 'rewrite')).b.action, 'formal');
  await page.waitForFunction(() => document.querySelector('.chat-thread > .composer .composer-editable')?.textContent?.includes('Dear team'));
  checks.push('ai-rewrite');
  await page.getByRole('button', { name: 'More: poll, send later' }).click();
  await page.getByRole('menuitem', { name: /Send later/ }).click();
  await page.getByRole('button', { name: 'Monday 9 am' }).click();
  await page.getByRole('button', { name: 'Schedule' }).click();
  const scheduled = await waitWrite((w) => w.ep.endsWith('/scheduled'), 'schedule');
  assert.match(scheduled.b.body, /Dear team/);
  assert.ok(new Date(scheduled.b.sendAt) > new Date(), 'scheduled for later');
  await page.waitForFunction(() => !document.querySelector('.chat-thread > .composer .composer-editable')?.textContent?.trim());
  checks.push('send-later');

  // A task made from a message, linked back to it; pin a message.
  // "Make task" sits beside the bubble (v2), next to Reply.
  await page.mouse.move(5, 5);
  await page.locator(`[data-msg="${id(2)}"] .bubble`).hover({ force: true });
  await page.locator(`[data-msg="${id(2)}"]`).getByRole('button', { name: 'Make task' }).click({ force: true });
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Title').waitFor();
  assert.equal(await dlg.getByLabel('Title').inputValue(), 'Approve the new template');
  await dlg.getByLabel('Project').selectOption(pid);
  await shot(page, 'make-task-1440.png');
  await dlg.getByRole('button', { name: 'Create task' }).click();
  const created = await waitWrite((w) => w.ep === `/api/v1/projects/${pid}/tasks`, 'task');
  assert.equal(created.b.priority, 'High'); assert.equal(created.b.dueDate, '2026-10-30'); assert.equal(created.b.assigneeId, user.id);
  assert.deepEqual((await waitWrite((w) => w.ep.endsWith('/links'), 'link')).b, { kind: 'task', id: 't99' });
  await page.locator(`[data-msg="${id(2)}"] .msg-link`, { hasText: 'PAY-99' }).waitFor(); checks.push('make-task');
  await openMore(page, 5);
  await page.getByRole('menuitem', { name: /Pin to the conversation/ }).click();
  await waitWrite((w) => w.method === 'PUT' && w.ep.endsWith(`${id(5)}/pin`), 'pin');
  await page.locator(`[data-msg="${id(5)}"] .pin-flag`).waitFor(); checks.push('pin');

  // Catch me up, ask the chat, status.
  // v2: Talk's thread keeps these in its ··· (Conversation actions); the list's ··· is "More in Talk".
  await page.getByRole('button', { name: 'Conversation actions' }).click(); await page.getByRole('menuitem', { name: /^Catch me up/ }).click();
  const cu = page.getByRole('dialog');
  await cu.locator('.cu-summary', { hasText: '9 am' }).waitFor();
  await cu.locator('.cu-sec', { hasText: 'Approve the template by Friday' }).waitFor();
  await shot(page, 'catch-up-1440.png');
  await cu.getByRole('button', { name: 'Close' }).last().click(); checks.push('catch-up');
  await page.getByRole('button', { name: 'More in Talk' }).click();
  await page.getByRole('menuitem', { name: /Ask the chat/ }).click();
  const ask = page.getByRole('dialog');
  await ask.getByLabel('Question').fill('When is the EMI reminder sent?');
  await ask.getByRole('button', { name: 'Ask' }).click();
  await ask.locator('.ask-answer', { hasText: '9 am' }).waitFor();
  await ask.locator('.ask-sources', { hasText: 'Collections' }).waitFor();
  await ask.getByRole('button', { name: 'Close' }).last().click(); checks.push('ask-the-chat');
  await page.getByRole('button', { name: 'Your status' }).click();
  const st = page.getByRole('dialog');
  await st.getByRole('button', { name: '🌴 On leave' }).click();
  await st.getByRole('button', { name: '1 hour' }).click();
  await st.getByRole('button', { name: 'Save' }).click();
  const status = await waitWrite((w) => w.method === 'PUT' && w.ep === '/api/v1/chat/status', 'status');
  assert.equal(status.b.text, 'On leave'); assert.ok(status.b.dndUntil, 'do not disturb set');
  await page.locator('.status-btn.dnd').waitFor(); checks.push('status-dnd');
  await shot(page, 'list-1440.png');
  await page.close(); await ctx.close();

  // Nothing open: "While you were away" - decisions on request, the first question waiting for me, the latest file; in light and dark.
  ctx = await make(); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.goto(`${origin}/preview-org/chat`);
  await page.locator('[data-testid="chat-away"] .chat-away-tile', { hasText: 'Priya needs an answer from you' }).waitFor();
  assert.equal(await page.locator('.chat-away-title').innerText(), 'While you were away');
  assert.deepEqual(await page.locator('.chat-away-tile small').allInnerTexts(), ['Decisions', 'Questions for you', 'Files']);
  await shot(page, 'away-1440.png');
  await page.evaluate(()=>{try{localStorage.setItem('pm_theme','dark')}catch{}});await page.reload();await page.waitForTimeout(1200);
  await page.locator('[data-testid="chat-away"]').waitFor();
  await shot(page, 'away-dark-1440.png');
  await page.locator('[data-testid="chat-away"] .chat-away-tile', { hasText: 'Priya needs an answer from you' }).click();
  await page.locator('.composer').waitFor(); await page.waitForTimeout(500);
  await shot(page, 'conversation-dark-1440.png'); checks.push('while-away');
  await page.close(); await ctx.close();

  // Phone: the conversation and a thread fit the screen.
  ctx = await make({ hasTouch: true, isMobile: true }); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/preview-org/chat/${conv.id}?thread=${id(2)}`);
  await page.locator('aside.thread-side .msg', { hasText: 'Thanks Sam' }).waitFor();
  await fitsPhone(page, 'thread on a phone', assert);
  await shot(page, 'thread-390.png');
  await page.goto(`${origin}/preview-org/chat`);
  await page.locator('.q-box').waitFor();
  await fitsPhone(page, 'chat list on a phone', assert);
  await shot(page, 'list-390.png'); checks.push('phone');
  await page.close(); await ctx.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
