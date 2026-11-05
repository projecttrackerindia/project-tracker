'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buttonsFor, toastXml, parseQuickLink, pressPlan, replyCardHtml } = require('../src/quick');

const KEY = 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop';

test('only known buttons with a real key, at most three', () => {
  assert.deepStrictEqual(buttonsFor(KEY, ['approve', 'reject', 'bogus']), ['approve', 'reject']);
  assert.deepStrictEqual(buttonsFor(KEY, ['done', 'snooze', 'open', 'read']), ['done', 'snooze', 'open']);
  assert.deepStrictEqual(buttonsFor('bad key<>', ['done']), []);
  assert.deepStrictEqual(buttonsFor(undefined, ['done']), []);
});

test('the Windows toast escapes text and uses the app protocol for each button', () => {
  const xml = toastXml({ title: 'A <b> & "c"', body: 'x', tag: 'n-1', buttons: ['approve', 'reject'], urgent: true });
  assert.ok(xml.includes('A &lt;b&gt; &amp; &quot;c&quot;'));
  assert.ok(xml.includes('arguments="projecttracker://quick/approve/n-1"'));
  assert.ok(xml.includes('scenario="reminder"'));
  assert.ok(!xml.includes('<b>'));
});

test('quick links parse, and nothing else does', () => {
  assert.deepStrictEqual(parseQuickLink('projecttracker://quick/done/abc'), { action: 'done', tag: 'abc' });
  assert.strictEqual(parseQuickLink('projecttracker://quick/rm-rf/abc'), null);
  assert.strictEqual(parseQuickLink('projecttracker://my-work'), null);
});

test('pressing: open-type actions open the app, text ones without text open it, the rest post', () => {
  assert.deepStrictEqual(pressPlan('join'), { open: true, body: { action: 'read' } });
  assert.deepStrictEqual(pressPlan('reject', ''), { open: false, prompt: true, body: null });
  assert.deepStrictEqual(pressPlan('reply'), { open: false, prompt: true, body: null });
  assert.deepStrictEqual(pressPlan('reject', 'Out of budget'), { open: false, body: { action: 'reject', text: 'Out of budget' } });
  assert.deepStrictEqual(pressPlan('reply', ' On it '), { open: false, body: { action: 'reply', text: 'On it' } });
  assert.deepStrictEqual(pressPlan('snooze'), { open: false, body: { action: 'snooze', preset: '1h' } });
});

test('the reply card escapes the notice, has no remote content and one field', () => {
  const html = replyCardHtml({ action: 'reject', title: '<img src=x>', body: 'Leave "Fri"', dark: true });
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('&lt;img src=x&gt;') && !html.includes('<img'));
  assert.ok(html.includes('aria-label="Reason"') && html.includes('>Reject</button>'));
  assert.ok(replyCardHtml({ action: 'reply', title: 't', body: 'b' }).includes('>Send</button>'));
});
