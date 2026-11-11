'use strict';
// Quick actions on the desktop app's native notifications: which buttons, the Windows toast XML that carries them, and what pressing one
// sends to the server's one-time key endpoint (QuickActionService). Pure functions, tested in test/quick.test.js.

const LABELS = {
  approve: 'Approve', reject: 'Reject', reply: 'Reply', read: 'Mark read', done: 'Done', snooze: 'Snooze 1h', open: 'Open', join: 'Join',
  late: 'Running late', accept: 'Accept', decline: 'Decline', maybe: 'Maybe', review: 'Review', discuss: 'Discuss', callback: 'Call back', message: 'Message',
};
/** Finish in the app: the notice is read and the window opens where it points. */
const OPENS = new Set(['open', 'join', 'review', 'discuss', 'callback', 'message']);
/** Need a few words first. */
const NEEDS_TEXT = new Set(['reply', 'reject']);
const KEY = /^[A-Za-z0-9_.%-]{20,400}$/;

/** The buttons to show: known actions only, at most `max` (Windows shows five, macOS a menu, so keep it short and calm). */
function buttonsFor(qa, actions, max = 3) {
  if (typeof qa !== 'string' || !KEY.test(qa) || !Array.isArray(actions)) return [];
  return [...new Set(actions.map(String))].filter((a) => LABELS[a]).slice(0, max);
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * A Windows toast with buttons. Each button activates the app's own protocol (projecttracker://quick/<action>/<tag>); the second instance hands
 * it to the running app, which presses it. Windows cannot pass typed text back through the protocol, so Reply and Reject open the app there.
 */
function toastXml({ title, body, tag, buttons, urgent }) {
  const acts = buttons.map((a) => `<action content="${esc(LABELS[a])}" activationType="protocol" arguments="projecttracker://quick/${esc(a)}/${encodeURIComponent(tag)}"/>`).join('');
  return `<toast${urgent ? ' scenario="reminder"' : ''} activationType="protocol" launch="projecttracker://quick/open/${encodeURIComponent(tag)}">`
    + `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>`
    + (acts ? `<actions>${acts}</actions>` : '') + '</toast>';
}

/** projecttracker://quick/<action>/<tag> → { action, tag }, or null. */
function parseQuickLink(link) {
  const m = /^projecttracker:\/\/quick\/([a-z]+)\/([^/?#]{1,120})\/?$/.exec(String(link || ''));
  return m && (LABELS[m[1]] || m[1] === 'open') ? { action: m[1], tag: decodeURIComponent(m[2]) } : null;
}

/** What pressing does: open the app, or POST to the key endpoint (body). */
function pressPlan(action, text) {
  if (OPENS.has(action)) return { open: true, body: { action: 'read' } };
  const t = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
  if (NEEDS_TEXT.has(action) && !t) return { open: true, body: null };
  return { open: false, body: { action, ...(t ? { text: t } : {}), ...(action === 'snooze' ? { preset: '1h' } : {}) } };
}

module.exports = { LABELS, OPENS, NEEDS_TEXT, buttonsFor, toastXml, parseQuickLink, pressPlan };
