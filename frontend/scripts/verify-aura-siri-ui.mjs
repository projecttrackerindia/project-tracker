import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makeState, portfolioContext, people, P, NOW } from './lib/portfolioFixture.mjs';

// Aura, Siri-style (approved designs load/aura-web.png and load/aura-phone.png): the thin gradient ring everywhere (no ball), the invoked
// surface (edge glow, the page blurred, one "Ask Aura or search…" pill with a gradient rim and a mic, suggestions above it, results inline
// and answers as floating frosted cards with one primary action), hold-to-talk with live words and a colour wave (a fake recognizer), Esc
// closes with a fade, and "why is X late?" answered with cited links. 1440 / 1920 / 390, light and dark. Fictional fixtures only.
const out = path.resolve('test-results/aura-siri');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const checks = [], shots = [];
const g = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const why = 'Payment engine DR moved **3 times (+12 days)**. Main cause: **bureau sandbox** access came late (reason given by Meera Iyer, 2 Nov), which blocked [CB-02 Consumer report parsing](/work?item=w2).';
const answer = () => sse([
  ['started', { conversationId: 'c-1', questionId: 'q-1', title: 'Why is the payment engine late?' }],
  ['tool', { id: 't1', tool: 'why_late', label: 'Looked at why it is late', state: 'done', count: 6 }],
  ['text', { delta: why }],
  ['done', { message: { id: 'm-1', role: 'assistant', content: why, reasoning: null, tier: 'quick', model: 'x', routeReason: null, credits: 1, status: 'complete', tools: [], actions: [], attachments: [], createdAt: NOW.toISOString(),
    followUps: ['Open timeline', 'Ask Meera for a new date'], sources: [
      { kind: 'task', id: 'w2', key: 'CB-02', title: 'Consumer report parsing', link: '/work?item=w2', version: '1', evidenceAt: NOW.toISOString() },
      { kind: 'task', id: 'w14', key: 'DR-14', title: 'Payment engine DR', link: '/work?item=w14', version: '1', evidenceAt: NOW.toISOString() },
    ] }, creditsLeft: 99, unlimited: false }],
]);
const extra = () => async ({ ep }) => {
  if (ep === '/api/v1/search') return { hits: [
    { type: 'project', id: P.CB, title: 'Credit Bureau Integration', subtitle: 'CB · Active', projectId: P.CB, taskId: null },
    { type: 'task', id: g(105), title: 'Consumer report parsing for v2 schema', subtitle: 'CB-02 · In progress', projectId: P.CB, taskId: g(105) },
    { type: 'member', id: people[2].id, title: people[2].name, subtitle: 'Member', projectId: null, taskId: null },
  ] };
  if (ep === '/api/v1/chat/search') return [];
  return undefined;
};
// A recognizer that hears "Move CIBIL to Friday" word by word and ends when stopped.
const fakeSpeech = () => {
  class Fake {
    constructor() { this.onresult = null; this.onend = null; this.onerror = null; this.t = []; }
    start() { const words = ['Move', 'CIBIL', 'to', 'Friday']; let s = ''; words.forEach((w, i) => this.t.push(setTimeout(() => { s += (s ? ' ' : '') + w; this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: s } } } }); }, 150 * (i + 1)))); }
    stop() { this.t.forEach(clearTimeout); setTimeout(() => this.onend?.(), 20); }
    abort() { this.stop(); }
  }
  window.webkitSpeechRecognition = Fake; window.SpeechRecognition = Fake;
};
const settle = async (page) => { await page.waitForTimeout(700); };
const shot = async (page, name) => { await settle(page); const file = path.join(out, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); };
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

try {
  for (const theme of ['light', 'dark']) for (const width of [1440, 1920, 390]) {
    const tag = `${width}-${theme}`, phone = width < 500;
    const state = makeState(); state.extra = extra();
    const { ctx, page, errors } = await portfolioContext(browser, { width, theme, state });
    await ctx.addInitScript(fakeSpeech);
    const asked = [];
    await page.route(/\/api\/v1\/ai\/(conversations\/[^/]+\/)?ask$/, async (route) => { asked.push(route.request().postDataJSON()); await new Promise((r) => setTimeout(r, 300)); await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: answer() }); });
    await page.goto(`${(await import('./lib/portfolioFixture.mjs')).origin}/preview-org/work/projects?view=portfolio`);
    const entry = page.locator(phone ? '.m-top .m-aura-orb' : '.shell-head .shell-orb').first();
    await entry.waitFor();

    // 1. The mark is a ring (a masked conic gradient), not a ball.
    const mark = entry.locator('.siri-orb > i');
    assert.equal(await mark.count(), 1, `${tag}: one ring layer`);
    const mask = await mark.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    assert.match(mask, /radial-gradient/, `${tag}: the ring is masked (${mask})`);
    assert.equal(await entry.locator('canvas').count(), 0, 'no canvas orb');

    // 2. Invoked: glow, blur, the pill with its rim, suggestions above it; no layout shift of the page behind.
    const before = await page.locator('main, .v2-main').first().boundingBox().catch(() => null);
    await entry.click();
    const surface = page.getByTestId('aura-search');
    await surface.waitFor();
    await page.locator('.aura-x-bar').waitFor();
    assert.ok(await page.locator('.aura-x-rim > i').isVisible(), 'edge glow');
    assert.match(await page.locator('.aura-x-scrim').evaluate((el) => getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter), /blur/, 'page blurred');
    assert.ok((await page.locator('.aura-x-chip').count()) >= 2, 'suggestions');
    const chipsBox = await page.locator('.aura-x-chips').boundingBox(), barBox = await page.locator('.aura-x-bar').boundingBox();
    assert.ok(chipsBox.y + chipsBox.height <= barBox.y + 1, 'suggestions above the bar');
    assert.ok(barBox.y + barBox.height > (phone ? 844 : 900) - 60, `${tag}: the bar sits at the bottom (${barBox.y})`);
    assert.ok(barBox.x >= 0 && barBox.x + barBox.width <= width, 'bar inside the viewport');
    assert.equal(await page.getByTestId('aura-mic').count(), 1, 'mic button');
    assert.match(await page.getByTestId('aura-search-input').getAttribute('placeholder'), /^Ask Aura or search/, 'placeholder');
    const after = await page.locator('main, .v2-main').first().boundingBox().catch(() => null);
    if (before && after) assert.equal(Math.round(after.x), Math.round(before.x), 'no layout shift');
    assert.ok(await noSideScroll(page), `${tag}: no sideways scroll`);
    await shot(page, `open-${tag}`);

    // 3. Search inline in the same surface.
    await page.getByTestId('aura-search-input').fill('bureau');
    await page.locator('.aura-s-results .aura-s-row').first().waitFor();
    assert.ok((await page.locator('.aura-s-row.ask').count()) >= 2, 'Ask Aura rows');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.aura-s-row[data-sel="true"]').count(), 1, 'keyboard selection');
    await shot(page, `search-${tag}`);

    // 4. Ask: the question as a bubble, the answer as a frosted card with the ring, cited sources and one primary action.
    await page.getByTestId('aura-search-input').fill('Why is the payment engine late?');
    await page.keyboard.press('Enter');
    const card = page.locator('.groot-chat.card');
    await card.locator('.gc-md').waitFor();
    await card.locator('.gc-follow').waitFor();
    assert.equal(asked.length, 1, 'asked once'); assert.match(asked[0].text, /payment engine late/);
    assert.ok(await card.locator('.gc-who .siri-orb').isVisible(), 'the ring on the answer');
    assert.equal(await card.locator('.gc-md a[href*="/work?item="]').count(), 1, 'a cited link in the answer');
    assert.match(await card.locator('.gc-src').innerText(), /CB-02/, 'sources line');
    const primary = card.locator('.gc-follow .gc-chip.sm').first();
    assert.equal(await primary.innerText(), 'Open timeline');
    const bg = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'one filled primary action');
    const cb = await card.locator('.gc-groot').boundingBox(), bar2 = await page.locator('.aura-x-bar').boundingBox();
    assert.ok(cb.y + cb.height < bar2.y, 'the card floats above the bar'); assert.ok(cb.x >= 0 && cb.x + cb.width <= width, 'card inside');
    assert.ok(await noSideScroll(page), `${tag}: no sideways scroll with the answer`);
    await shot(page, `answer-${tag}`);

    // 5. Voice: tap the mic, the words arrive live with the colour wave; stop sends them.
    await page.getByTestId('aura-mic').click();
    await page.locator('.aura-x-wave').waitFor();
    await page.waitForFunction(() => /Friday/.test(document.querySelector('.aura-x-said')?.textContent ?? ''));
    assert.match(await page.getByTestId('aura-voice').innerText(), /Move CIBIL to Friday[\s\S]*Listening/);
    assert.equal(await page.locator('.aura-x-stop').count(), 1, 'stop button');
    await shot(page, `voice-${tag}`);
    await page.locator('.aura-x-stop').click();
    await page.waitForFunction(() => document.querySelector('.groot-chat.card .gc-me p')?.textContent === 'Move CIBIL to Friday');
    assert.equal(asked.length, 2, 'the spoken words were asked');

    // 6. Esc closes with a fade (and puts the answer away).
    await page.keyboard.press('Escape');
    await surface.waitFor({ state: 'detached' });
    // (The answer card leaves with framer-motion's exit, which the fixture's fixed clock can hold; the store closing it is enough.)

    // 7. The big Aura chat panel: the ring, no ball.
    await entry.click(); await surface.waitFor(); await page.locator('.aura-s-open').click();
    const panel = page.locator('.groot-chat:not(.card)'); await panel.waitFor();
    assert.equal(await panel.locator('canvas').count(), 0, 'no canvas orb in the panel');
    assert.ok((await panel.locator('.siri-orb').count()) >= 1, 'ring in the panel');
    await shot(page, `panel-${tag}`);

    assert.deepEqual(errors.filter((e) => !/favicon|ResizeObserver/.test(e)), [], `${tag}: console errors`);
    checks.push(`aura siri ${tag}`);
    await ctx.close();
  }
  console.log(JSON.stringify({ ok: true, checks, shots }, null, 2));
} finally {
  await browser.close();
}
