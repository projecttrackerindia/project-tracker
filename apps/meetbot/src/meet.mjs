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
};

/** Words on the page that say the bot's attempt to join failed or the meeting is over. */
export const TEXT = {
  denied: /(someone in the call denied your request|no one responded to your request|you can't join this video call|you cannot join this video call|this meeting has been locked|your request to join was declined)/i,
  ended: /(you left the meeting|the call has ended|you've been removed from the meeting|you have been removed from the meeting|this call has ended|meeting has ended)/i,
  waiting: /(asking to be let in|you'll join the call when someone lets you in|waiting for the host|please wait until a meeting host brings you into the call)/i,
  alone: /(you're the only one here|you are the only one here|no one else is here)/i,
};

const firstVisible = async (page, selectors) => {
  for (const s of selectors) {
    const l = page.locator(s).first();
    if (await l.count() && await l.isVisible().catch(() => false)) return l;
  }
  return null;
};

const clickButton = async (page, name) => {
  const b = page.getByRole('button', { name }).first();
  if (await b.count() && await b.isVisible().catch(() => false)) { await b.click({ timeout: 5000 }).catch(() => undefined); return true; }
  return false;
};

export const pageText = (page) => page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

/** The pre-join screen: type the bot's name, switch off camera and microphone, ask to join. */
export async function askToJoin(page, botName, log) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await clickButton(page, SEL.dismiss);
    const input = await firstVisible(page, SEL.nameInput);
    if (input) { await input.fill(botName); }
    await clickButton(page, SEL.micOff);
    await clickButton(page, SEL.camOff);
    if (await clickButton(page, SEL.join)) { log('asked to join'); return; }
    if (TEXT.denied.test(await pageText(page))) throw new Error('Google Meet does not let the bot join this meeting.');
    await page.waitForTimeout(1000);
  }
  throw new Error('The Google Meet join screen did not appear.');
}

/** Waits until someone admits the bot (the call controls appear), the request is refused, or time runs out. */
export async function waitUntilAdmitted(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const leave = page.getByRole('button', { name: SEL.leave }).first();
    if (await leave.count() && await leave.isVisible().catch(() => false)) return 'admitted';
    const text = await pageText(page);
    if (TEXT.denied.test(text)) return 'denied';
    if (TEXT.ended.test(text)) return 'denied';
    await clickButton(page, SEL.dismiss);
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

/** Posts a message to everyone in the meeting chat (opens the chat panel if needed). */
export async function sendChat(page, message) {
  let input = await firstVisible(page, SEL.chatInput);
  if (!input) { await clickButton(page, SEL.chatOpen); await page.waitForTimeout(800); input = await firstVisible(page, SEL.chatInput); }
  if (!input) throw new Error('The meeting chat is not available (the host may have switched it off).');
  await input.fill(message);
  await input.press('Enter');
}

export async function leave(page) {
  await clickButton(page, SEL.leave);
}
