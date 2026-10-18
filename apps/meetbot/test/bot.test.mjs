import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createServer } from '../src/server.mjs';

// The whole bot against a synthetic Meet page (test/fake-meet.html) on this machine: join, captions to the webhook, chat, the call ending.
const SECRET = 'test-secret-0123456789';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const until = async (check, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };

test('a bot joins, reports who said what, posts in the chat and leaves when the call ends', { timeout: 90_000 }, async () => {
  const page = await fs.readFile(new URL('./fake-meet.html', import.meta.url), 'utf8');
  const events = [], chat = [];
  let ended = false;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/hook') { events.push(JSON.parse(body)); res.end('{}'); return; }
      if (req.url === '/chat-log') { chat.push(body); res.end(); return; }
      if (req.url === '/control') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ended })); return; }
      res.setHeader('content-type', 'text/html'); res.end(page);
    });
  });
  const fakePort = await listen(fake);
  const bots = createServer({ MEETBOT_SECRET: SECRET, MEETBOT_ALLOWED_HOSTS: '127.0.0.1', MEETBOT_WEBHOOK_HOSTS: '127.0.0.1', MEETBOT_ALLOW_HTTP: 'true', MEETBOT_HEADLESS: 'true',
    MEETBOT_QUIET: 'true', MEETBOT_ALONE_MS: '600000', ...(process.env.MEETBOT_CHROMIUM ? { MEETBOT_CHROMIUM: process.env.MEETBOT_CHROMIUM } : {}) });
  const botPort = await listen(bots);
  const api = (method, path, body, key = SECRET) => fetch(`http://127.0.0.1:${botPort}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${botPort}/health`)).status, 200);
    assert.equal((await api('POST', '/bots', {}, 'wrong-secret-0123456789')).status, 401);
    assert.equal((await api('POST', '/bots', { meetingUrl: 'https://evil.example/abc', webhookUrl: `http://127.0.0.1:${fakePort}/hook` })).status, 422);

    const created = await api('POST', '/bots', { meetingUrl: `http://127.0.0.1:${fakePort}/abc-defg-hij`, botName: 'Tracker Bot', webhookUrl: `http://127.0.0.1:${fakePort}/hook`,
      introMessage: "Hi, I'm the Tracker Bot taking notes." });
    assert.equal(created.status, 201);
    const { id } = await created.json();

    await until(async () => (await (await api('GET', `/bots/${id}`)).json()).status === 'in_call_recording');
    assert.equal((await api('POST', `/bots/${id}/chat`, { message: 'PAY-9 is overdue - who owns it?' })).status, 202);

    const lines = () => events.filter((e) => e.event === 'transcript.data').map((e) => `${e.data.data.participant.name}: ${e.data.data.words.map((w) => w.text).join(' ')}`);
    await until(() => lines().some((l) => l.startsWith('Ravi Kumar: I finished the gateway sandbox')));
    await until(() => chat.length >= 2);
    assert.equal(chat[0], "Hi, I'm the Tracker Bot taking notes.");
    assert.equal(chat[1], 'PAY-9 is overdue - who owns it?');

    await until(() => lines().some((l) => l.startsWith('Priya: Who is doing the refund flow?')));
    ended = true;
    await until(async () => (await (await api('GET', `/bots/${id}`)).json()).status === 'done');
    assert.ok(!lines().some((l) => l.includes('Ravi Kumar: I finished') && l.includes('Priya')), 'one line per speaker block');
    const statuses = events.filter((e) => e.event === 'bot.status').map((e) => e.data.status);
    for (const s of ['joining', 'waiting_admission', 'in_call_recording', 'call_ended', 'done']) assert.ok(statuses.includes(s), `${s} in ${statuses}`);
    assert.equal((await api('POST', `/bots/${id}/chat`, { message: 'late' })).status, 409);
  } finally {
    for (const b of bots.bots.values()) b.stop();
    bots.close(); fake.close();
  }
});
