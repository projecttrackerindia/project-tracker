import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explain } from '../src/meet.mjs';

// A failed join tells the person what to change, from the words the Meet page showed.
test('the reason for a failed Google Meet join is specific and actionable', () => {
  assert.match(explain('denied', "You can't join this video call", false), /Notetaker accounts/);
  assert.match(explain('denied', "You can't join this video call", true), /Invite the notetaker account/);
  assert.match(explain('denied', 'Someone in the call denied your request to join'), /declined/);
  assert.match(explain('timeout', 'Asking to be let in...'), /click Admit/);
  assert.match(explain('denied', 'This meeting has been locked'), /locked/);
  assert.match(explain('denied', 'The call has ended'), /ended/);
  assert.match(explain('denied', ''), /guests are blocked/);
  for (const k of ['denied', 'timeout']) assert.ok(explain(k, '').length <= 300);
});
