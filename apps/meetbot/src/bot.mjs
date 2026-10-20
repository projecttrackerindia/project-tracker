import { randomUUID } from 'node:crypto';
import { platformFor } from './platform.mjs';
import { AUDIO_HOOK, AudioFile, align, transcribe } from './audio.mjs';

/**
 * One bot in one meeting (Google Meet or Microsoft Teams, from the link): waits until its start time, joins as a guest, turns on captions and streams who-said-what to the webhook, posts
 * chat messages on request, and leaves when the call ends, when it has been alone for a while, or at its time limit.
 *
 * Statuses: scheduled → joining → waiting_admission → in_call_recording → call_ended → done (or fatal, with an error).
 */
export class MeetBot {
  constructor({ meetingUrl, botName, joinAt, leaveAt, webhookUrl, introMessage, agendaMessage, captionLanguage, raiseMessage, readChat, identity }, deps) {
    this.id = randomUUID();
    this.meetingUrl = meetingUrl;
    this.platform = platformFor(meetingUrl);
    this.botName = botName;
    this.joinAt = joinAt ? new Date(joinAt) : new Date();
    this.leaveAt = leaveAt ? new Date(leaveAt) : new Date(Math.max(Date.now(), this.joinAt.getTime()) + 3 * 3600_000);
    this.webhookUrl = webhookUrl;
    this.introMessage = introMessage;
    this.agendaMessage = agendaMessage || null;
    this.captionLanguage = captionLanguage || null;
    this.raiseMessage = raiseMessage || null;
    this.readChat = Boolean(readChat);
    // A signed-in notetaker account (its browser cookies): the bot joins as that account instead of as a guest.
    this.identity = identity && Array.isArray(identity.cookies) && identity.cookies.length ? identity : null;
    // Captions go out in batches (one request every few seconds, however much is said) so a thousand meetings stay cheap for the API.
    this.captionBuffer = [];
    // Who spoke when (from the captions), to name the speakers of the Whisper transcript after the call.
    this.timeline = [];
    this.recordAudio = (deps.env?.MEETBOT_WHISPER_MODEL ?? 'small') !== 'off';
    this.audioFile = this.recordAudio ? new AudioFile(this.id) : null;
    this.flushMs = deps.captionFlushMs ?? 3000;
    this.flushTimer = null;
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
      const context = await this.browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 800 }, locale: 'en-US',
        ...(this.identity ? { storageState: { cookies: this.identity.cookies, origins: [] } } : {}) });
      if (this.recordAudio) {
        await context.addInitScript(AUDIO_HOOK);
        await context.exposeFunction('ptAudio', (b64) => { try { this.audioFile.write(b64); } catch { /* disk full: captions still work */ } });
        await context.exposeFunction('ptAudioStart', (t) => { this.audioFile.startedAt ??= Number(t) || Date.now(); });
      }
      const page = await context.newPage();
      this.page = page;
      await page.exposeFunction('ptCaption', (name, text) => this.caption(name, text));
      await page.exposeFunction('ptChat', (name, text) => this.heard(name, text));
      await page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const p = this.platform;
      if (this.identity && p.signedOut && await p.signedOut(page)) throw new Error('NOTETAKER_SIGNED_OUT: the notetaker account is signed out - sign it in again.');
      await p.askToJoin(page, this.botName, (m) => this.log(m));
      this.setStatus('waiting_admission');
      const admitted = await p.waitUntilAdmitted(page, this.deps.admitTimeoutMs);
      if (admitted !== 'admitted') throw new Error(admitted === 'denied' ? 'The bot was not let into the meeting.' : 'Nobody let the bot into the meeting.');
      this.log(`in the call (${p.name})`);
      if (!(await p.enableCaptions(page))) this.log('captions could not be switched on');
      else if (this.captionLanguage && !(await p.setCaptionLanguage(page, this.captionLanguage))) this.log(`captions stay in the meeting's default language (${this.captionLanguage} not offered)`);
      await p.watchCaptions(page);
      if (this.readChat) {
        if (await p.openChat(page)) await p.watchChat(page, this.botName);
        else this.log('the meeting chat could not be opened: questions there will not be answered');
      }
      this.setStatus('in_call_recording');
      this.flushTimer = setInterval(() => this.flush(), this.flushMs);
      // Hello first, then the agenda, then what the person who sent the agent asked it to raise, then anything the agent asked to say meanwhile.
      this.chatQueue.unshift(...[this.introMessage, this.agendaMessage, this.raiseMessage].filter(Boolean));
      await this.stayInCall(page);
      await page.evaluate(() => window.ptFlushCaptions?.()).catch(() => undefined);
      await page.waitForTimeout(500);
      clearInterval(this.flushTimer); this.flush();
      if (this.recordAudio) await page.evaluate(() => window.ptStopAudio?.()).catch(() => undefined);
      await this.platform.leave(page).catch(() => undefined);
      await this.finalTranscript();
      this.setStatus('call_ended');
    } catch (e) {
      this.log(`failed: ${e.message}`);
      this.setStatus('fatal', String(e.message || e).slice(0, 300));
    } finally {
      clearInterval(this.flushTimer); this.flush();
      await this.browser?.close().catch(() => undefined);
      await this.audioFile?.remove();
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
        try { await this.platform.sendChat(page, message); } catch (e) { this.log(`chat: ${e.message}`); }
      }
      const text = await this.platform.pageText(page);
      if (await this.platform.isOver(page, text)) { this.log('the call ended'); return; }
      if (this.platform.isAlone(text)) { aloneSince ||= Date.now(); if (Date.now() - aloneSince > this.deps.aloneMs) { this.log('alone in the call'); return; } }
      else aloneSince = 0;
      await page.waitForTimeout(1000);
    }
  }

  caption(name, text) {
    const words = String(text).replace(/\s+/g, ' ').trim();
    if (!words) return;
    this.lines++;
    if (this.timeline.length < 20000) this.timeline.push({ name: String(name || 'Someone').slice(0, 80), at: new Date().toISOString() });
    this.captionBuffer.push({ name: String(name || 'Someone').slice(0, 80), text: words.slice(0, 2000), at: new Date().toISOString() });
    if (this.captionBuffer.length >= 200) this.flush();
  }

  /** After the call: Whisper on the recording, named from the captions, sent as the call's transcript (it replaces the live captions). */
  async finalTranscript() {
    const audio = this.audioFile;
    if (!audio) return;
    try {
      await audio.close();
      if (audio.bytes < 20_000 || !audio.startedAt) return;
      this.setStatus('transcribing');
      this.log(`transcribing ${Math.round(audio.bytes / 1024)} KB of audio`);
      const segments = await transcribe(audio.file, this.deps.env ?? process.env, (m) => this.log(m));
      if (!segments?.length) return;
      const lines = align(segments, this.timeline, audio.startedAt);
      await this.post({ event: 'transcript.final', data: { lines, bot: { id: this.id } } });
      this.log(`transcript from audio: ${lines.length} lines`);
    } catch (e) { this.log(`audio transcript skipped: ${e.message}`); }
    finally { await audio.remove(); }
  }

  /** Sends what was heard since the last batch, in order (one webhook call). */
  flush() {
    if (!this.captionBuffer.length) return;
    const lines = this.captionBuffer.splice(0, this.captionBuffer.length);
    void this.post({ event: 'transcript.batch', data: { lines, bot: { id: this.id } } });
  }

  /** Someone wrote in the meeting chat: what was heard so far goes first, then the message (the agent may answer it). */
  heard(name, text) {
    const message = String(text).replace(/\s+/g, ' ').trim();
    if (!message) return;
    this.flush();
    void this.post({ event: 'chat.message', data: { name: String(name || 'Someone').slice(0, 80), text: message.slice(0, 1000), bot: { id: this.id } } });
  }

  /** Queues a chat message: sent at once in the call, or once the bot is in it (a message for a bot that has finished is refused). */
  chat(message) {
    if (['call_ended', 'done', 'fatal'].includes(this.status) || this.stopping) return false;
    this.chatQueue.push(String(message).slice(0, 500));
    return true;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    if (this.status === 'scheduled') { this.status = 'done'; this.deps.onFinished?.(this); }
  }
}
