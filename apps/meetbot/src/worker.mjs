import { readFileSync } from 'node:fs';
import { availableParallelism, hostname, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { MeetBot } from './bot.mjs';
import { LiveKitBot } from './livekit.mjs';

/**
 * Worker mode (MEETBOT_API_URL set): instead of waiting to be told, the service asks the API for meetings. Every few seconds it reports its
 * bots (status, how many caption lines) and how many meetings it can attend at once; the API answers with chat messages for its bots, bots
 * to stop, and new meetings to join (as many as it has room for). Because workers only ever call the API, any number of them can run as
 * replicas behind one address; a worker that stops reporting loses its meetings to another worker, which rejoins them.
 *
 * On SIGTERM (a redeploy) the worker stops taking meetings, stays in the ones it has until they end, then exits.
 */

const MB = 1024 * 1024;

/** Memory and CPUs this container may use (cgroup v2 limits when there are any). */
export function machine(read = (p) => readFileSync(p, 'utf8')) {
  let memoryMb = Math.round(totalmem() / MB);
  let cpus = availableParallelism();
  try { const m = read('/sys/fs/cgroup/memory.max').trim(); if (/^\d+$/.test(m)) memoryMb = Math.min(memoryMb, Math.round(Number(m) / MB)); } catch { /* not limited */ }
  try {
    const [quota, period] = read('/sys/fs/cgroup/cpu.max').trim().split(/\s+/);
    if (/^\d+$/.test(quota) && Number(period) > 0) cpus = Math.min(cpus, Number(quota) / Number(period));
  } catch { /* not limited */ }
  return { memoryMb, cpus };
}

/** How many meetings at once: a browser in a call needs about 550 MB and half a CPU; the service itself about 400 MB. */
export function autoCapacity({ memoryMb, cpus }) {
  return Math.max(1, Math.min(20, Math.floor((memoryMb - 400) / 550), Math.floor(cpus * 2)));
}

export function startWorker({ env, log, deps, bots, allowedHosts, version = '1.2.0' }) {
  const api = env.MEETBOT_API_URL.replace(/\/+$/, '');
  const workerId = (env.MEETBOT_WORKER_ID || `${hostname()}-${randomUUID().slice(0, 8)}`).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 100);
  const capacity = env.MEETBOT_MAX_BOTS ? Math.max(0, Number(env.MEETBOT_MAX_BOTS)) : autoCapacity(machine());
  const webhookHosts = (env.MEETBOT_WEBHOOK_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pollMs = Number(env.MEETBOT_POLL_MS ?? 5000);
  const state = { workerId, capacity, draining: false, lastOk: null, lastError: null, stopped: false };
  const jobs = new Map();   // jobId -> MeetBot
  const rejected = new Map();   // jobId -> error (reported once)
  let timer = null; let failures = 0;

  const hostOk = (value, hosts, protocols) => {
    try { const u = new URL(value); return protocols.includes(u.protocol) && hosts.some((h) => h === u.hostname || h === u.host); } catch { return false; }
  };
  const protocols = ['https:', ...(env.MEETBOT_ALLOW_HTTP === 'true' ? ['http:'] : [])];
  const running = () => [...jobs.values()].filter((b) => !['done', 'fatal'].includes(b.status)).length;

  const report = () => {
    const now = Date.now();
    const list = [];
    for (const [jobId, b] of jobs) {
      // A finished bot is reported for a little while (so its end is seen), then dropped.
      if (['done', 'fatal'].includes(b.status) && b.finishedAt && now - b.finishedAt > 120_000) { jobs.delete(jobId); continue; }
      list.push({ jobId, status: b.status, error: b.error, lines: b.lines, identityId: b.identity?.id ?? null });
    }
    for (const [jobId, error] of rejected) list.push({ jobId, status: 'fatal', error });
    rejected.clear();
    return list;
  };

  const liveKitHosts = (env.MEETBOT_LIVEKIT_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const liveKitProtocols = ['wss:', ...(env.MEETBOT_ALLOW_HTTP === 'true' ? ['ws:'] : [])];

  /** One of our own calls: the API sends the media server's address and the agent's own pass for that room. No browser, no lobby. */
  const takeCall = (job) => {
    let ok = false;
    try { const u = new URL(job.liveKitUrl); ok = liveKitProtocols.includes(u.protocol) && (!liveKitHosts.length || liveKitHosts.some((h) => h === u.hostname || h === u.host)); } catch { /* not a URL */ }
    if (!ok || typeof job.liveKitToken !== 'string' || job.liveKitToken.length > 4096) { rejected.set(job.jobId, 'The call server address is not allowed.'); return; }
    if (webhookHosts.length ? !hostOk(job.webhookUrl, webhookHosts, protocols) : !/^https?:\/\//.test(job.webhookUrl ?? '')) { rejected.set(job.jobId, 'The webhook address is not allowed.'); return; }
    const bot = new LiveKitBot({
      liveKitUrl: job.liveKitUrl, liveKitToken: job.liveKitToken, botName: String(job.botName || 'Project Tracker Agent').slice(0, 60), joinAt: job.joinAt, leaveAt: job.leaveAt,
      webhookUrl: job.webhookUrl, introMessage: job.introMessage ? String(job.introMessage).slice(0, 500) : null,
      agendaMessage: job.agendaMessage ? String(job.agendaMessage).slice(0, 500) : null, raiseMessage: job.raiseMessage ? String(job.raiseMessage).slice(0, 500) : null,
      readChat: job.readChat === true, voice: job.voice === true,
    }, { ...deps, onFinished: (b) => { b.finishedAt = Date.now(); deps.onFinished?.(b); } });
    bot.jobId = job.jobId;
    jobs.set(job.jobId, bot);
    bots.set(bot.id, bot);
    log(`job ${job.jobId.slice(0, 8)} → call ${bot.id.slice(0, 8)}${job.rejoin ? ' (rejoining)' : ''}`);
  };

  const take = (job) => {
    if (jobs.has(job.jobId)) return;
    if (job.liveKitUrl || String(job.meetingUrl ?? '').startsWith('livekit:')) { takeCall(job); return; }
    if (!hostOk(job.meetingUrl, allowedHosts, protocols)) { rejected.set(job.jobId, 'The meeting address is not a Google Meet or Microsoft Teams link.'); return; }
    // The job comes from the API we authenticated to; MEETBOT_WEBHOOK_HOSTS narrows where captions may go when set.
    if (webhookHosts.length ? !hostOk(job.webhookUrl, webhookHosts, protocols) : !/^https?:\/\//.test(job.webhookUrl ?? '')) { rejected.set(job.jobId, 'The webhook address is not allowed.'); return; }
    const bot = new MeetBot({
      meetingUrl: job.meetingUrl, botName: String(job.botName || 'Project Tracker Agent').slice(0, 60), joinAt: job.joinAt, leaveAt: job.leaveAt,
      webhookUrl: job.webhookUrl, introMessage: job.introMessage ? String(job.introMessage).slice(0, 500) : null,
      agendaMessage: job.agendaMessage ? String(job.agendaMessage).slice(0, 500) : null,
      captionLanguage: typeof job.captionLanguage === 'string' && /^[\p{L} ()-]{2,40}$/u.test(job.captionLanguage) ? job.captionLanguage : null,
      raiseMessage: job.raiseMessage ? String(job.raiseMessage).slice(0, 500) : null,
      readChat: job.readChat === true, voice: job.voice === true,
      identity: job.identity && typeof job.identity === 'object' ? { id: String(job.identity.id ?? ''), cookies: Array.isArray(job.identity.cookies) ? job.identity.cookies.slice(0, 400) : [] } : null,
    }, { ...deps, onFinished: (b) => { b.finishedAt = Date.now(); deps.onFinished?.(b); } });
    bot.jobId = job.jobId;
    jobs.set(job.jobId, bot);
    bots.set(bot.id, bot);
    log(`job ${job.jobId.slice(0, 8)} → bot ${bot.id.slice(0, 8)}${job.rejoin ? ' (rejoining)' : ''}, joins ${bot.joinAt.toISOString()}`);
  };

  const poll = async () => {
    if (state.stopped) return;
    try {
      const res = await fetch(`${api}/api/v1/agent/bot-workers/poll`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MEETBOT_SECRET}` },
        body: JSON.stringify({ workerId, host: hostname(), version, capacity, draining: state.draining, bots: report() }),
      });
      if (!res.ok) throw new Error(`the API answered ${res.status}`);
      const body = await res.json();
      const data = body?.data ?? body;
      for (const i of data?.bots ?? []) {
        const b = jobs.get(i.jobId);
        if (!b) continue;
        if (i.stop) { b.stop(); continue; }
        for (const m of i.chat ?? []) b.chat(m);
        if (i.say?.length) b.say?.(i.say);
      }
      if (!state.draining) for (const job of data?.jobs ?? []) take(job);
      state.lastOk = new Date().toISOString(); state.lastError = null;
      if (failures > 0) log(`API reachable again after ${failures} failed report(s)`);
      failures = 0;
    } catch (e) {
      failures++; state.lastError = String(e.message || e).slice(0, 200);
      if (failures === 1 || failures % 12 === 0) log(`could not report to the API: ${state.lastError}`);
    } finally {
      if (state.draining && running() === 0) { state.stopped = true; state.onDrained?.(); return; }
      if (!state.stopped) timer = setTimeout(() => void poll(), failures ? Math.min(30_000, pollMs * 2 ** Math.min(failures, 3)) : pollMs);
    }
  };

  const seen = machine();
  log(`worker ${workerId}: up to ${capacity} meeting(s) at once (${env.MEETBOT_MAX_BOTS ? 'MEETBOT_MAX_BOTS' : 'sized'} from ${seen.memoryMb} MB, ${+seen.cpus.toFixed(2)} CPU), asking ${api}`);
  timer = setTimeout(() => void poll(), 100);
  return {
    state,
    get active() { return running(); },
    /** Stop taking meetings; onDrained runs once the ones it has are over. */
    drain(onDrained) { if (state.draining) return; state.draining = true; state.onDrained = onDrained; log(`draining: ${running()} meeting(s) to finish`); clearTimeout(timer); void poll(); },
    stop() { state.stopped = true; clearTimeout(timer); },
  };
}
