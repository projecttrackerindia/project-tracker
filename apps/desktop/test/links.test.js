'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { deepLinkToUrl, isInternal, unreadFromTitle, isNewer } = require('../src/links');
const { appUrl } = require('../src/config');

test('deep links open the matching page of the app and nothing else', () => {
  assert.strictEqual(deepLinkToUrl('projecttracker://my-work', 'https://app.test'), 'https://app.test/my-work');
  assert.strictEqual(deepLinkToUrl('projecttracker://approve/abc-123', 'https://app.test'), 'https://app.test/approve/abc-123');
  assert.strictEqual(deepLinkToUrl('projecttracker://', 'https://app.test'), 'https://app.test/');
  assert.strictEqual(deepLinkToUrl('https://evil.test/x', 'https://app.test'), null);
  assert.ok(!deepLinkToUrl('projecttracker://x/<script>', 'https://app.test').includes('<'));   // the address is encoded, never raw markup
});

test('pages of the app stay in the window and others go to the browser', () => {
  assert.ok(isInternal('https://app.test/projects', 'https://app.test'));
  assert.ok(!isInternal('https://app.test.evil.com/', 'https://app.test'));
  assert.ok(!isInternal('not a url', 'https://app.test'));
});

test('the unread badge comes from the title', () => {
  assert.strictEqual(unreadFromTitle('(3) Acme · Project Tracker'), 3);
  assert.strictEqual(unreadFromTitle('⏰ (12) Acme · Project Tracker'), 12);
  assert.strictEqual(unreadFromTitle('(99+) x'), 99);
  assert.strictEqual(unreadFromTitle('Acme · Project Tracker'), 0);
});

test('version comparison', () => {
  assert.ok(isNewer('v1.2.0', '1.1.9')); assert.ok(isNewer('2.0', '1.9.9')); assert.ok(!isNewer('1.0.0', '1.0.0')); assert.ok(!isNewer('v1.0.0', '1.0.1'));
});

test('the app address is https (or localhost) and falls back safely', () => {
  assert.strictEqual(appUrl({ PT_APP_URL: 'https://acme.example.com/path' }, '/nonexistent'), 'https://acme.example.com');
  assert.strictEqual(appUrl({ PT_APP_URL: 'http://localhost:5173' }, '/nonexistent'), 'http://localhost:5173');
  assert.strictEqual(appUrl({ PT_APP_URL: 'http://evil.example.com' }, '/nonexistent'), 'https://projecttracker.in');
  assert.strictEqual(appUrl({ PT_APP_URL: 'javascript:alert(1)' }, '/nonexistent'), 'https://projecttracker.in');
  assert.strictEqual(appUrl({}, '/nonexistent'), 'https://projecttracker.in');
});
