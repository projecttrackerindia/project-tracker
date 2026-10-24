import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { durationMs, parseWav, sayItems } from '../src/voice.mjs';
import { wav } from '../src/livekit.mjs';
import { createServer } from '../src/server.mjs';

/** A tone as a 16-bit mono WAV (what the speech service sends, at its own rate). */
const tone = (ms, rate = 22050) => {
  const n = Math.round((rate * ms) / 1000); const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return wav(pcm, rate);
};

test('a spoken line is read from a WAV file at its own rate; anything else is refused', () => {
  const v = parseWav(tone(500));
  assert.equal(v.rate, 22050);
  assert.equal(v.channels, 1);
  assert.equal(durationMs(v), 500);
  assert.equal(parseWav(Buffer.from('not a wav file at all, just text that is long enough to look like a header')), null);
  // Stereo becomes mono (first channel).
  const stereo = Buffer.from(tone(10));
  stereo.writeUInt16LE(2, 22); stereo.writeUInt32LE(22050 * 4, 28); stereo.writeUInt16LE(4, 32);
  assert.equal(parseWav(stereo).pcm.length, Math.floor((stereo.length - 44) / 4));
});

test('the lines the API sends are checked and capped', () => {
  const audio = tone(50).toString('base64');
  const items = sayItems([{ text: '  Nobody   owns PAY-9 yet. ', audio }, { text: '', audio }, { text: 'x', audio: null }, ...Array(6).fill({ text: 'more', audio })]);
  assert.equal(items.length, 4);
  assert.equal(items[0].text, 'Nobody owns PAY-9 yet.');
  assert.deepEqual(sayItems('nonsense'), []);
});

const SECRET = 'test-secret-0123456789';
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const until = async (check, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); } };

test('in Google Meet the bot unmutes, speaks into the call and mutes again; a quiet bot never speaks', { timeout: 90_000 }, async () => {
  const page = await fs.readFile(new URL('./fake-meet.html', import.meta.url), 'utf8');
  const mic = [], voice = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/mic-log') { mic.push(body); res.end(); return; }
      if (req.url === '/voice-log') { voice.push(body); res.end(); return; }
      if (req.url === '/control') { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
      if (req.url === '/hook' || req.url.endsWith('-log')) { res.end('{}'); return; }
      res.setHeader('content-type', 'text/html'); res.end(page);
    });
  });
  const fakePort = await listen(fake);
  const bots = createServer({ MEETBOT_SECRET: SECRET, MEETBOT_ALLOWED_HOSTS: '127.0.0.1', MEETBOT_WEBHOOK_HOSTS: '127.0.0.1', MEETBOT_ALLOW_HTTP: 'true', MEETBOT_HEADLESS: 'true',
    MEETBOT_QUIET: 'true', MEETBOT_ALONE_MS: '600000', MEETBOT_WHISPER_MODEL: 'off', ...(process.env.MEETBOT_CHROMIUM ? { MEETBOT_CHROMIUM: process.env.MEETBOT_CHROMIUM } : {}) });
  const botPort = await listen(bots);
  const api = (method, path, body) => fetch(`http://127.0.0.1:${botPort}${path}`, { method, headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const quiet = await (await api('POST', '/bots', { meetingUrl: `http://127.0.0.1:${fakePort}/quiet-call`, botName: 'Notes Bot', webhookUrl: `http://127.0.0.1:${fakePort}/hook` })).json();
    const loud = await (await api('POST', '/bots', { meetingUrl: `http://127.0.0.1:${fakePort}/voice-call`, botName: 'Voice Bot', webhookUrl: `http://127.0.0.1:${fakePort}/hook`, voice: true })).json();
    for (const id of [quiet.id, loud.id]) await until(async () => (await (await api('GET', `/bots/${id}`)).json()).status === 'in_call_recording');
    const line = { text: 'Before we wrap up: nobody owns the refund flow yet.', audio: tone(900).toString('base64') };
    assert.equal((await api('POST', `/bots/${quiet.id}/say`, line)).status, 409, 'a meeting that chose transcription only is never spoken to');
    assert.equal((await api('POST', `/bots/${loud.id}/say`, line)).status, 202);
    await until(() => voice.includes('heard') && mic.at(-1) === 'off');
    assert.deepEqual(mic, ['on', 'off'], 'the microphone is on only while it speaks');
    assert.equal(bots.bots.get(loud.id).spoken, 1);
  } finally {
    for (const b of bots.bots.values()) b.stop();
    bots.close(); fake.close();
  }
});
