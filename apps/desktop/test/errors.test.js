'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scrub, errorReport, startErrorReporting } = require('../src/errors');

test('scrubs personal data, secrets and local user names', () => {
  const s = scrub('asha@example.com password=hunter2 C:\\Users\\asha\\AppData /Users/ravi/x +91 98765 43210');
  for (const bad of ['asha@', 'hunter2', 'Users\\asha', '/Users/ravi', '98765']) assert.ok(!s.includes(bad), `${bad} in ${s}`);
  assert.strictEqual(errorReport(new TypeError('x'), '1.2.3').app, 'desktop');
});

test('sends only when the server has error tracking on, once per distinct error', async () => {
  const calls = [];
  const fake = (on) => async (url, opts) => { calls.push([url, opts]); return { ok: true, json: async () => ({ data: { errors: on } }) }; };
  const send = startErrorReporting({ base: 'https://app.test', release: '1.0.0', fetchImpl: fake(true), on: () => {} });
  assert.strictEqual(await send(new Error('boom')), true);
  assert.strictEqual(await send(new Error('boom')), false);
  const posted = calls.find(([u]) => u.endsWith('/telemetry/errors'));
  assert.strictEqual(JSON.parse(posted[1].body).release, '1.0.0');

  calls.length = 0;
  const off = startErrorReporting({ base: 'https://app.test', release: '1', fetchImpl: fake(false), on: () => {} });
  assert.strictEqual(await off(new Error('boom')), false);
  assert.ok(!calls.some(([u]) => u.endsWith('/telemetry/errors')));
});
