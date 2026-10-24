// Everything that depends on how the Microsoft Teams web page looks lives in this one file, like src/meet.mjs for Google Meet. The bot joins a
// Teams meeting as an anonymous guest in the browser ("Continue on this browser"), waits in the lobby until someone admits it, switches on live
// captions and reads them. test/fake-teams.html mirrors the structure relied on here; when Microsoft changes the Teams screen, update both.

/** Buttons and fields: accessible names first (most stable), then Teams' own data-tid attributes. */
export const SEL = {
  // The launcher page asks whether to open the desktop app; the bot stays in the browser.
  launcher: /^(continue on this browser|join on the web instead|use the web app instead|join on the web)$/i,
  nameInput: ['input[data-tid="prejoin-display-name-input"]', 'input[aria-label="Type your name"]', 'input[placeholder="Type your name"]', 'input[aria-label^="Name"]'],
  join: /^(join now|join meeting|join)$/i,
  dismiss: /^(got it|dismiss|close|ok|continue without audio or video|not now|maybe later)$/i,
  micOff: /^(mute|turn off microphone|microphone off)$/i,
  micOn: /^(unmute|turn on microphone|microphone on)$/i,
  camOff: /^(turn camera off|turn off camera|camera off)$/i,
  // "Leave (Ctrl+Shift+H)" in the call; the end-of-call page has no such button.
  leave: /^(leave|hang up)\b/i,
  more: /^(more|more actions|more options)$/i,
  languageMenu: /^(language and speech|captions and transcripts|captions)$/i,
  captionsOn: /turn on (live )?captions/i,
  captionsOff: /turn off (live )?captions/i,
  chatOpen: /^(chat|show conversation|open chat)$/i,
  chatInput: ['[data-tid="ckeditor"][contenteditable="true"]', 'div[role="textbox"][aria-label^="Type a message"]', 'div[role="textbox"][aria-label^="Type a new message"]', 'textarea[aria-label^="Type a message"]'],
  // Live captions: one item per utterance, the speaker in [data-tid=author] and the words in [data-tid=closed-caption-text].
  captionText: '[data-tid="closed-caption-text"]',
  captionAuthor: '[data-tid="author"]',
  captionsRegion: '[data-tid="closed-caption-v2-window-wrapper"], [data-tid="closed-captions-renderer"], [data-tid="closed-caption-renderer-wrapper"]',
  chatMessage: '[data-tid="chat-pane-message"]',
  chatSender: '[data-tid="message-author-name"]',
};

/** Words on the page that say the attempt to join failed or the meeting is over. */
export const TEXT = {
  denied: /(you were denied access|your request to join was declined|no one responded to your request|we couldn't (find|join) (the|this) meeting|this meeting link (is|has) (invalid|expired)|anonymous users can't join|you can't join this meeting)/i,
  ended: /(you left the meeting|the meeting has ended|this meeting has ended|you've been removed from this meeting|you have been removed from the meeting|thanks for joining|the call has ended)/i,
  waiting: /(someone in the meeting should let you in soon|we've let people in the meeting know you're waiting|waiting for someone to let you in|you're in the lobby)/i,
  alone: /(you're the only one here|you are the only one in the meeting|waiting for others to join)/i,
};

export const name = 'teams';

const firstVisible = async (page, selectors) => {
  for (const s of selectors) {
    const l = page.locator(s).first();
    if (await l.count() && await l.isVisible().catch(() => false)) return l;
  }
  return null;
};

const clickButton = async (page, name, roles = ['button']) => {
  for (const role of roles) {
    const b = page.getByRole(role, { name }).first();
    if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 5000 }).catch(() => undefined); return true; }
  }
  return false;
};

export const pageText = (page) => page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

/** Microphone and camera off: Teams shows them as switches (or buttons) on the pre-join screen. */
async function mediaOff(page) {
  for (const label of [/microphone/i, /camera|video/i]) {
    const sw = page.getByRole('switch', { name: label }).first();
    if (await sw.count() && await sw.isVisible().catch(() => false) && (await sw.getAttribute('aria-checked')) === 'true') await sw.click({ timeout: 3000 }).catch(() => undefined);
  }
  await clickButton(page, SEL.micOff);
  await clickButton(page, SEL.camOff);
}

/** The launcher ("Continue on this browser"), then the pre-join screen: the bot's name, no microphone or camera, "Join now". */
export async function askToJoin(page, botName, log) {
  const deadline = Date.now() + 90_000;
  let named = false;
  while (Date.now() < deadline) {
    if (await clickButton(page, SEL.launcher, ['button', 'link'])) { log('continuing in the browser'); await page.waitForTimeout(1500); continue; }
    await clickButton(page, SEL.dismiss);
    const input = await firstVisible(page, SEL.nameInput);
    if (input) { await input.fill(botName); named = true; }
    await mediaOff(page);
    if (named && await clickButton(page, SEL.join)) { log('asked to join'); return; }
    if (TEXT.denied.test(await pageText(page))) throw new Error('Microsoft Teams does not let the bot join this meeting (guests may be blocked by the organizer).');
    await page.waitForTimeout(1000);
  }
  throw new Error('The Microsoft Teams join screen did not appear.');
}

/** Waits in the lobby until someone admits the bot (the Leave button appears), the request is refused, or time runs out. */
export async function waitUntilAdmitted(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leave = page.getByRole('button', { name: SEL.leave }).first();
    const text = await pageText(page);
    if (!TEXT.waiting.test(text) && await leave.count() && await leave.isVisible().catch(() => false)) return 'admitted';
    if (TEXT.denied.test(text) || TEXT.ended.test(text)) return 'denied';
    await clickButton(page, SEL.dismiss);
    await page.waitForTimeout(1500);
  }
  return 'timeout';
}

/** Live captions: More → Language and speech → Turn on live captions (Alt+Shift+C as the fallback). */
export async function enableCaptions(page) {
  for (let i = 0; i < 4; i++) {
    if (await page.locator(SEL.captionsRegion).count()) return true;
    if (await page.getByRole('button', { name: SEL.captionsOff }).count() || await page.getByRole('menuitem', { name: SEL.captionsOff }).count()) return true;
    let clicked = await clickButton(page, SEL.captionsOn, ['button', 'menuitem', 'menuitemcheckbox']);
    if (!clicked && await clickButton(page, SEL.more)) {
      await page.waitForTimeout(500);
      await clickButton(page, SEL.languageMenu, ['menuitem', 'button']);
      await page.waitForTimeout(500);
      clicked = await clickButton(page, SEL.captionsOn, ['menuitem', 'menuitemcheckbox', 'button']);
    }
    if (!clicked) await page.keyboard.press('Alt+Shift+C').catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  return (await page.locator(SEL.captionsRegion).count()) > 0;
}

/** Teams sets the spoken language in the captions settings; the bot leaves it as the organizer chose (false = not changed). */
export async function setCaptionLanguage() { return false; }

/**
 * Runs inside the Teams page: reports each finished caption (speaker + words) through the exposed `ptCaption` function. A caption item grows
 * while someone speaks; it is reported once it has been still for a moment (or has gone), and only new words if it grows again.
 */
export function captionWatcher({ textSelector, authorSelector }) {
  const sent = new WeakMap();
  const seen = new WeakMap();
  const items = new Set();
  const read = (el) => {
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    // The speaker is on the caption's own item (walk up until an ancestor holds an author element).
    let node = el.parentElement, author = null;
    for (let i = 0; node && i < 6 && !author; i++, node = node.parentElement) author = node.querySelector(authorSelector);
    return { name: (author?.innerText || author?.textContent || 'Someone').trim(), text };
  };
  const flush = (el, force) => {
    const now = read(el);
    const last = seen.get(el);
    if (!now) return;
    if (!force && (!last || last.text !== now.text || Date.now() - last.at < 1800)) return;
    const done = sent.get(el) || '';
    if (now.text === done) return;
    const fresh = done && now.text.startsWith(done) ? now.text.slice(done.length).trim() : now.text;
    sent.set(el, now.text);
    if (fresh) window.ptCaption(now.name, fresh);
  };
  const scan = () => {
    const current = new Set(document.querySelectorAll(textSelector));
    for (const el of items) if (!current.has(el) || !el.isConnected) { flush(el, true); items.delete(el); }
    for (const el of current) {
      items.add(el);
      const r = read(el);
      const last = seen.get(el);
      if (r && (!last || last.text !== r.text)) seen.set(el, { text: r.text, at: Date.now() });
      else flush(el, false);
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 700);
  window.ptFlushCaptions = () => { for (const el of items) flush(el, true); };
}

export const watchCaptions = (page) => page.evaluate(captionWatcher, { textSelector: SEL.captionText, authorSelector: SEL.captionAuthor });

/** Opens the chat (guests may not have one: the organizer's policy decides). */
export async function openChat(page) {
  if (await firstVisible(page, SEL.chatInput)) return true;
  await clickButton(page, SEL.chatOpen);
  await page.waitForTimeout(1000);
  return Boolean(await firstVisible(page, SEL.chatInput));
}

/** Runs inside the Teams page: reports each new chat message once (not the bot's own, not the ones already there). */
export function chatWatcher({ messageSelector, senderSelector, botName }) {
  const seen = new WeakSet();
  for (const el of document.querySelectorAll(messageSelector)) seen.add(el);
  const scan = () => {
    for (const el of document.querySelectorAll(messageSelector)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const sender = el.querySelector(senderSelector) || el.closest('[data-tid]')?.querySelector(senderSelector);
      const name = (sender?.innerText || sender?.textContent || '').trim();
      const body = el.querySelector('[id^="content-"], [data-tid="message-body"]') || el;
      let text = (body.innerText || body.textContent || '').trim();
      if (name && text.startsWith(name)) text = text.slice(name.length).trim();
      if (!text || (botName && name === botName) || /^(you|me)$/i.test(name) || (window.ptSent && window.ptSent.has(text))) continue;
      window.ptChat(name || 'Someone', text.slice(0, 1000));
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 1000);
}

export const watchChat = (page, botName) => page.evaluate(chatWatcher, { messageSelector: SEL.chatMessage, senderSelector: SEL.chatSender, botName });

/** Posts a message to the meeting chat. */
export async function sendChat(page, message) {
  let input = await firstVisible(page, SEL.chatInput);
  if (!input) { await clickButton(page, SEL.chatOpen); await page.waitForTimeout(1000); input = await firstVisible(page, SEL.chatInput); }
  if (!input) throw new Error('The meeting chat is not available to guests in this meeting.');
  await page.evaluate((m) => { (window.ptSent ||= new Set()).add(m); }, message).catch(() => undefined);
  await input.click({ timeout: 3000 }).catch(() => undefined);
  if ((await input.evaluate((el) => el.tagName)) === 'TEXTAREA') await input.fill(message);
  else await page.keyboard.insertText(message);
  await page.keyboard.press('Enter');
}

/** Whether the call is over for the bot: the end page, or no Leave button any more. */
export async function isOver(page, text) {
  return TEXT.ended.test(text) || !(await page.getByRole('button', { name: SEL.leave }).count());
}

export const isAlone = (text) => TEXT.alone.test(text);

/** Microphone on, to speak (the bot stays muted otherwise). True when it is on. */
export async function unmute(page) {
  if (await clickButton(page, SEL.micOn)) { await page.waitForTimeout(300); return true; }
  const off = page.getByRole('button', { name: SEL.micOff }).first();
  return (await off.count()) > 0 && await off.isVisible().catch(() => false);
}

export async function mute(page) {
  await clickButton(page, SEL.micOff);
}

export async function leave(page) {
  await clickButton(page, SEL.leave);
  await page.waitForTimeout(500);
  // New Teams may ask "Leave" vs "End meeting" for organizers; a guest never ends it for everyone.
  await clickButton(page, /^leave$/i).catch(() => undefined);
}
