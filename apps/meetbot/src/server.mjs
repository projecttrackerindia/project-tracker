import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MeetBot } from './bot.mjs';

/**
 * Project Tracker's own meeting bot service. The API calls it (with the shared secret) to send a bot into a Google Meet; the bot streams the
 * captions to the API's webhook and posts chat messages when asked.
 *
 *   POST   /bots            { meetingUrl, botName, joinAt?, leaveAt?, webhookUrl, introMessage?, agendaMessage?, captionLanguage? } -> 201 { id, status }
 *   GET    /bots/:id        -> { id, status, error, lines }            (404 once forgotten - treat as ended)
 *   POST   /bots/:id/chat   { message }                                -> 202
 *   DELETE /bots/:id        -> 202 (leaves)
 *   GET    /health          -> { ok, bots, capacity }
 */
export function createServer(env = process.env) {
  const secret = env.MEETBOT_SECRET ?? '';
  const capacity = Number(env.MEETBOT_MAX_BOTS ?? 4);
  const allowedHosts = (env.MEETBOT_ALLOWED_HOSTS ?? 'meet.google.com').split(',').map((s) => s.trim()).filter(Boolean);
  const webhookHosts = (env.MEETBOT_WEBHOOK_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const headless = env.MEETBOT_HEADLESS === 'true';
  const log = (m) => { if (env.MEETBOT_QUIET !== 'true') console.log(`${new Date().toISOString()} ${m}`); };
  const bots = new Map();

  const launch = () => chromium.launch({
    headless,
    ...(env.MEETBOT_CHROMIUM ? { executablePath: env.MEETBOT_CHROMIUM } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  const deps = {
    launch, log,
    admitTimeoutMs: Number(env.MEETBOT_ADMIT_TIMEOUT_MS ?? 10 * 60_000),
    aloneMs: Number(env.MEETBOT_ALONE_MS ?? 5 * 60_000),
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
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, bots: active(), capacity });
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
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 8080);
  if ((process.env.MEETBOT_SECRET ?? '').length < 16) { console.error('Set MEETBOT_SECRET (at least 16 characters).'); process.exit(1); }
  createServer().listen(port, () => console.log(`meeting bot service on :${port}`));
}
