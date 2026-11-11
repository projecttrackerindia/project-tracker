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
 * it to the running app, which presses it. A protocol activation cannot carry typed text back (and Electron's toast handler drops toast
 * <input> values), so Reply and Reject open a small reply card beside the tray (replyCardHtml) that sends through the same one-time key,
 * with the main window left closed; only when that fails does the app open on the item.
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
  if (NEEDS_TEXT.has(action) && !t) return { open: false, prompt: true, body: null };
  return { open: false, body: { action, ...(t ? { text: t } : {}), ...(action === 'snooze' ? { preset: '1h' } : {}) } };
}

/** The reply card's own page (no remote content, strict CSP): a title, the notice text, one field and Send / Cancel. */
function replyCardHtml({ action, title, body, dark }) {
  const reject = action === 'reject';
  const bg = dark ? '#1c1c1e' : '#ffffff', fg = dark ? '#f2f2f7' : '#1d1d1f', mute = dark ? '#a1a1a6' : '#6e6e73', line = dark ? '#3a3a3c' : '#d2d2d7';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`
    + `<title>${reject ? 'Reject' : 'Reply'}</title><style>html,body{margin:0;background:${bg};color:${fg};font:13px/1.4 "Segoe UI",system-ui,sans-serif}`
    + `main{padding:14px 16px;display:grid;gap:8px}b{font-size:13.5px}p{margin:0;color:${mute};overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}`
    + `textarea{resize:none;height:54px;border:1px solid ${line};border-radius:8px;background:transparent;color:inherit;font:inherit;padding:7px 9px;outline-color:#7c5cff}`
    + `.r{display:flex;gap:8px;justify-content:flex-end}button{min-height:30px;padding:0 14px;border-radius:8px;border:1px solid ${line};background:transparent;color:inherit;font:inherit;cursor:pointer}`
    + `button.p{background:${reject ? '#d70015' : '#7c5cff'};border-color:transparent;color:#fff;font-weight:600}button:disabled{opacity:.5}</style></head><body><main>`
    + `<b>${esc(title)}</b><p>${esc(body)}</p><textarea id="t" maxlength="2000" placeholder="${reject ? 'Why? (they will see this)' : 'Reply…'}" aria-label="${reject ? 'Reason' : 'Reply'}" autofocus></textarea>`
    + `<div class="r"><button id="c">Cancel</button><button id="s" class="p" disabled>${reject ? 'Reject' : 'Send'}</button></div></main><script>`
    + `const t=document.getElementById('t'),s=document.getElementById('s');t.oninput=()=>{s.disabled=!t.value.trim()};`
    + `const send=()=>{if(t.value.trim())window.ptReply.send(t.value)};s.onclick=send;document.getElementById('c').onclick=()=>window.ptReply.cancel();`
    + `t.onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}if(e.key==='Escape')window.ptReply.cancel()};t.focus();</script></body></html>`;
}

module.exports = { LABELS, OPENS, NEEDS_TEXT, buttonsFor, toastXml, parseQuickLink, pressPlan, replyCardHtml };
