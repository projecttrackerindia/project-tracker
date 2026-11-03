import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';

const source = await fs.readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker({ played = false, viewing = false, existing = false, fail = false } = {}) {
  const handlers = {}, shown = [], receipts = [];
  class Channel {
    constructor() {
      this.port1 = {};
      this.port2 = { postMessage: (data) => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  }
  const win = { url: 'https://tracker.test/fsbl', postMessage: (message, ports) => {
    if (message.type === 'pm-push-delivered') receipts.push(message);
    else ports[0].postMessage({ played, viewing });
  } };
  const registration = {
    getNotifications: async () => existing ? [{ tag: 'n1' }] : [],
    showNotification: async (title, options) => {
      // Enforce the Notifications API's actual rejection rules, rather than an always-successful mock.
      if (options.silent === true && 'vibrate' in options) throw new TypeError('silent and vibrate');
      if (options.renotify && !options.tag) throw new TypeError('renotify needs a tag');
      if (fail) throw new Error('display failed');
      shown.push({ title, options });
    },
  };
  const self = { registration, location: { origin: 'https://tracker.test' }, navigator: {},
    clients: { matchAll: async () => [win] }, addEventListener: (name, handler) => { handlers[name] = handler; } };
  vm.runInNewContext(source, { self, URL, MessageChannel: Channel, setTimeout, clearTimeout, console });
  return { shown, receipts, async push(data) {
    let done;
    handlers.push({ data: { json: () => data }, waitUntil: (promise) => { done = promise; } });
    await done;
  } };
}

test('a page playing audio still gets a valid silent desktop banner', async () => {
  for (const payload of [{ type: 'Message' }, { type: 'Reminder', token: 'one-time' }, { type: 'Call', call: 'c1' }]) {
    const w = worker({ played: true });
    await w.push({ title: 'Test', tag: 'n1', ...payload });
    assert.equal(w.shown.length, 1);
    assert.equal(w.shown[0].options.silent, true);
    assert.equal('vibrate' in w.shown[0].options, false);
  }
});
test('a closed or silent page leaves OS sound and vibration available', async () => {
  const w = worker();
  await w.push({ title: 'Test', type: 'Message', tag: 'n1' });
  assert.equal(w.shown[0].options.silent, false);
  assert.ok(w.shown[0].options.vibrate.length);
  assert.equal(w.receipts.length, 1);
});
test('sign-in requests retain their urgent OS alert even when the page played audio', async () => {
  const w = worker({ played: true });
  await w.push({ type: 'SignInRequest', tag: 'sign-in' });
  assert.equal(w.shown[0].options.silent, false);
  assert.ok(w.shown[0].options.vibrate.length);
});
test('a late push acknowledges an already displayed page fallback without another banner', async () => {
  const w = worker({ existing: true });
  await w.push({ type: 'Message', tag: 'n1' });
  assert.equal(w.shown.length, 0);
  assert.equal(w.receipts.length, 1);
});
test('viewed conversations and failed displays do not claim successful display', async () => {
  const viewed = worker({ viewing: true });
  await viewed.push({ type: 'Message', tag: 'viewed' });
  assert.equal(viewed.shown.length, 0);
  assert.equal(viewed.receipts.length, 0);
  const broken = worker({ fail: true });
  await assert.rejects(broken.push({ type: 'Message', tag: 'failed' }), /display failed/);
  assert.equal(broken.receipts.length, 0);
});
