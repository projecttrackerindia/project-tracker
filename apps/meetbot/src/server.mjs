import http from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MeetBot } from './bot.mjs';
import { startWorker } from './worker.mjs';

/**
 * Project Tracker's own meeting bot service. The API calls it (with the shared secret) to send a bot into a Google Meet; the bot streams the
 * captions to the API's webhook and posts chat messages when asked.
 *
 *   POST   /bots            { meetingUrl, botName, joinAt?, leaveAt?, webhookUrl, introMessage?, agendaMessage?, captionLanguage? } -> 201 { id, status }
 *   GET    /bots/:id        -> { id, status, error, lines }            (404 once forgotten - treat as ended)
 *   POST   /bots/:id/chat   { message }                                -> 202
 *   DELETE /bots/:id        -> 202 (leaves)
 *   GET    /health          -> { ok, bots, capacity, worker? }
 *
 * With MEETBOT_API_URL set it also works as a queue worker (see worker.mjs): it asks the API for meetings itself, so several replicas can run.
 */
export function createServer(env = process.env) {
  const secret = env.MEETBOT_SECRET ?? '';
  const capacity = Number(env.MEETBOT_MAX_BOTS ?? 4);
  const allowedHosts = (env.MEETBOT_ALLOWED_HOSTS ?? 'meet.google.com').split(',').map((s) => s.trim()).filter(Boolean);
  const webhookHosts = (env.MEETBOT_WEBHOOK_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const log = (m) => { if (env.MEETBOT_QUIET !== 'true') console.log(`${new Date().toISOString()} ${m}`); };
  const bots = new Map();

  // Read at each launch: the virtual screen may have gone away since the service started (then bots run headless).
  const launch = () => chromium.launch({
    headless: env.MEETBOT_HEADLESS === 'true',
    ...(env.MEETBOT_CHROMIUM ? { executablePath: env.MEETBOT_CHROMIUM } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const deps = {
    launch, log,
    admitTimeoutMs: Number(env.MEETBOT_ADMIT_TIMEOUT_MS ?? 10 * 60_000),
    aloneMs: Number(env.MEETBOT_ALONE_MS ?? 5 * 60_000),
    captionFlushMs: Number(env.MEETBOT_CAPTION_FLUSH_MS ?? 3000),
    // A finished bot is kept for an hour so the API can read how it ended, then forgotten.
    onFinished: (bot) => setTimeout(() => bots.delete(bot.id), Number(env.MEETBOT_KEEP_MS ?? 3600_000)).unref?.(),
  };

  const authorized = (req) => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(secret);
    return secret.length >= 16 && given.length === want.length && timingSafeEqual(given, want);
  };
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
  const urlOk = (value, hosts, protocols) => {
    try { const u = new URL(value); return protocols.includes(u.protocol) && (hosts.length === 0 || hosts.includes(u.hostname) || hosts.includes(u.host)); } catch { return false; }
  };
  const active = () => [...bots.values()].filter((b) => !['done', 'fatal'].includes(b.status)).length;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bot');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const w = server.worker;
        return send(res, 200, { ok: true, bots: active(), capacity: w ? w.state.capacity : capacity,
          ...(w ? { worker: { id: w.state.workerId, draining: w.state.draining, lastReport: w.state.lastOk, lastError: w.state.lastError } } : {}) });
      }
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/bots') {
        const b = await readJson(req);
        if (!urlOk(b.meetingUrl, allowedHosts, ['https:', ...(env.MEETBOT_ALLOW_HTTP === 'true' ? ['http:'] : [])])) return send(res, 422, { error: 'meetingUrl must be a Google Meet link' });
        if (!urlOk(b.webhookUrl, webhookHosts, ['https:', ...(env.MEETBOT_ALLOW_HTTP === 'true' ? ['http:'] : [])])) return send(res, 422, { error: 'webhookUrl is not allowed' });
        if (active() >= capacity) return send(res, 429, { error: `The bot service is in ${capacity} meetings already.` });
        const bot = new MeetBot({ meetingUrl: b.meetingUrl, botName: String(b.botName || 'Project Tracker Agent').slice(0, 60), joinAt: b.joinAt, leaveAt: b.leaveAt,
          webhookUrl: b.webhookUrl, introMessage: b.introMessage ? String(b.introMessage).slice(0, 500) : null,
          agendaMessage: b.agendaMessage ? String(b.agendaMessage).slice(0, 500) : null,
          captionLanguage: typeof b.captionLanguage === 'string' && /^[\p{L} ()-]{2,40}$/u.test(b.captionLanguage) ? b.captionLanguage : null }, deps);
        bots.set(bot.id, bot);
        log(`bot ${bot.id.slice(0, 8)} scheduled for ${bot.joinAt.toISOString()}`);
        return send(res, 201, bot.summary);
      }
      const bot = parts[0] === 'bots' && parts[1] ? bots.get(parts[1]) : null;
      if (parts[0] === 'bots' && !bot) return send(res, 404, { error: 'not found' });
      if (bot && req.method === 'GET' && parts.length === 2) return send(res, 200, bot.summary);
      if (bot && req.method === 'POST' && parts[2] === 'chat') {
        const b = await readJson(req);
        if (!b.message || typeof b.message !== 'string') return send(res, 422, { error: 'message is required' });
        return bot.chat(b.message) ? send(res, 202, { queued: true }) : send(res, 409, { error: `The bot is ${bot.status}, not in the call.` });
      }
      if (bot && req.method === 'DELETE' && parts.length === 2) { bot.stop(); return send(res, 202, bot.summary); }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e).slice(0, 200) });
    }
  });
  server.bots = bots;
  if (env.MEETBOT_API_URL) server.worker = startWorker({ env, log, deps, bots, allowedHosts });
  const close = server.close.bind(server);
  server.close = (cb) => { server.worker?.stop(); return close(cb); };
  return server;
}

/**
 * A real (non-headless) browser needs a screen: start a virtual one (Xvfb) unless there is a display already. If it cannot start or stops,
 * bots fall back to headless Chromium rather than the service failing.
 */
export function startVirtualScreen(env = process.env, log = console.log) {
  if (env.MEETBOT_HEADLESS === 'true' || env.DISPLAY) return;
  const display = env.MEETBOT_DISPLAY ?? ':99';
  const fallBack = (why) => { if (env.MEETBOT_HEADLESS !== 'true') { env.MEETBOT_HEADLESS = 'true'; log(`virtual screen ${why}; bots run headless`); } };
  try {
    const x = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
    x.stderr.on('data', (d) => { const t = String(d).trim(); if (/fatal|cannot|error/i.test(t)) log(`Xvfb: ${t.slice(0, 300)}`); });
    x.on('error', (e) => fallBack(`could not start (${e.message})`));
    x.on('exit', (code) => fallBack(`stopped (${code})`));
    x.unref();
    env.DISPLAY = display;
    log(`virtual screen ${display}`);
  } catch (e) { fallBack(`could not start (${e.message})`); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log('meeting bot service starting');
  process.on('uncaughtException', (e) => console.error(`uncaught: ${e?.stack ?? e}`));
  process.on('unhandledRejection', (e) => console.error(`unhandled: ${e?.stack ?? e}`));
  const port = Number(process.env.PORT ?? 8080);
  if ((process.env.MEETBOT_SECRET ?? '').length < 16) { console.error('Set MEETBOT_SECRET (at least 16 characters).'); process.exit(1); }
  startVirtualScreen();
  const server = createServer();
  // Every interface, IPv4 and IPv6 (the host's health check and private network may use either); IPv4 alone where there is no IPv6.
  server.on('error', (e) => {
    if (e.code === 'EAFNOSUPPORT' && !server.listening) { server.listen(port, '0.0.0.0'); return; }
    console.error(`cannot listen on :${port}: ${e.message}`); process.exit(1);
  });
  server.on('listening', () => console.log(`meeting bot service on ${JSON.stringify(server.address())}`));
  server.listen(port, '::');
  // A redeploy: stop taking meetings, stay in the current ones until they end (the platform's draining time), then exit.
  let terminating = false;
  process.on('SIGTERM', () => {
    if (terminating) return; terminating = true;
    if (!server.worker) { console.log('stopping'); process.exit(0); }
    console.log('SIGTERM: finishing current meetings before exiting');
    server.worker.drain(() => { console.log('all meetings finished; exiting'); process.exit(0); });
  });
}
