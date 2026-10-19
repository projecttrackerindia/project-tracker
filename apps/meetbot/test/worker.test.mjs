import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createServer } from '../src/server.mjs';
import { autoCapacity, machine } from '../src/worker.mjs';

// Worker mode against a synthetic API and the synthetic Meet page: the worker asks for a meeting, joins it, streams captions to the webhook,
// posts the chat the API hands it, reports how the bot is doing, and stops taking meetings when it drains.
const SECRET = 'test-secret-0123456789';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const until = async (check, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };

test('capacity follows the memory and CPUs the container may use', () => {
  assert.equal(autoCapacity({ memoryMb: 2048, cpus: 2 }), 2);
  assert.equal(autoCapacity({ memoryMb: 4096, cpus: 2 }), 4);
  assert.equal(autoCapacity({ memoryMb: 8192, cpus: 8 }), 14);
  assert.equal(autoCapacity({ memoryMb: 512, cpus: 1 }), 1);
  const limited = machine((p) => (p.endsWith('memory.max') ? String(3 * 1024 * 1024 * 1024) : '150000 100000'));
  assert.equal(limited.memoryMb <= 3072, true);
  assert.equal(limited.cpus <= 1.5, true);
});

test('a worker takes a meeting from the API, attends it, reports on it and drains', { timeout: 90_000 }, async () => {
  const page = await fs.readFile(new URL('./fake-meet.html', import.meta.url), 'utf8');
  const events = [], chat = [], reports = [];
  let ended = false, handedOut = false, chatSent = false, port = 0;
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/v1/agent/bot-workers/poll') {
        if (req.headers.authorization !== `Bearer ${SECRET}`) { res.writeHead(401); res.end(); return; }
        const r = JSON.parse(body); reports.push(r);
        const jobs = [];
        if (!handedOut && !r.draining) {
          handedOut = true;
          jobs.push({ jobId: '11111111-1111-1111-1111-111111111111', meetingUrl: `http://127.0.0.1:${port}/abc-defg-hij`, botName: 'Queue Bot',
            joinAt: new Date().toISOString(), leaveAt: new Date(Date.now() + 600_000).toISOString(), webhookUrl: `http://127.0.0.1:${port}/hook`,
            introMessage: 'Hello from the queue.', agendaMessage: null, captionLanguage: null, rejoin: false,
            raiseMessage: 'Asha asked me to raise: can refunds ship on Friday?', readChat: true });
        }
        const bots = (r.bots ?? []).map((b) => {
          const give = !chatSent && b.status === 'in_call_recording';
          if (give) chatSent = true;
          return { jobId: b.jobId, chat: give ? ['PAY-9 is overdue - who owns it?'] : [], stop: false };
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: { jobs, bots, pollSeconds: 5 } }));
        return;
      }
      if (req.url === '/hook') { events.push(JSON.parse(body)); res.end('{}'); return; }
      if (req.url === '/chat-log') { chat.push(body); res.end(); return; }
      if (req.url === '/lang-log') { res.end(); return; }
      if (req.url === '/control') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ended })); return; }
      res.setHeader('content-type', 'text/html'); res.end(page);
    });
  });
  port = await listen(fake);
  const server = createServer({ MEETBOT_SECRET: SECRET, MEETBOT_API_URL: `http://127.0.0.1:${port}`, MEETBOT_ALLOWED_HOSTS: '127.0.0.1', MEETBOT_ALLOW_HTTP: 'true',
    MEETBOT_HEADLESS: 'true', MEETBOT_QUIET: 'true', MEETBOT_ALONE_MS: '600000', MEETBOT_POLL_MS: '300', MEETBOT_MAX_BOTS: '2', MEETBOT_CAPTION_FLUSH_MS: '400', MEETBOT_WORKER_ID: 'worker-test-1',
    ...(process.env.MEETBOT_CHROMIUM ? { MEETBOT_CHROMIUM: process.env.MEETBOT_CHROMIUM } : {}) });
  const botPort = await listen(server);
  try {
    // It introduces itself with its capacity, takes the meeting and reports the bot until the call.
    await until(() => reports.length > 0);
    assert.equal(reports[0].workerId, 'worker-test-1');
    assert.equal(reports[0].capacity, 2);
    assert.equal(reports[0].draining, false);
    await until(() => reports.some((r) => r.bots.some((b) => b.jobId === '11111111-1111-1111-1111-111111111111' && b.status === 'in_call_recording')));
    await until(() => chat.length >= 3);
    assert.equal(chat[0], 'Hello from the queue.');
    assert.equal(chat[1], 'Asha asked me to raise: can refunds ship on Friday?');   // what the person who sent the agent wanted raised
    assert.equal(chat[2], 'PAY-9 is overdue - who owns it?');   // handed over by the API, posted in the meeting
    await until(() => events.some((e) => e.event === 'transcript.batch' && e.data.lines.length > 0));
    // The chat is read: someone's question goes to the API (the bot's own messages do not).
    const asked = await until(() => events.find((e) => e.event === 'chat.message'));
    assert.equal(asked.data.name, 'Priya');
    assert.equal(asked.data.text, 'agent, where is PAY-9?');
    assert.ok(!events.some((e) => e.event === 'chat.message' && e.data.name === 'You'));
    const health = await (await fetch(`http://127.0.0.1:${botPort}/health`)).json();
    assert.equal(health.worker.id, 'worker-test-1');
    assert.equal(health.bots, 1);

    // The call ends: the worker reports it, and stops reporting the bot a while later.
    ended = true;
    await until(() => reports.some((r) => r.bots.some((b) => b.status === 'done')));

    // Draining (a redeploy): no new meetings are taken, and it says it is done once nothing is running.
    let drained = false;
    server.worker.drain(() => { drained = true; });
    await until(() => drained);
    assert.ok(reports.at(-1).draining);
  } finally {
    for (const b of server.bots.values()) b.stop();
    server.close(); fake.close();
  }
});
