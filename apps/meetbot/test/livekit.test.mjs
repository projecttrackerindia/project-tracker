import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { CHAT_TOPIC, LiveKitBot, Segmenter, wav } from '../src/livekit.mjs';

const RATE = 16_000;
const frame = (ms, amp = 0, hz = 220, t0 = 0) => {
  const n = (RATE * ms) / 1000; const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(amp * 32767 * Math.sin((2 * Math.PI * hz * (t0 + i)) / RATE) + (Math.random() - 0.5) * 60);
  return pcm;
};

test('a pause ends an utterance; coughs and clicks are dropped; very long speech is cut', () => {
  const got = [];
  const s = new Segmenter({ onUtterance: (pcm) => got.push(pcm.length / RATE) });
  for (let i = 0; i < 15; i++) s.push(frame(20));              // background
  for (let i = 0; i < 60; i++) s.push(frame(20, 0.3));         // 1.2 s of speech
  for (let i = 0; i < 50; i++) s.push(frame(20));              // 1 s pause
  assert.equal(got.length, 1);
  assert.ok(got[0] > 1.1 && got[0] < 2.2, `utterance of ${got[0]} s`);
  for (let i = 0; i < 5; i++) s.push(frame(20, 0.4));          // a 100 ms click
  for (let i = 0; i < 50; i++) s.push(frame(20));
  assert.equal(got.length, 1);
  const long = new Segmenter({ maxMs: 2000, onUtterance: (pcm) => got.push(pcm.length / RATE) });
  for (let i = 0; i < 15; i++) long.push(frame(20));
  for (let i = 0; i < 150; i++) long.push(frame(20, 0.3));     // 3 s without a pause
  assert.ok(got.length >= 2);
});

test('utterances become 16 kHz mono WAV files', () => {
  const w = wav(new Int16Array([0, 1000, -1000]));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(24), RATE);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.length, 44 + 6);
});

// ---- against a real media server (livekit-server --dev); CI starts one and sets LIVEKIT_TEST_URL.
const url = process.env.LIVEKIT_TEST_URL;
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function pass(identity, name, room, key = 'devkey', secret = 'secret') {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: key, sub: identity, name, nbf: now - 10, exp: now + 600, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } });
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

test('the agent joins one of our own calls with its pass, hears each person, writes and reads the chat, and leaves when alone', { skip: !url, timeout: 60_000 }, async () => {
  const rtc = await import('@livekit/rtc-node');
  const events = []; const speech = [];
  const api = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url === '/hook/speech') {
        const text = body.toString('latin1');
        speech.push({ name: /name="name"\r\n\r\n([^\r]*)/.exec(text)?.[1], wav: text.includes('RIFF') });
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: 'something was said' }));
        return;
      }
      events.push(JSON.parse(body.toString()));
      res.writeHead(200); res.end('{}');
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${api.address().port}/hook`;
  const room = `test-${Date.now()}`;

  const human = new rtc.Room();
  const chat = [];
  human.registerTextStreamHandler(CHAT_TOPIC, (reader) => { void reader.readAll().then((t) => chat.push(t)); });
  await human.connect(url, pass('user:asha', 'Asha', room), { autoSubscribe: true, dynacast: false });
  const source = new rtc.AudioSource(RATE, 1);
  const track = rtc.LocalAudioTrack.createAudioTrack('mic', source);
  const options = new rtc.TrackPublishOptions(); options.source = rtc.TrackSource.SOURCE_MICROPHONE;
  await human.localParticipant.publishTrack(track, options);

  const logs = [];
  const bot = new LiveKitBot({ liveKitUrl: url, liveKitToken: pass('agent:test', 'Tracker Agent', room), botName: 'Tracker Agent', webhookUrl: hook, readChat: true, introMessage: 'Hi everyone - I am the agent.' },
    { log: (m) => logs.push(m), aloneMs: 2500, env: { MEETBOT_WHISPER_MODEL: 'off' }, rtc });
  const until = async (check, ms = 15_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return check(); };

  assert.ok(await until(() => bot.status === 'in_call_recording'), logs.join('\n'));
  assert.ok(await until(() => chat.includes('Hi everyone - I am the agent.')), 'the agent posts its hello in the call chat');
  // Speak: a second and a bit of sound, then a pause.
  await new Promise((r) => setTimeout(r, 1500));   // the agent subscribes to the microphone
  let t = 0;
  const say = async (ms, amp) => { for (let i = 0; i < ms / 20; i++) { await source.captureFrame(new rtc.AudioFrame(frame(20, amp, 220, t), RATE, 1, 320)); t += 320; } };
  await say(400, 0); await say(1400, 0.3); await say(1200, 0);
  assert.ok(await until(() => speech.length > 0), `nothing reached the API\n${logs.join('\n')}`);
  assert.equal(speech[0].name, 'Asha');   // exactly who spoke
  assert.ok(speech[0].wav);
  // Chat both ways.
  await human.localParticipant.sendText('Agent, what is due this week?', { topic: CHAT_TOPIC });
  assert.ok(await until(() => events.some((e) => e.event === 'chat.message' && e.data.name === 'Asha' && e.data.text.includes('due this week'))));
  assert.ok(bot.chat('PAY-12 is due on Friday.'));
  assert.ok(await until(() => chat.includes('PAY-12 is due on Friday.')));
  // Everyone leaves: the agent leaves too and says the call ended.
  await human.disconnect();
  assert.ok(await until(() => bot.status === 'done', 20_000), logs.join('\n'));
  assert.ok(events.some((e) => e.event === 'bot.status' && e.data.status === 'call_ended'));
  assert.ok(!events.some((e) => e.event === 'bot.status' && e.data.status === 'waiting_admission'));   // nobody had to let it in
  await new Promise((r) => api.close(r));
});

test('with voice on, the agent speaks into our own call on its own microphone track; without it, it never publishes one', { skip: !url, timeout: 60_000 }, async () => {
  const rtc = await import('@livekit/rtc-node');
  const api = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${api.address().port}/hook`;
  const room = `voice-${Date.now()}`;
  const human = new rtc.Room();
  let loudest = 0; let agentTracks = 0;
  human.on(rtc.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO || !participant.identity.startsWith('agent:')) return;
    agentTracks++;
    const reader = new rtc.AudioStream(track, { sampleRate: RATE, numChannels: 1 }).getReader();
    void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; for (const v of value.data) loudest = Math.max(loudest, Math.abs(v)); } })().catch(() => undefined);
  });
  await human.connect(url, pass('user:asha', 'Asha', room), { autoSubscribe: true, dynacast: false });
  const until = async (check, ms = 15_000) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return check(); };
  const make = (identity, voice) => new LiveKitBot({ liveKitUrl: url, liveKitToken: pass(identity, 'Tracker Agent', room), botName: 'Tracker Agent', webhookUrl: hook, voice },
    { log: () => undefined, aloneMs: 60_000, env: { MEETBOT_WHISPER_MODEL: 'off' }, rtc });
  const quiet = make('agent:quiet', false);
  const loud = make('agent:voice', true);
  assert.ok(await until(() => quiet.status === 'in_call_recording' && loud.status === 'in_call_recording'));
  // A 1 s tone at the speech service's own rate (22.05 kHz), as base64 WAV.
  const n = 22050; const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 22050));
  const audio = wav(pcm, 22050).toString('base64');
  assert.equal(quiet.say([{ text: 'Should not be heard.', audio }]), false);
  assert.equal(loud.say([{ text: 'Nobody owns the refund flow yet.', audio }]), true);
  assert.ok(await until(() => loud.spoken === 1 && loudest > 3000), `heard ${loudest}`);
  assert.equal(agentTracks, 1, 'only the voice notetaker published a microphone');
  quiet.stop(); loud.stop();
  await human.disconnect();
  await new Promise((r) => api.close(r));
});

after(async () => { if (url) await (await import('@livekit/rtc-node')).dispose(); });
