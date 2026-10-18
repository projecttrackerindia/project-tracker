import { randomUUID } from 'node:crypto';
import { askToJoin, captionWatcher, enableCaptions, leave, pageText, SEL, sendChat, setCaptionLanguage, TEXT, waitUntilAdmitted } from './meet.mjs';

/**
 * One bot in one meeting: waits until its start time, joins as a guest, turns on captions and streams who-said-what to the webhook, posts
 * chat messages on request, and leaves when the call ends, when it has been alone for a while, or at its time limit.
 *
 * Statuses: scheduled → joining → waiting_admission → in_call_recording → call_ended → done (or fatal, with an error).
 */
export class MeetBot {
  constructor({ meetingUrl, botName, joinAt, leaveAt, webhookUrl, introMessage, agendaMessage, captionLanguage }, deps) {
    this.id = randomUUID();
    this.meetingUrl = meetingUrl;
    this.botName = botName;
    this.joinAt = joinAt ? new Date(joinAt) : new Date();
    this.leaveAt = leaveAt ? new Date(leaveAt) : new Date(Math.max(Date.now(), this.joinAt.getTime()) + 3 * 3600_000);
    this.webhookUrl = webhookUrl;
    this.introMessage = introMessage;
    this.agendaMessage = agendaMessage || null;
    this.captionLanguage = captionLanguage || null;
    this.deps = deps;   // { launch(): Promise<Browser>, admitTimeoutMs, aloneMs, log }
    this.status = 'scheduled';
    this.error = null;
    this.lines = 0;
    this.chatQueue = [];
    this.stopping = false;
    this.webhookChain = Promise.resolve();
    this.timer = setTimeout(() => void this.run(), Math.max(0, this.joinAt.getTime() - Date.now() - 30_000));
  }

  get summary() {
    return { id: this.id, status: this.status, error: this.error, lines: this.lines, joinAt: this.joinAt.toISOString(), leaveAt: this.leaveAt.toISOString() };
  }

  log(msg) { this.deps.log(`[bot ${this.id.slice(0, 8)}] ${msg}`); }

  /** Webhook deliveries go out one at a time, in order, with a couple of retries. */
  post(event) {
    this.webhookChain = this.webhookChain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(this.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
          if (res.ok || res.status === 404 || res.status === 422) return;
        } catch { /* try again */ }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
      this.log('webhook delivery failed');
    });
    return this.webhookChain;
  }

  setStatus(status, error = null) {
    this.status = status; this.error = error;
    void this.post({ event: 'bot.status', data: { status, error, bot: { id: this.id } } });
  }

  async run() {
    if (this.stopping) return;
    this.setStatus('joining');
    try {
      this.browser = await this.deps.launch();
      const context = await this.browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 }, locale: 'en-US' });
      const page = await context.newPage();
      this.page = page;
      await page.exposeFunction('ptCaption', (name, text) => this.caption(name, text));
      await page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await askToJoin(page, this.botName, (m) => this.log(m));
      this.setStatus('waiting_admission');
      const admitted = await waitUntilAdmitted(page, this.deps.admitTimeoutMs);
      if (admitted !== 'admitted') throw new Error(admitted === 'denied' ? 'The bot was not let into the meeting.' : 'Nobody let the bot into the meeting.');
      this.log('in the call');
      if (!(await enableCaptions(page))) this.log('captions could not be switched on');
      else if (this.captionLanguage && !(await setCaptionLanguage(page, this.captionLanguage))) this.log(`captions stay in the meeting's default language (${this.captionLanguage} not offered)`);
      await page.evaluate(captionWatcher, SEL.captionsRegion);
      this.setStatus('in_call_recording');
      // Hello first, then the agenda, then anything the agent asked to say meanwhile.
      this.chatQueue.unshift(...[this.introMessage, this.agendaMessage].filter(Boolean));
      await this.stayInCall(page);
      await page.evaluate(() => window.ptFlushCaptions?.()).catch(() => undefined);
      await page.waitForTimeout(500);
      await leave(page).catch(() => undefined);
      this.setStatus('call_ended');
    } catch (e) {
      this.log(`failed: ${e.message}`);
      this.setStatus('fatal', String(e.message || e).slice(0, 300));
    } finally {
      await this.browser?.close().catch(() => undefined);
      await this.webhookChain;
      if (this.status !== 'fatal') this.setStatus('done');
      this.deps.onFinished?.(this);
    }
  }

  /** In the call: send queued chat messages, and watch for the end. */
  async stayInCall(page) {
    let aloneSince = 0;
    while (!this.stopping && Date.now() < this.leaveAt.getTime()) {
      while (this.chatQueue.length) {
        const message = this.chatQueue.shift();
        try { await sendChat(page, message); } catch (e) { this.log(`chat: ${e.message}`); }
      }
      const text = await pageText(page);
      if (TEXT.ended.test(text) || !(await page.getByRole('button', { name: SEL.leave }).count())) { this.log('the call ended'); return; }
      if (TEXT.alone.test(text)) { aloneSince ||= Date.now(); if (Date.now() - aloneSince > this.deps.aloneMs) { this.log('alone in the call'); return; } }
      else aloneSince = 0;
      await page.waitForTimeout(1000);
    }
  }

  caption(name, text) {
    const words = String(text).replace(/\s+/g, ' ').trim();
    if (!words) return;
    this.lines++;
    void this.post({ event: 'transcript.data', data: { data: { words: words.split(' ').map((w) => ({ text: w })), participant: { name: String(name || 'Someone').slice(0, 80) } }, bot: { id: this.id } } });
  }

  chat(message) {
    if (this.status !== 'in_call_recording') return false;
    this.chatQueue.push(String(message).slice(0, 500));
    return true;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    if (this.status === 'scheduled') { this.status = 'done'; this.deps.onFinished?.(this); }
  }
}
