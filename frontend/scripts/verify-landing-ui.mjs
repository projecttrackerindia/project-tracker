import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { cspFor } from './lib/csp.mjs';

// The public landing page (src/features/landing): what someone signed out sees at "/" and anyone at /welcome. The hero and the nav with
// its seven section links, every section present, Sign in → /login and Try it free → sign-up, the in-page links scroll, the hero window
// rises flat and the statement lights up as the page scrolls, "Five places" swaps its screen, the flow-to-orb scene plays, with reduced
// motion every scene rests on its final state, nothing scrolls sideways at 1440 or 390, the phone menu is a bottom sheet with 44px
// targets, the final call to action leads to the existing sign-in options, and a signed-in visitor goes straight into the app.
// Screenshots of every section at 1440 and 390, and of sign-in and sign-up in light and dark. Synthetic data only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/landing-ui');
await fs.mkdir(out, { recursive: true });
const pageCsp = await cspFor();
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const pricing = { policy: { annualDiscountPercent: 20, maxTotalDiscountPercent: 30, volumeTiers: [] }, plans: [{ code: 'FREE', priceMonthly: 0, currency: 'INR', perSeat: false }, { code: 'PRO', priceMonthly: 449, currency: 'INR', perSeat: true }, { code: 'BUSINESS', priceMonthly: 999, currency: 'INR', perSeat: true }, { code: 'ENTERPRISE', priceMonthly: null, currency: 'INR', perSeat: false }] };
const SECTIONS = ['how', 'places', 'create', 'ai', 'portfolio', 'trust', 'pricing'];
const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });

const make = async ({ w = 1440, h = 900, signedIn = false, reduced = false, theme = 'light', mobile = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference', colorScheme: theme, isMobile: mobile, hasTouch: mobile, timezoneId: 'Asia/Kolkata' });
  // No saved theme: sign-in and sign-up follow the system's light or dark setting (colorScheme).
  await ctx.addInitScript((s) => { localStorage.setItem('pm_alerts_prompt', '1'); if (s) localStorage.setItem('pm_hint', '1'); }, signedIn);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname;
    if (url.origin !== origin) { await route.abort(); return; }
    if (ep.startsWith('/api/')) {
      assert.ok(req.method() === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${req.method()} ${ep}`);
      if (ep === '/api/v1/public/pricing') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: pricing }) }); return; }
      if (ep === '/api/v1/auth/providers') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { providers: [{ id: 'google', name: 'Google' }, { id: 'microsoft', name: 'Microsoft' }, { id: 'github', name: 'GitHub' }] } }) }); return; }
      if (ep.includes('password-policy')) { await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { minLength: 8, requireUpper: false, requireLower: false, requireDigit: false, requireSymbol: false } }) }); return; }
      if (!signedIn) { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'signed out', errors: [] }) }); return; }
      let data = null;
      if (ep.endsWith('/auth/refresh')) data = { accessToken: `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`, expiresAt: '2099-01-01T00:00:00Z', user };
      else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['projects.view', 'tasks.view', 'work.view'], modules: { projects: 3, tasks: 3, work: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: {} } };
      else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
      else if (ep === '/api/v1/inbox') data = { rows: [], counts: { all: 0, assigned: 0, decisions: 0, mentions: 0 }, later: 0 };
      else if (ep === '/api/v1/inbox/briefing') data = { count: 0, headline: "You're all caught up.", reasons: [], sources: 'read your work', stats: { overdue: 0, dueToday: 0, decisions: 0, approvals: 0, mentions: 0, reminders: 0 } };
      else if (/\/(calendar|projects|reminders|notifications|teams|members)$/.test(ep)) data = [];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
      return;
    }
    let file = path.resolve(dist, ep.slice(1));
    if (ep.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(dist) || !(await fs.stat(file).catch(() => null))?.isFile()) file = path.join(dist, 'index.html');
    await route.fulfill({ contentType: types[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: file.endsWith('.html') ? { 'content-security-policy': pageCsp(file) } : {} });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${w}${reduced ? ' reduced' : ''}: ${e.message}`));
  return { ctx, page };
};
const noSideways = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label} scrolls sideways`);
const shotSections = async (page, w) => {
  const list = [['hero', '.lp-hero'], ['words', '#how'], ['how-it-thinks', '.lp-core'], ['five-places', '#places'], ['create', '#create'], ['ai', '#ai'], ['moments', '#moments'], ['portfolio', '#portfolio'], ['counts', '.lp-band.lp-white:not([id])'], ['privacy', '#trust'], ['tools', '#tools'], ['pricing', '#pricing'], ['faq', '#faq'], ['final', '#start'], ['footer', '.lp-foot']];
  for (const [name, sel] of list) {
    const el = page.locator(sel).first();
    await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(name === 'how-it-thinks' ? 6000 : 900);
    // the tall scroll scenes are shot as the screen shows them, the rest whole
    if (['hero', 'words', 'five-places'].includes(name)) await page.screenshot({ path: path.join(out, `${name}-${w}.png`) });
    else await el.screenshot({ path: path.join(out, `${name}-${w}.png`) });
  }
};

try {
  // ---------------------------------------------------------------- desktop, signed out
  {
    const { ctx, page } = await make({ w: 1440, h: 900 });
    await page.goto(`${origin}/`);
    await page.locator('.lp-hero h1', { hasText: 'Work, on autopilot.' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/', 'signed out stays on the home address');
    assert.ok((await page.title()).length > 10, 'the home page keeps its search title');
    assert.ok(await page.locator('meta[name="description"]').getAttribute('content'));
    assert.ok((await page.locator('meta[property="og:image"]').getAttribute('content')).endsWith('/og-image.png'));
    assert.ok((await page.locator('meta[property="og:title"]').getAttribute('content')).length > 0);
    assert.equal(await page.locator('#site main').count(), 0, 'no second static landing page behind the app');
    const links = await page.locator('.lp-nav > .lp-wrap > nav a').allTextContents();
    assert.deepEqual(links, ['Overview', 'Five places', 'Create', 'AI', 'Portfolio', 'Privacy', 'Pricing']);
    assert.equal(await page.locator('.lp-nav .lp-signin').getAttribute('href'), '/login');
    assert.equal(await page.locator('.lp-nav .lp-nav-try').getAttribute('href'), '/signup');
    for (const id of [...SECTIONS, 'moments', 'tools', 'faq', 'start']) assert.equal(await page.locator(`section#${id}`).count(), 1, `section #${id}`);
    assert.equal(await page.locator('.lp-hero .lp-cta a', { hasText: 'Try it free' }).getAttribute('href'), '/signup');
    // the hero window starts tilted and lies flat once scrolled
    const tilt0 = await page.locator('.lp-device').evaluate((e) => e.style.transform || getComputedStyle(e).transform);
    assert.match(tilt0, /rotateX\(28deg\)|matrix3d/);
    await page.locator('.lp-hero .lp-cta a', { hasText: 'See how it works' }).click();
    await page.waitForTimeout(1400);
    assert.equal(new URL(page.url()).hash, '', 'in-page links keep the address clean');
    const howTop = await page.locator('#how').evaluate((e) => e.getBoundingClientRect().top);
    assert.ok(Math.abs(howTop - 52) < 60, `See how it works scrolls to the statement (${howTop})`);
    const flat = await page.locator('.lp-device').evaluate((e) => e.style.transform);
    assert.match(flat, /rotateX\(0deg\) scale\(1\)/, `the window is flat after the hero (${flat})`);
    // words light up as the statement scrolls
    const litAt = async (f) => { await page.evaluate((f) => { const s = document.getElementById('how'); window.scrollTo(0, s.offsetTop + (s.offsetHeight - innerHeight) * f); }, f); await page.waitForTimeout(250); return page.locator('#how span.lp-lit').count(); };
    const lit1 = await litAt(.1), lit2 = await litAt(.7);
    assert.ok(lit2 > lit1 && lit2 > 10, `words light up while scrolling (${lit1} → ${lit2})`);
    // Five places: the screen follows the scroll, and a click picks one
    const onAt = async (f) => { await page.evaluate((f) => { const s = document.getElementById('places'); window.scrollTo(0, s.offsetTop + (s.offsetHeight - innerHeight) * f); }, f); await page.waitForTimeout(300); return page.locator('.lp-phone').getAttribute('data-on'); };
    assert.equal(await onAt(.05), 'Home'); assert.equal(await onAt(.5), 'Talk'); assert.equal(await onAt(.95), 'Insights');
    await page.locator('.lp-list button', { hasText: 'Library' }).click(); await page.waitForTimeout(200);
    assert.equal(await page.locator('.lp-phone').getAttribute('data-on'), 'Library');
    assert.equal(await page.locator('.lp-view.lp-on h3').textContent(), 'Library');
    // the flow-to-orb scene plays through its phases
    await page.locator('.lp-core').scrollIntoViewIfNeeded(); await page.waitForTimeout(600);
    await page.locator('#lp-mindT', { hasText: 'Listening' }).waitFor();
    await page.locator('#lp-mindT', { hasText: 'Briefing ready' }).waitFor({ timeout: 8000 });
    await page.locator('#lp-phases li.lp-on', { hasText: 'Briefs you' }).waitFor();
    // the create demo types and understands
    await page.locator('#create').scrollIntoViewIfNeeded();
    await page.locator('#create .lp-kinds button', { hasText: 'Meeting' }).click();
    await page.locator('#create .lp-t', { hasText: 'Onboarding review' }).waitFor();
    await page.locator('#create .lp-chip.lp-in', { hasText: 'Meera, Dev' }).waitFor({ timeout: 6000 });
    // portfolio tabs and slides, pricing toggle with the live prices
    await page.locator('#portfolio [role=tab]', { hasText: 'Timeline' }).click(); await page.locator('#portfolio .lp-tl-row', { hasText: 'KYC Refresh' }).waitFor();
    await page.locator('#portfolio [role=tab]', { hasText: 'Present' }).click(); await page.locator('#portfolio .lp-sl-body h3', { hasText: 'KYC Refresh' }).waitFor();
    await page.locator('#portfolio [aria-label="Next project"]').click(); await page.locator('#portfolio .lp-sl-body h3', { hasText: 'Bank partner retries' }).waitFor();
    await page.locator('#portfolio [role=tab]', { hasText: 'Board' }).click();
    assert.match(await page.locator('[data-price="PRO"]').textContent(), /449/);
    await page.locator('#pricing .lp-bill button', { hasText: 'Yearly' }).click();
    assert.match(await page.locator('[data-price="PRO"]').textContent(), /359/);
    await page.locator('#pricing .lp-bill button', { hasText: 'Monthly' }).click();
    // the final call to action: the existing sign-in options
    await page.locator('#start .lp-alt', { hasText: 'Continue with Google' }).waitFor();
    await page.locator('#start .lp-alt', { hasText: 'Continue with Microsoft' }).waitFor();
    assert.equal(await page.locator('#start a', { hasText: 'Create account' }).getAttribute('href'), '/signup');
    assert.equal(await page.locator('#start a', { hasText: /^Sign in$/ }).getAttribute('href'), '/login');
    assert.equal(await page.locator('#start a', { hasText: 'Single sign-on' }).getAttribute('href'), '/login?sso=1');
    const foot = await page.locator('.lp-foot nav a').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute('href')]));
    assert.deepEqual(foot.map((f) => f[0]), ['Privacy', 'Terms', 'Security', 'Contact support@projecttracker.in']);
    assert.ok(foot[3][1].startsWith('mailto:support@projecttracker.in'));
    // every section, scrolled to the way a visitor would
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(400);
    await noSideways(page, '/ at 1440');
    await shotSections(page, 1440);
    checks.push('landing-1440');
    // Sign in and Try it free
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300);
    await page.locator('.lp-nav .lp-signin').click();
    await page.waitForURL(/\/login$/); await page.locator('input[type=password]').waitFor();
    await page.goto(`${origin}/`); await page.locator('.lp-hero h1').waitFor();
    await page.locator('.lp-nav .lp-nav-try').click();
    await page.waitForURL(/\/register$/); await page.getByLabel('Full name').waitFor();
    // the single sign-on button opens sign-in at its SSO step
    await page.goto(`${origin}/login?sso=1`); await page.locator('h1', { hasText: 'Single sign-on' }).waitFor();
    checks.push('cta-routes');
    // /welcome is the landing page for anyone, deep links still go where they did
    await page.goto(`${origin}/welcome`); await page.locator('.lp-hero h1').waitFor();
    await page.goto(`${origin}/work?item=abc`); await page.waitForURL(/\/login\?redirect=/);
    checks.push('welcome-and-deep-links');
    await ctx.close();
  }

  // ---------------------------------------------------------------- reduced motion: every scene at rest on its final state
  {
    const { ctx, page } = await make({ w: 1440, h: 900, reduced: true });
    await page.goto(`${origin}/`); await page.locator('.lp-hero h1').waitFor(); await page.waitForTimeout(400);
    assert.equal(await page.locator('.lp-device').evaluate((e) => getComputedStyle(e).transform), 'none', 'the window lies flat');
    const words = await page.locator('#how p span').count();
    assert.equal(await page.locator('#how span.lp-lit').count(), words, 'every word lit');
    assert.match(await page.locator('[data-lp="cine"]').getAttribute('class'), /lp-p2/, 'the briefing is shown');
    assert.equal(await page.locator('.lp-bi.lp-pre').count(), 0);
    assert.equal(await page.locator('#create .lp-chip:not(.lp-in)').count(), 0, 'the create example is complete');
    assert.equal(await page.locator('.lp-reveal.lp-pending').count(), 0, 'nothing waits to be revealed');
    assert.equal(await page.locator('.lp-hero').evaluate((e) => getComputedStyle(e).height === `${innerHeight * 1.9}px`), false, 'no tall scroll scenes');
    await page.locator('.lp-core').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
    await page.locator('.lp-core').screenshot({ path: path.join(out, 'reduced-how-it-thinks-1440.png') });
    await page.locator('#moments').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
    await page.locator('#moments').screenshot({ path: path.join(out, 'reduced-moments-1440.png') });
    checks.push('reduced-motion');
    await ctx.close();
  }

  // ---------------------------------------------------------------- phone
  for (const [w, h] of [[390, 844], [412, 915]]) {
    const { ctx, page } = await make({ w, h, mobile: true });
    await page.goto(`${origin}/`); await page.locator('.lp-hero h1').waitFor(); await page.waitForTimeout(500);
    await noSideways(page, `/ at ${w}`);
    assert.equal(await page.locator('.lp-nav > .lp-wrap > nav').isVisible(), false, 'section links fold into the menu');
    const btn = page.locator('.lp-menu-btn');
    const bb = await btn.boundingBox(); assert.ok(bb.width >= 44 && bb.height >= 44, 'menu button is a 44px target');
    const tb = await page.locator('.lp-nav .lp-nav-try').boundingBox(); assert.ok(tb.height >= 36);
    await btn.click();
    const sheet = page.locator('#lp-menu'); await sheet.waitFor(); await page.waitForTimeout(450);
    const sb = await sheet.boundingBox(); assert.ok(Math.abs(sb.y + sb.height - h) < 2 && sb.width === w, 'the menu is a bottom sheet');
    for (const a of await sheet.locator('nav a, .lp-sheet-cta a').all()) assert.ok((await a.boundingBox()).height >= 44, 'menu targets are 44px');
    if (w === 390) await page.screenshot({ path: path.join(out, `menu-${w}.png`) });
    await sheet.locator('nav a', { hasText: 'Pricing' }).click(); await page.waitForTimeout(2500);
    assert.equal(await sheet.count(), 0, 'choosing a section closes the menu');
    const pr = await page.locator('#pricing').evaluate((e) => e.getBoundingClientRect().top); assert.ok(Math.abs(pr - 52) < 60, `menu link scrolls to pricing (${pr})`);
    for (const sel of ['.lp-kinds button', '.lp-bill button', '.lp-pf-tabs button', '#start .lp-alt', '#start .lp-final-main a', '.lp-gnav button']) {
      for (const b of await page.locator(sel).all()) { const r = await b.boundingBox(); assert.ok(r && r.height >= 44, `${sel} is a 44px target (${r?.height})`); }
    }
    // the five places stack: list then screen, no pinning
    assert.notEqual(await page.locator('.lp-five-stick').evaluate((e) => getComputedStyle(e).position), 'sticky');
    if (w === 390) { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300); await shotSections(page, w); }
    await noSideways(page, `/ at ${w} after scrolling`);
    checks.push(`phone-${w}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- signed in: straight into the app
  {
    const { ctx, page } = await make({ w: 1440, h: 900, signedIn: true });
    await page.goto(`${origin}/`);
    await page.waitForURL((u) => u.pathname.startsWith('/preview-org'), { timeout: 15000 });
    assert.equal(await page.locator('.lp-root').count(), 0, 'no landing page for a signed-in visitor');
    checks.push('signed-in-to-app');
    await ctx.close();
  }

  // ---------------------------------------------------------------- sign-in and sign-up, light and dark, desktop and phone
  for (const theme of ['light', 'dark']) {
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      const { ctx, page } = await make({ w, h, theme, mobile: w < 500 });
      await page.goto(`${origin}/login`); await page.locator('input[type=password]').waitFor(); await page.waitForTimeout(900);
      for (const t of ['Remember me', 'Forgot password?', 'Phone', 'Google', 'GitHub', 'SSO']) await page.getByText(t, { exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme);
      assert.match(await page.locator('.auth-title').evaluate((e) => getComputedStyle(e).fontFamily), /Bricolage/);
      await noSideways(page, `/login ${theme} ${w}`);
      await page.screenshot({ path: path.join(out, `login-${theme}-${w}.png`), fullPage: true });
      await page.goto(`${origin}/signup`); await page.waitForURL(/\/register$/); await page.getByLabel('Full name').waitFor(); await page.waitForTimeout(900);
      await noSideways(page, `/register ${theme} ${w}`);
      await page.screenshot({ path: path.join(out, `signup-${theme}-${w}.png`), fullPage: true });
      await ctx.close();
    }
  }
  checks.push('auth-themes');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors }));
} finally { await browser.close(); }
