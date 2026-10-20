import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AUDIO_HOOK, align } from '../src/audio.mjs';

test('Whisper lines are named after the caption speaker at that moment', () => {
  const t0 = Date.parse('2026-10-20T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const captions = [{ name: 'Ravi', at: at(2) }, { name: 'Ravi', at: at(6) }, { name: 'Asha', at: at(14) }];
  const lines = align([{ start: 0, end: 5, text: ' Is the fix ready? ' }, { start: 11, end: 14, text: 'Yes, Friday.' }, { start: 40, end: 42, text: 'Thanks.' }], captions, t0);
  assert.deepEqual(lines.map((l) => [l.name, l.text]), [['Ravi', 'Is the fix ready?'], ['Asha', 'Yes, Friday.'], ['Asha', 'Thanks.']]);
});

test('the page hook records incoming WebRTC audio', { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MEETBOT_CHROMIUM ? { executablePath: process.env.MEETBOT_CHROMIUM } : {}),
    args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const context = await browser.newContext();
    let bytes = 0; let started = 0;
    await context.addInitScript(AUDIO_HOOK);
    await context.exposeFunction('ptAudio', (b64) => { bytes += Buffer.from(b64, 'base64').length; });
    await context.exposeFunction('ptAudioStart', () => { started++; });
    const page = await context.newPage();
    await page.setContent('<html><body>call</body></html>');
    // Two local peers: an oscillator sent from one is received by the other, as a meeting's remote audio would be.
    await page.evaluate(async () => {
      const a = new RTCPeerConnection(); const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      const ctx = new AudioContext(); const osc = ctx.createOscillator(); const out = ctx.createMediaStreamDestination(); osc.connect(out); osc.start();
      a.addTrack(out.stream.getAudioTracks()[0], out.stream);
      await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
    });
    await page.waitForTimeout(11_500);
    await page.evaluate(() => window.ptStopAudio());
    await page.waitForTimeout(500);
    assert.equal(started, 1);
    assert.ok(bytes > 1000, `recorded ${bytes} bytes`);
  } finally { await browser.close(); }
});
