// Everything that depends on how the Google Meet page looks lives in this one file. When Google changes the Meet screen, this is the
// file to update (the synthetic page in test/fake-meet.html mirrors the structure relied on here).

/** Buttons and fields, found by their accessible names first (most stable), with fallbacks. */
export const SEL = {
  nameInput: ['input[aria-label="Your name"]', 'input[placeholder="Your name"]', 'input[type="text"][autocomplete="name"]'],
  join: /^(ask to join|join now|join anyway|switch here)$/i,
  dismiss: /^(got it|dismiss|close|continue without microphone and camera|continue without microphone|ok)$/i,
  micOff: /turn off microphone/i,
  camOff: /turn off camera/i,
  leave: /leave call/i,
  captionsOn: /turn on captions/i,
  captionsOff: /turn off captions/i,
  chatOpen: /chat with everyone|open chat|^chat$/i,
  chatInput: ['textarea[aria-label="Send a message"]', 'textarea[aria-label^="Send a message"]', 'textarea[placeholder^="Send a message"]', 'div[contenteditable="true"][aria-label^="Send a message"]'],
  captionsRegion: 'div[role="region"][aria-label="Captions"], div[role="region"][aria-label^="Captions"]',
  // One chat message each; the sender is on the message or on the group of messages it belongs to.
  chatMessage: '[data-message-id]',
  chatSender: '[data-sender-name]',
  captionLanguage: /(meeting language|caption(s)? language|spoken language|language of the meeting)/i,
};

/** Words on the page that say the bot's attempt to join failed or the meeting is over. */
export const TEXT = {
  denied: /(someone in the call denied your request|no one responded to your request|you can't join this video call|you cannot join this video call|this meeting has been locked|your request to join was declined)/i,
  ended: /(you left the meeting|the call has ended|you've been removed from the meeting|you have been removed from the meeting|this call has ended|meeting has ended)/i,
  waiting: /(asking to be let in|asking to join|you'll join the call when someone lets you in|waiting for the host|please wait until a meeting host brings you into the call)/i,
  alone: /(you're the only one here|you are the only one here|no one else is here)/i,
};

const firstVisible = async (page, selectors) => {
  for (const s of selectors) {
    const l = page.locator(s).first();
    if (await l.count() && await l.isVisible().catch(() => false)) return l;
  }
  return null;
};

/** Clicks the first visible button with this name. True only when the click went through (a disabled or covered button is not clicked). */
const clickButton = async (page, name) => {
  const b = page.getByRole('button', { name }).first();
  if (!(await b.count()) || !(await b.isVisible().catch(() => false))) return false;
  return b.click({ timeout: 5000 }).then(() => true, () => false);
};
const visibleButton = async (page, name) => {
  const b = page.getByRole('button', { name }).first();
  return (await b.count()) > 0 && await b.isVisible().catch(() => false);
};

/** What the page shows right now, for the bot's log: in the call, waiting in the lobby, refused, or still on the join screen. */
export async function lobbyState(page) {
  if (await visibleButton(page, SEL.leave)) return 'in the call';
  const text = await pageText(page);
  if (TEXT.denied.test(text)) return 'refused';
  if (TEXT.waiting.test(text)) return 'waiting in the lobby';
  if (await visibleButton(page, SEL.join)) return 'still on the join screen';
  return 'unknown: ' + text.replace(/\s+/g, ' ').trim().slice(0, 160);
}

export const name = 'meet';

export const pageText = (page) => page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

/** With a signed-in account: true when Google shows a sign-in prompt or the guest name field instead (the cookies have expired). */
export async function signedOut(page) {
  await page.waitForTimeout(2500);
  if (/accounts\.google\.com/.test(page.url())) return true;
  return Boolean(await firstVisible(page, SEL.nameInput));
}

/** The pre-join screen: type the bot's name, switch off camera and microphone, ask to join. */
export async function askToJoin(page, botName, log) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await clickButton(page, SEL.dismiss);
    const input = await firstVisible(page, SEL.nameInput);
    if (input) { await input.fill(botName); }
    await clickButton(page, SEL.micOff);
    await clickButton(page, SEL.camOff);
    if (await clickButton(page, SEL.join)) {
      // Meet only shows the request to the host once the lobby says "Asking to join…". A click that did not register (the button was not
      // ready yet) leaves the join screen up; then try again instead of waiting in front of a request nobody can see.
      const settle = Date.now() + 10_000;
      while (Date.now() < settle) {
        await page.waitForTimeout(700);
        const state = await lobbyState(page);
        if (state === 'refused') throw new Error('Google Meet does not let the bot join this meeting.');
        if (state === 'in the call' || state === 'waiting in the lobby') { log(state === 'in the call' ? 'joined' : 'asked to join (waiting in the lobby)'); return; }
        if (state.startsWith('unknown') && !(await visibleButton(page, SEL.join))) { log('asked to join (' + state + ')'); return; }
      }
      log('the join request did not register; trying again');
      continue;
    }
    if (TEXT.denied.test(await pageText(page))) throw new Error('Google Meet does not let the bot join this meeting.');
    await page.waitForTimeout(1000);
  }
  throw new Error('The Google Meet join screen did not appear.');
}

/** Waits until someone admits the bot (the call controls appear), the request is refused, or time runs out. */
export async function waitUntilAdmitted(page, timeoutMs, log = () => undefined) {
  const deadline = Date.now() + timeoutMs;
  let report = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const leave = page.getByRole('button', { name: SEL.leave }).first();
    if (await leave.count() && await leave.isVisible().catch(() => false)) return 'admitted';
    const text = await pageText(page);
    if (TEXT.denied.test(text)) return 'denied';
    if (TEXT.ended.test(text)) return 'denied';
    await clickButton(page, SEL.dismiss);
    // Back on the join screen (the request lapsed or the page reloaded): ask again so the host sees it.
    if (!TEXT.waiting.test(text) && await visibleButton(page, SEL.join) && await clickButton(page, SEL.join)) log('asked to join again');
    if (Date.now() > report) { log('lobby: ' + await lobbyState(page)); report = Date.now() + 120_000; }
    await page.waitForTimeout(1500);
  }
  return 'timeout';
}

/** Turns on Meet's live captions (the transcript comes from them). The "c" shortcut is the fallback. */
export async function enableCaptions(page) {
  for (let i = 0; i < 5; i++) {
    if (await page.locator(SEL.captionsRegion).count()) return true;
    if (!(await clickButton(page, SEL.captionsOn))) await page.keyboard.press('c').catch(() => undefined);
    await page.waitForTimeout(1500);
    if (await page.getByRole('button', { name: SEL.captionsOff }).count()) return true;
  }
  return (await page.locator(SEL.captionsRegion).count()) > 0;
}

/**
 * Sets the language Meet captions people in (its "meeting language"), when Meet offers that language - captions in the wrong language are
 * gibberish. Best effort: false when the control or the language is not there.
 */
export async function setCaptionLanguage(page, language) {
  const escaped = language.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const wanted = new RegExp('^' + escaped + '\\b', 'i');
  for (const role of ['combobox', 'button']) {
    const control = page.getByRole(role, { name: SEL.captionLanguage }).first();
    if (!(await control.count()) || !(await control.isVisible().catch(() => false))) continue;
    if (wanted.test(((await control.innerText().catch(() => '')) || '').trim())) return true;
    await control.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(600);
    for (const optionRole of ['option', 'menuitemradio', 'radio', 'menuitem']) {
      const option = page.getByRole(optionRole, { name: wanted }).first();
      if (await option.count() && await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape').catch(() => undefined);
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  return false;
}

/**
 * Runs inside the Meet page: watches the captions region and reports each finished utterance (speaker + words) through the exposed
 * `ptCaption` function. A caption block keeps growing while someone speaks; it is reported once it has been still for a moment or has gone,
 * and if it grows again afterwards only the new words are reported.
 */
export function captionWatcher(regionSelector) {
  const sent = new WeakMap();       // block -> text already reported
  const seen = new WeakMap();       // block -> { text, at }
  const blocks = new Set();
  const read = (block) => {
    const lines = (block.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const nameEl = block.querySelector('[data-speaker-name], .speaker-name');
    const name = (nameEl?.textContent || lines[0]).trim();
    const text = (nameEl ? lines.filter((l) => l !== name) : lines.slice(1)).join(' ').trim();
    return text ? { name, text } : null;
  };
  const flush = (block, force) => {
    const now = read(block);
    const last = seen.get(block);
    if (!now) return;
    if (!force && (!last || last.text !== now.text || Date.now() - last.at < 1800)) return;
    const done = sent.get(block) || '';
    if (now.text === done) return;
    const fresh = done && now.text.startsWith(done) ? now.text.slice(done.length).trim() : now.text;
    sent.set(block, now.text);
    if (fresh) window.ptCaption(now.name, fresh);
  };
  const scan = () => {
    const region = document.querySelector(regionSelector);
    if (!region) return;
    const current = new Set(Array.from(region.children).filter((el) => el instanceof HTMLElement && (el.innerText || '').trim()));
    for (const b of blocks) if (!current.has(b)) { flush(b, true); blocks.delete(b); }
    for (const b of current) {
      blocks.add(b);
      const r = read(b);
      const last = seen.get(b);
      if (r && (!last || last.text !== r.text)) seen.set(b, { text: r.text, at: Date.now() });
      else flush(b, false);
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 700);
  window.ptFlushCaptions = () => { for (const b of blocks) flush(b, true); };
}

export const watchCaptions = (page) => page.evaluate(captionWatcher, SEL.captionsRegion);

/** Opens the chat panel (to read what people write there). */
export async function openChat(page) {
  if (await firstVisible(page, SEL.chatInput)) return true;
  await clickButton(page, SEL.chatOpen);
  await page.waitForTimeout(800);
  return Boolean(await firstVisible(page, SEL.chatInput));
}

/**
 * Runs inside the Meet page: reports each new chat message (sender + text) through the exposed `ptChat` function, once. Messages that were
 * already there when it started are not reported, and neither are the bot's own (its sender is "You", or it is something the bot just sent).
 */
export function chatWatcher({ messageSelector, senderSelector, botName }) {
  const seen = new WeakSet();
  for (const el of document.querySelectorAll(messageSelector)) seen.add(el);
  const own = /^(you|me)$/i;
  const scan = () => {
    for (const el of document.querySelectorAll(messageSelector)) {
      if (seen.has(el)) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) continue;
      seen.add(el);
      const holder = el.closest(senderSelector);
      let name = holder?.getAttribute('data-sender-name') || '';
      if (!name) {
        const group = el.parentElement?.closest('div');
        name = (group?.firstElementChild?.innerText || '').split('\n')[0].trim();
      }
      if (own.test(name) || (botName && name === botName) || (window.ptSent && window.ptSent.has(text))) continue;
      window.ptChat(name || 'Someone', text.slice(0, 1000));
    }
  };
  new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
  setInterval(scan, 1000);
}

export const watchChat = (page, botName) => page.evaluate(chatWatcher, { messageSelector: SEL.chatMessage, senderSelector: SEL.chatSender, botName });

/** Posts a message to everyone in the meeting chat (opens the chat panel if needed). */
export async function sendChat(page, message) {
  let input = await firstVisible(page, SEL.chatInput);
  if (!input) { await clickButton(page, SEL.chatOpen); await page.waitForTimeout(800); input = await firstVisible(page, SEL.chatInput); }
  if (!input) throw new Error('The meeting chat is not available (the host may have switched it off).');
  await page.evaluate((m) => { (window.ptSent ||= new Set()).add(m); }, message).catch(() => undefined);
  await input.fill(message);
  await input.press('Enter');
}

/** Whether the call is over for the bot: the end page, or no Leave button any more. */
export async function isOver(page, text) {
  return TEXT.ended.test(text) || !(await page.getByRole('button', { name: SEL.leave }).count());
}

export const isAlone = (text) => TEXT.alone.test(text);

export async function leave(page) {
  await clickButton(page, SEL.leave);
}
