import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { cspFor } from './lib/csp.mjs';

// Library pages with their own look and motion. A page opens with a preset, its own (scoped) CSS and blocks that move: the Style panel
// switches presets, Advanced CSS styles the page's text and cannot reach the app around it (sidebar, page bar), malicious CSS is refused
// with errors by line, blocks rise in on scroll and stay put with reduced motion, Lottie / animated SVG / video / GIF / interactive embed
// render, the embed is sealed (window.parent throws, no localStorage, opaque origin), readers can pause motion, print shows stills, the
// Library settings switch embeds off, and phone + dark. Synthetic API only, under the app's real CSP (and the embed frame's own).
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist');
const out = path.resolve(process.env.PM_UI_ARTIFACTS || 'test-results/enterprise-ui', 'library-motion');
await fs.mkdir(out, { recursive: true });
const cspOf = await cspFor(dist);
const now = new Date().toISOString();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const DOC = '00000000-0000-0000-0000-00000000d201';
const F = { lottie: '00000000-0000-0000-0000-0000000f0001', video: '00000000-0000-0000-0000-0000000f0002', poster: '00000000-0000-0000-0000-0000000f0003', gif: '00000000-0000-0000-0000-0000000f0004' };

// ---- fixtures (made-up content)
const LOTTIE = { v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 120, nm: 'dot', ddd: 0, assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'circle', sr: 1, ao: 0, ip: 0, op: 60, st: 0, bm: 0,
  ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 1, k: [{ t: 0, s: [40, 60, 0], e: [160, 60, 0], i: { x: [0.5], y: [1] }, o: { x: [0.5], y: [0] } }, { t: 60 }] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
  shapes: [{ ty: 'gr', nm: 'g', it: [{ ty: 'el', nm: 'e', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 40] } }, { ty: 'fl', nm: 'f', c: { a: 0, k: [0.31, 0.27, 0.9, 1] }, o: { a: 0, k: 100 } },
    { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }] }] }] };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" rx="12" fill="#eef"/><circle cx="30" cy="30" r="14" fill="#4f46e5"><animate attributeName="cx" values="30;170;30" dur="2s" repeatCount="indefinite"/></circle></svg>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
let VIDEO = Buffer.from('1a45dfa3', 'hex');
try {
  const tmp = path.join(os.tmpdir(), `pm-motion-${process.pid}.webm`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libvpx', '-b:v', '60k', tmp]);
  VIDEO = await fs.readFile(tmp); await fs.rm(tmp, { force: true });
} catch { /* without ffmpeg the video block is still checked, just not played */ }

const t = (text) => ({ type: 'text', text });
const p = (text, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [t(text)] });
const h2 = (text) => ({ type: 'heading', attrs: { level: 2 }, content: [t(text)] });
const filler = (n) => Array.from({ length: n }, (_, i) => p(`Step ${i + 1}: the onboarding checklist keeps every new teammate on track with clear owners and dates.`));
const EMBED = { html: '<p id="out">Running</p>', css: 'p { font: 14px system-ui; color: #333 }', js: [
  "const r = [];",
  "try { r.push('parent:' + window.parent.document.title); } catch (e) { r.push('parent:blocked'); }",
  "try { r.push('ls:' + localStorage.length); } catch (e) { r.push('ls:blocked'); }",
  "try { r.push('cookie:' + (document.cookie === '' ? 'empty' : 'set')); } catch (e) { r.push('cookie:blocked'); }",
  "r.push('origin:' + window.origin);",
  "document.getElementById('out').textContent = r.join(' ');",
].join('\n') };
const body = (style) => JSON.stringify({ type: 'doc', ...(style ? { attrs: { pageStyle: style } } : {}), content: [
  p('Welcome to the Northwind onboarding tour. Everything a new teammate needs in the first week.'),
  h2('Your first day'), ...filler(3),
  p('This paragraph rises in as you reach it.', { motion: 'rise', motionDelay: 100, motionDuration: 400 }),
  { type: 'motionLottie', attrs: { fileId: F.lottie, caption: 'How a request flows', loop: true, autoplay: true, height: 200 } },
  h2('Tools you will use'), ...filler(4),
  { type: 'motionSvg', attrs: { svg: SVG, caption: 'The sync loop' } },
  { type: 'motionVideo', attrs: { fileId: F.video, posterId: F.poster, caption: 'Two-minute product tour', autoplay: true } },
  { type: 'docImage', attrs: { fileId: F.gif, alt: 'Loading spinner' } },
  h2('Try it'), ...filler(3),
  { type: 'sandboxEmbed', attrs: { ...EMBED, height: 160, caption: 'Isolation check' } },
  ...filler(4),
] });
const STYLE = { preset: 'editorial', css: '', animateSections: true, sectionTransition: 'line' };
const item = { id: DOC, key: 'DOC-21', number: 21, title: 'Onboarding tour', typeId: 't-PAGE', typeCode: 'PAGE', typeName: 'Page', typeColor: '#4f46e5', typeIcon: 'file', projectId: null, projectKey: null, projectName: null,
  teamId: null, teamName: null, owner: { id: user.id, name: 'Asha Rao' }, status: 'Published', visibility: 'Workspace', classification: 'Internal', tags: [], updatedAt: now, createdAt: now, linkedCount: 0, icon: '🧭', parentId: null, pageOrder: 0 };

// A requirements document (not a Page): sections, one of them tables only, with a style and motion; and a document of tables only.
const DOC2 = '00000000-0000-0000-0000-00000000d202', DOC3 = '00000000-0000-0000-0000-00000000d203';
const STYLE2 = { preset: 'editorial', css: 'h2 { color: rgb(220, 38, 38) }', animateSections: true, sectionTransition: 'line' };
const body2 = (style) => JSON.stringify({ type: 'doc', ...(style ? { attrs: { pageStyle: style } } : {}), content: [
  p('Northwind rollout covers the north region first, then the coast.', { motion: 'rise', motionDelay: 0, motionDuration: 400 }),
  { type: 'motionSvg', attrs: { svg: SVG, caption: 'Rollout map' } },
  p('Support is on call for the first week.'),
  h2('Milestones'), ...filler(6),
] });
const item2 = { ...item, id: DOC2, key: 'BRD-4', number: 4, title: 'Northwind rollout brief', typeId: 't-BRD', typeCode: 'BRD', typeName: 'Requirements', typeColor: '#0e7490', icon: null, visibility: 'Organization' };
const item3 = { ...item, id: DOC3, key: 'BRD-5', number: 5, title: 'Rollout risk register', typeId: 't-BRD', typeCode: 'BRD', typeName: 'Requirements', typeColor: '#0e7490', icon: null, visibility: 'Organization' };
const TABLE = JSON.stringify({ columns: ['Risk', 'Owner'], rows: [['Courier delay', 'Ravi Kumar']] });
const REWRITE = 'Rewritten: the rollout starts in the north and support stays on call.';

const errors = [], checks = [];
const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
const make = async ({ theme = 'light', edit = true, style = STYLE, design = { customCss: true, sandboxEmbeds: true }, opts = {} } = {}) => {
  const writes = [];
  let current = body(style); let revision = 3;
  let current2 = body2(STYLE2);
  const ctx = await browser.newContext({ timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', ...opts });
  // Only in the app's own window: the embed frames are sealed (no storage), which is the point.
  await ctx.addInitScript((th) => { if (window !== window.top) return; localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', th); localStorage.removeItem('pm_motion_paused'); }, theme);
  await ctx.route('**/*', async (route) => {
    const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
    if (url.origin !== origin || ep.startsWith('/hubs/')) { await route.abort(); return; }
    if (ep.endsWith('/avatar') || ep.endsWith('/logo/file') || ep.includes('/brand/')) { await route.fulfill({ status: 404, body: '' }); return; }
    if (!ep.startsWith('/api/')) {
      const rel = ep.startsWith('/assets/') || ep.startsWith('/embed/') ? ep.slice(1) : 'index.html';
      const file = path.resolve(dist, rel); assert.ok(file.startsWith(dist + path.sep));
      await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file),
        headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': cspOf(rel) } });
      return;
    }
    const reqBody = method === 'GET' || method === 'DELETE' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
    if (method !== 'GET' && !ep.endsWith('/auth/refresh')) writes.push({ ep, method, body: reqBody });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status < 300 ? { data } : data) });
    const detail = () => ({ item, revision, versionLabel: '1.0', can: { edit, delete: edit, link: edit, share: edit, publish: edit }, publishedLabel: '1.0', hasUnpublishedChanges: false, viewingPublished: !edit,
      sections: [{ key: 'body', title: 'Body', kind: 'RichText', sortOrder: 0, content: current }], maskedCount: 0 });
    const detail2 = (tablesOnly) => ({ item: tablesOnly ? item3 : item2, revision, versionLabel: '0.3', can: { edit, delete: edit, link: edit, share: edit, publish: edit }, publishedLabel: null, hasUnpublishedChanges: true, viewingPublished: false,
      sections: tablesOnly ? [{ key: 'risks', title: 'Risks', kind: 'Table', sortOrder: 0, content: TABLE }]
        : [{ key: 'overview', title: 'Overview', kind: 'RichText', sortOrder: 0, content: current2 }, { key: 'risks', title: 'Risks', kind: 'Table', sortOrder: 1, content: TABLE }], maskedCount: 0 });
    const fm = ep.match(/^\/api\/v1\/documents\/[^/]+\/files\/([^/]+)\/download$/);
    if (fm) {
      const [ct, buf] = fm[1] === F.lottie ? ['application/json', Buffer.from(JSON.stringify(LOTTIE))] : fm[1] === F.video ? ['video/webm', VIDEO] : fm[1] === F.gif ? ['image/gif', GIF] : ['image/png', PNG];
      await route.fulfill({ status: 200, contentType: ct, body: buf }); return;
    }
    let data = [];
    if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
    else if (ep === '/api/v1/me') data = { user, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, permissions: ['org.manage', 'projects.view', 'documents.view', ...(edit ? ['documents.edit'] : [])], modules: { projects: 3, documents: 3, work: 3, ai: 3, audit: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
    else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
    else if (ep === `/api/v1/documents/${DOC}`) data = detail();
    else if (ep === `/api/v1/documents/${DOC2}` || ep === `/api/v1/documents/${DOC3}`) data = detail2(ep.endsWith(DOC3));
    else if (ep === `/api/v1/documents/${DOC2}/style` && method === 'PUT') {
      revision++; const parsed = JSON.parse(current2); parsed.attrs = { pageStyle: reqBody.style }; current2 = JSON.stringify(parsed); data = detail2(false);
    }
    else if (ep === `/api/v1/documents/${DOC2}/sections` && method === 'PUT') {
      // As the server does: the stored style is put back on the text, whatever the editor sent.
      revision++; const sent = JSON.parse(reqBody.sections.find((x) => x.key === 'overview').content); const style = JSON.parse(current2).attrs; delete sent.attrs; current2 = JSON.stringify({ ...sent, ...(style ? { attrs: style } : {}) });
      data = detail2(false);
    }
    else if (ep === '/api/v1/documents/ai/transform' && method === 'POST') data = { text: REWRITE, blocks: JSON.stringify([{ type: 'paragraph', content: [t(REWRITE)] }]), model: 'preview', inline: false };
    else if (ep === `/api/v1/documents/${DOC}/style` && method === 'PUT') {
      const s = reqBody.style; revision++;
      const parsed = JSON.parse(current); parsed.attrs = { pageStyle: s }; current = JSON.stringify(parsed);
      data = detail();
    }
    else if (ep === `/api/v1/documents/${DOC}/sections` && method === 'PUT') { revision++; data = detail(); }
    else if (ep === '/api/v1/documents/library-design') { if (method === 'PUT') Object.assign(design, { customCss: reqBody.customCss, sandboxEmbeds: reqBody.sandboxEmbeds }); data = { ...design, canManage: true }; }
    else if (ep === `/api/v1/documents/${DOC}/files`) data = [{ id: F.lottie, fileName: 'request-flow.json', contentType: 'application/json', sizeBytes: 2400, isImage: false, uploadedBy: null, createdAt: now, canDelete: true }];
    else if (ep === '/api/v1/doctracker/catalog') data = { projects: [{ id: null, key: null, name: 'General', endpoints: [], definitions: [], documents: [{ ...item }], diagrams: 0 }], canCreate: true, isAdmin: true, truncated: 0 };
    else if (ep === '/api/v1/document-types') data = [{ id: 't-PAGE', code: 'PAGE', name: 'Page', description: null, icon: 'file', color: '#4f46e5', sections: [{ key: 'body', title: 'Body', kind: 'RichText', sortOrder: 0 }], sortOrder: 0 },
      { id: 't-BRD', code: 'BRD', name: 'Requirements', description: null, icon: 'file', color: '#0e7490', sections: [{ key: 'overview', title: 'Overview', kind: 'RichText', sortOrder: 0 }, { key: 'risks', title: 'Risks', kind: 'Table', sortOrder: 1 }], sortOrder: 1 }];
    else if (/^\/api\/v1\/documents\/[^/]+\/api$/.test(ep)) data = { definitions: [], endpoints: [] };
    else if (ep.endsWith('/review')) data = { workflowApplies: false, steps: [] };
    else if (ep.endsWith('/freshness')) data = { verifiedAt: null, verifiedBy: null, staleSince: null, staleReason: null, lastEditedAt: now };
    else if (ep.endsWith('/members')) data = [{ userId: 'u2', displayName: 'Ravi Kumar', email: 'ravi@example.test', role: 'Member' }];
    else if (ep.endsWith('/document-security/masking')) data = { enabled: true, builtIns: [], rules: [], canManage: true };
    else if (ep.startsWith('/api/v1/audit')) data = { items: [], page: 1, totalPages: 1, totalItems: 0 };
    else if (ep.endsWith('/secrets')) data = { items: [], canManage: edit };
    else if (ep.endsWith('/links')) data = { items: [], counts: {} };
    else if (ep === '/api/v1/timer') data = null;
    else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
    else if (ep.includes('/unread') || ep.includes('/counts')) data = { count: 0, total: 0 };
    else if (ep === '/api/v1/documents/inbox') data = { toReview: [], submitted: [], accessToDecide: [], myAccessRequests: [], waiting: 0 };
    await json(data);
  });
  const page = await ctx.newPage();
  // Playwright's own service-worker blocking reads navigator.serviceWorker in every frame; in a sealed frame that read throws (more proof
  // the frame has no same-origin access), so that one message is not an app error.
  page.on('pageerror', (e) => { if (/Service worker is disabled because the context is sandboxed/.test(e.message)) return; errors.push(e.message); });
  return { ctx, page, writes, design, stored2: () => current2 };
};
const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, name) }); };
const open = async (page) => { await page.goto(`${origin}/preview-org/documents/${DOC}`); await page.locator('.pg-body .ProseMirror').waitFor(); };
const color = (loc) => loc.evaluate((e) => getComputedStyle(e).color);
const embedFrame = async (page, testOf) => {
  for (let i = 0; i < 50; i++) {
    for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { if (await testOf(f)) return f; } catch { /* not ready */ } }
    await page.waitForTimeout(150);
  }
  throw new Error('embed frame not found');
};

try {
  // ---- 1. An editor: presets, Advanced CSS scoped to the page, malicious CSS refused, the style saved.
  {
    const { ctx, page, writes } = await make();
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const art = page.locator('article.pg-body');
    assert.equal(await art.getAttribute('data-preset'), 'editorial');
    assert.equal(await art.getAttribute('data-doc'), DOC);
    assert.match(await page.locator('.pg-body .ProseMirror h2').first().evaluate((e) => getComputedStyle(e).fontFamily), /Georgia|New York|Iowan|serif/i, 'editorial headings are serif');
    await page.getByTestId('style-btn').click();
    const panel = page.getByTestId('style-panel');
    await panel.waitFor();
    await panel.getByRole('radio', { name: /Product/ }).click();
    assert.equal(await art.getAttribute('data-preset'), 'product');
    await panel.getByRole('radio', { name: /Dark hero/ }).click();
    assert.equal(await art.getAttribute('data-preset'), 'dark-hero');
    assert.match(await page.locator('.pg-body .ProseMirror > :first-child').evaluate((e) => getComputedStyle(e).backgroundImage), /gradient/, 'dark hero opens with a banner');
    await shot(page, 'style-presets-1440.png');
    checks.push('presets');

    // Groot: "Make this page more visual".
    await panel.getByRole('button', { name: 'Make this page more visual' }).click();
    assert.match(await page.getByTestId('groot-idea').innerText(), /Groot suggests/);
    await panel.getByRole('button', { name: 'Not now' }).click();

    // Advanced CSS: styles the page's text, never the app around it.
    await panel.getByRole('tab', { name: 'Advanced CSS' }).click();
    const sidebarBefore = await page.evaluate(() => [...document.querySelectorAll('nav, aside:not(.sp), .rd-bar, .rd-bar button, header:not(.pg-head)')].filter((e) => !e.closest('article')).slice(0, 12).map((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor].join('|')));
    assert.ok(sidebarBefore.length >= 3, 'app chrome to compare');
    const evil = 'h2 { color: rgb(220, 38, 38) }\n:root { --brand: rgb(14, 116, 144) }\n.ProseMirror > p:nth-of-type(2) { color: var(--brand) }\nnav, aside, header, .rd-bar, .rd-bar button, button, body, html { color: rgb(255, 0, 0) !important; background: rgb(255, 0, 0) !important; }\n* { outline: 3px solid rgb(255, 0, 0) }';
    await panel.getByLabel('Advanced CSS').fill(evil);
    assert.equal(await page.getByTestId('css-errors').count(), 0, 'valid CSS has no errors');
    await page.locator('style[data-page-css]').waitFor({ state: 'attached' });
    assert.equal(await color(page.locator('.pg-body .ProseMirror h2').first()), 'rgb(220, 38, 38)', 'the page CSS styles the page');
    assert.equal(await color(page.locator('.pg-body .ProseMirror > p').nth(1)), 'rgb(14, 116, 144)', 'CSS variables work inside the page');
    const sidebarAfter = await page.evaluate(() => [...document.querySelectorAll('nav, aside:not(.sp), .rd-bar, .rd-bar button, header:not(.pg-head)')].filter((e) => !e.closest('article')).slice(0, 12).map((e) => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor].join('|')));
    assert.deepEqual(sidebarAfter, sidebarBefore, 'the page CSS cannot reach the sidebar, the page bar or any app chrome');
    assert.notEqual(await page.locator('.sp').evaluate((e) => getComputedStyle(e).outlineColor), 'rgb(255, 0, 0)', 'nor the Style panel');
    assert.notEqual(await page.locator('[data-embed-guard] .mo-embed-label').first().evaluate((e) => getComputedStyle(e).outlineColor), 'rgb(255, 0, 0)', 'nor an embed’s label');
    const scoped = await page.locator('style[data-page-css]').evaluate((e) => e.textContent);
    assert.match(scoped, new RegExp(`@scope \\(\\.doc-scope\\[data-doc="${DOC}"\\]\\) to \\(\\[data-embed-guard\\]\\)`));
    await shot(page, 'advanced-css-scoped-1440.png');
    checks.push('css-scoped');

    // Malicious CSS: refused with the line, nothing of it applied, Save off.
    await panel.getByLabel('Advanced CSS').fill('h2 { color: blue }\n@import url(https://evil.example/x.css);\n.x { position: fixed; inset: 0; z-index: 99999 }\np { background: url(https://evil.example/t.png) }');
    const errs = await page.getByTestId('css-errors').innerText();
    assert.match(errs, /Line 2 @import is not allowed/); assert.match(errs, /Line 3 position: fixed/); assert.match(errs, /Line 4 url\(\) may only hold a data:image/);
    assert.equal(await panel.getByRole('button', { name: 'Save style' }).isDisabled(), true);
    assert.equal(await color(page.locator('.pg-body .ProseMirror h2').first()), 'rgb(220, 38, 38)', 'the refused CSS is not applied (the last good one stays in preview)');
    await panel.getByLabel('Advanced CSS').fill('a { color: re\\64 }');
    assert.match(await page.getByTestId('css-errors').innerText(), /Backslash escapes are not allowed/);
    await shot(page, 'malicious-css-1440.png');
    checks.push('css-malicious');

    // Save a good style.
    await panel.getByLabel('Advanced CSS').fill('h2 { color: var(--accent) }\n:root { --accent: rgb(79, 70, 229) }\n@media (prefers-color-scheme: dark) {\n  :root { --accent: rgb(165, 180, 252) }\n}');
    await panel.getByRole('tab', { name: 'Look & motion' }).click();
    await panel.getByRole('radio', { name: /Product/ }).click();
    await panel.getByRole('button', { name: 'Save style' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Style saved'));
    const saved = writes.find((w) => w.ep.endsWith('/style'));
    assert.equal(saved.body.style.preset, 'product');
    assert.match(saved.body.style.css, /--accent/);
    assert.equal(saved.body.style.animateSections, true);
    assert.equal(await color(page.locator('.pg-body .ProseMirror h2').first()), 'rgb(79, 70, 229)');
    checks.push('style-saved');

    // Block motion from the bar over a selection; the slash menu offers the motion blocks.
    await page.locator('.pg-body .ProseMirror > p').nth(1).click({ clickCount: 3 });
    await page.getByRole('button', { name: 'Motion of this block' }).click();
    await page.getByRole('radio', { name: 'Scale' }).click();
    assert.equal(await page.locator('.pg-body .ProseMirror > p').nth(1).getAttribute('data-motion'), 'scale');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('.pg-body .ProseMirror > p').last().click();
    await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('/motion');
    const menu = await page.locator('.sgm, [role="listbox"]').last().innerText();
    for (const want of ['Lottie animation', 'Animated SVG', 'Video', 'GIF or APNG', 'Interactive embed']) assert.ok(menu.includes(want), `slash menu offers ${want}`);
    await page.keyboard.press('Escape');
    checks.push('block-motion');
    await ctx.close();
  }

  // ---- 2. A reader: motion on scroll, the motion blocks, the sealed embed, pause.
  {
    const { ctx, page } = await make({ edit: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    const art = page.locator('article.pg-body');
    await page.waitForFunction(() => document.querySelector('article.pg-body')?.classList.contains('mo-armed'));
    assert.equal(await page.getByTestId('style-btn').count(), 0, 'readers have no Style button');
    const below = page.locator('.pg-body .ProseMirror > p').last();
    assert.equal(await below.evaluate((e) => e.classList.contains('mo-in')), false, 'a block below the fold has not come in yet');
    assert.equal(await below.evaluate((e) => getComputedStyle(e).opacity), '0');
    await below.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const ps = document.querySelectorAll('.pg-body .ProseMirror > p'); return ps[ps.length - 1].classList.contains('mo-in'); });
    await page.waitForTimeout(600);
    assert.equal(await below.evaluate((e) => getComputedStyle(e).opacity), '1', 'it rose in on scroll');
    const moving = await page.evaluate(() => [...document.querySelectorAll('.pg-body *')].filter((e) => getComputedStyle(e).transitionProperty.split(',').some((x) => !['opacity', 'transform', 'all', 'none'].includes(x.trim()))).filter((e) => e.closest('[data-motion], .mo-auto') === e).length);
    assert.equal(moving, 0, 'only opacity and transform animate');
    assert.ok(await page.locator('.pg-body .ProseMirror > h2.mo-sec').count() >= 3, 'section transitions between headings');
    checks.push('motion-scroll');

    // Animated SVG: an inert image.
    const svgImg = page.locator('.mo-svg img').first();
    await svgImg.scrollIntoViewIfNeeded();
    assert.match(await svgImg.getAttribute('src'), /^data:image\/svg\+xml/);
    // Video: muted loop with its poster.
    const video = page.locator('.mo-video video');
    await video.scrollIntoViewIfNeeded(); await video.waitFor();
    assert.deepEqual(await video.evaluate((v) => [v.muted, v.loop, v.autoplay, v.src.startsWith('blob:'), !!v.poster]), [true, true, true, true, true]);
    // GIF through the picture block.
    await page.locator('.doc-img img').first().waitFor();
    // Lottie: plays inside the sealed frame.
    const lottieBox = page.locator('.mo-lottie .mo-frame');
    await lottieBox.scrollIntoViewIfNeeded(); await lottieBox.waitFor();
    assert.equal(await lottieBox.getAttribute('sandbox'), 'allow-scripts');
    await embedFrame(page, (f) => f.evaluate(() => !!document.querySelector('#lottie svg')));
    checks.push('lottie-svg-video-gif');

    // The interactive embed: labelled, sandboxed, and it cannot reach the app.
    const frameEl = page.locator('.mo-sandbox .mo-frame');
    await frameEl.scrollIntoViewIfNeeded(); await frameEl.waitFor();
    assert.equal(await frameEl.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await frameEl.getAttribute('src'), '/embed/sandbox.html');
    assert.match(await page.getByTestId('embed-label').innerText(), /Interactive embed/);
    const sandboxed = await embedFrame(page, (f) => f.evaluate(() => /origin:/.test(document.getElementById('out')?.textContent ?? '')));
    const report = await sandboxed.evaluate(() => document.getElementById('out').textContent);
    assert.match(report, /parent:blocked/, `window.parent access throws: ${report}`);
    assert.match(report, /ls:blocked/, `no localStorage: ${report}`);
    assert.match(report, /cookie:(blocked|empty)/, `no cookies: ${report}`);
    assert.match(report, /origin:null/, `opaque origin: ${report}`);
    assert.equal(await sandboxed.evaluate(() => { try { return typeof window.top.location.href; } catch { return 'blocked'; } }), 'blocked');
    await shot(page, 'reader-blocks-1440.png');
    checks.push('sandbox-sealed');

    // Readers can pause motion.
    await page.getByRole('button', { name: 'Pause motion' }).click();
    assert.ok(await art.evaluate((e) => e.classList.contains('mo-paused')));
    assert.equal(await video.evaluate((v) => v.paused), true);
    assert.match(await page.locator('.mo-sandbox .mo-stage').innerText(), /Paused/);
    await page.getByRole('button', { name: 'Play motion' }).click();
    checks.push('pause');

    // Print / export: motion becomes stills, the embed says to open it online.
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('.mo-sandbox .mo-still').isVisible(), true);
    assert.match(await page.locator('.mo-sandbox .mo-still').innerText(), /Interactive embed · Isolation check - open online/);
    assert.equal(await page.locator('.mo-sandbox .mo-stage').isVisible(), false);
    assert.equal(await page.locator('.mo-video .mo-still img').isVisible(), true, 'the video prints its poster');
    assert.match(await page.locator('.mo-lottie .mo-still').innerText(), /Animation · How a request flows/);
    assert.equal(await page.locator('.pg-body .ProseMirror > p').nth(2).evaluate((e) => getComputedStyle(e).opacity), '1', 'nothing is hidden in print');
    await page.pdf({ path: path.join(out, 'print-stills.pdf') });
    await page.emulateMedia({ media: 'screen' });
    checks.push('print-stills');
    await ctx.close();
  }

  // ---- 3. Reduced motion: nothing is hidden or moves.
  {
    const { ctx, page } = await make({ edit: false, opts: { reducedMotion: 'reduce' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('article.pg-body').evaluate((e) => e.classList.contains('mo-armed')), false, 'not armed with reduced motion');
    assert.equal(await page.locator('.pg-body .ProseMirror > p').last().evaluate((e) => getComputedStyle(e).opacity), '1');
    checks.push('reduced-motion');
    await ctx.close();
  }

  // ---- 4. Library settings: embeds and custom CSS can be switched off for the workspace.
  {
    const { ctx, page, writes, design } = await make();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/library/security`);
    await page.getByRole('radio', { name: 'Page design' }).or(page.getByRole('tab', { name: 'Page design' })).first().click();
    const box = page.getByTestId('library-design');
    await box.waitFor();
    await box.getByLabel(/Interactive embeds/).uncheck();
    await page.waitForFunction(() => document.body.innerText.includes('Saved'));
    assert.deepEqual(writes.find((w) => w.ep === '/api/v1/documents/library-design').body, { customCss: true, sandboxEmbeds: false });
    await shot(page, 'library-settings-1440.png');
    assert.equal(design.sandboxEmbeds, false);
    await open(page);
    await page.locator('.mo-sandbox').scrollIntoViewIfNeeded();
    assert.match(await page.locator('.mo-sandbox .mo-stage').innerText(), /turned off in this workspace/);
    assert.equal(await page.locator('.mo-sandbox iframe').count(), 0);
    checks.push('workspace-switch');
    await ctx.close();
  }

  // ---- 5. Dark: the page's dark variables follow the app theme.
  {
    const css = 'h2 { color: var(--accent) }\n:root { --accent: rgb(79, 70, 229) }\n@media (prefers-color-scheme: dark) { :root { --accent: rgb(165, 180, 252) } }';
    const { ctx, page } = await make({ theme: 'dark', edit: false, style: { preset: 'dark-hero', css, animateSections: false, sectionTransition: 'none' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await page.locator('style[data-page-css]').waitFor({ state: 'attached' });
    assert.equal(await color(page.locator('.pg-body .ProseMirror h2').first()), 'rgb(165, 180, 252)', 'dark variables in dark mode');
    await shot(page, 'reader-dark-1440.png');
    checks.push('dark');
    await ctx.close();
  }

  // ---- 7. A document that is not a Page: style and motion work the same, AI rewrites keep them, a tables-only one says why it has no style.
  {
    const { ctx, page, writes, stored2 } = await make();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/documents/${DOC2}`);
    const art = page.locator('article.dv-paper');
    await page.locator('article.dv-paper .ProseMirror').first().waitFor();
    assert.equal(await art.getAttribute('data-doc'), DOC2);
    assert.equal(await art.getAttribute('data-preset'), 'editorial');
    assert.match(await page.locator('style[data-page-css]').evaluate((e) => e.textContent), new RegExp(`@scope \\(\\.doc-scope\\[data-doc="${DOC2}"\\]\\) to \\(\\[data-embed-guard\\]\\)`));
    assert.equal(await color(page.locator('article.dv-paper .ProseMirror h2').first()), 'rgb(220, 38, 38)', 'the document CSS styles its text');
    assert.notEqual(await color(page.locator('.rd-title').first()), 'rgb(220, 38, 38)', 'and nothing outside it');
    assert.notEqual(await page.locator('.doc-section > h3').first().evaluate((e) => getComputedStyle(e).color), 'rgb(255, 0, 0)');
    await page.waitForFunction(() => document.querySelector('article.dv-paper')?.classList.contains('mo-armed'));
    assert.ok(await page.locator('article.dv-paper .ProseMirror > h2.mo-sec').count() >= 1, 'section transitions in a document with sections');
    const last = page.locator('article.dv-paper .ProseMirror > p').last();
    assert.equal(await last.evaluate((e) => getComputedStyle(e).opacity), '0', 'blocks below the fold wait to rise in');
    await last.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => { const ps = document.querySelectorAll('article.dv-paper .ProseMirror > p'); return ps[ps.length - 1].classList.contains('mo-in'); });
    assert.match(await page.locator('article.dv-paper .mo-svg img').first().getAttribute('src'), /^data:image\/svg\+xml/);
    assert.equal(await page.locator('article.dv-paper .mo-svg[data-embed-guard], article.dv-paper [data-embed-guard] .mo-svg, article.dv-paper [data-embed-guard]').count() > 0, true, 'the motion block is guarded from the CSS');
    await page.getByRole('button', { name: 'Pause motion' }).click();
    assert.ok(await art.evaluate((e) => e.classList.contains('mo-paused')));
    await page.getByRole('button', { name: 'Play motion' }).click();
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('article.dv-paper .ProseMirror > p').nth(3).evaluate((e) => getComputedStyle(e).opacity), '1', 'nothing is hidden in print');
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'document-styled-1440.png');
    checks.push('non-page-style-motion');

    // The Style panel on a document with sections.
    await page.getByTestId('style-btn').click();
    const panel = page.getByTestId('style-panel');
    await panel.waitFor();
    await panel.getByRole('radio', { name: /Product/ }).click();
    assert.equal(await art.getAttribute('data-preset'), 'product');
    await panel.getByRole('button', { name: 'Save style' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Style saved'));
    assert.equal(writes.find((w) => w.ep === `/api/v1/documents/${DOC2}/style`).body.style.preset, 'product');
    await panel.getByRole('button', { name: 'Close style' }).click();
    checks.push('non-page-style-saved');

    // AI rewrite of a selection that spans the motion block: the block and the first block's motion stay, so does the style.
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('edit-toolbar').waitFor();
    await page.locator('article.dv-paper .ProseMirror[contenteditable="true"]').first().waitFor();
    await page.evaluate(() => {
      const ed = document.querySelector('article.dv-paper .ProseMirror').editor;
      let end = 0; ed.state.doc.forEach((n, pos, i) => { if (i === 2) end = pos + n.nodeSize - 1; });
      ed.chain().focus().setTextSelection({ from: 1, to: end }).run();
    });
    await page.locator('.rte-ai').click();
    await page.getByRole('menuitem', { name: 'Rewrite' }).click();
    await page.getByRole('button', { name: 'Replace' }).click();
    const pm = page.locator('article.dv-paper .ProseMirror').first();
    await page.waitForFunction((txt) => document.querySelector('article.dv-paper .ProseMirror').innerText.includes(txt), REWRITE);
    assert.equal(await pm.locator('.mo-svg').count(), 1, 'the motion block survived the rewrite');
    assert.equal(await pm.locator('> p').first().getAttribute('data-motion'), 'rise', 'the first block kept its motion');
    await page.getByTestId('edit-toolbar').getByRole('button', { name: /^Save/ }).click();
    await page.waitForFunction(() => document.body.innerText.includes('Saved.'));
    const sent = JSON.parse(writes.filter((w) => w.ep === `/api/v1/documents/${DOC2}/sections`).pop().body.sections.find((x) => x.key === 'overview').content);
    assert.ok(sent.content.some((b) => b.type === 'motionSvg' && b.attrs.caption === 'Rollout map'), 'the saved text keeps the motion block');
    assert.equal(sent.content[0].attrs.motion, 'rise');
    assert.ok(JSON.stringify(sent).includes(REWRITE));
    assert.equal(JSON.parse(stored2()).attrs.pageStyle.preset, 'product', 'the style is still on the document');
    await page.getByTestId('edit-toolbar').getByRole('button', { name: 'Done' }).click();
    assert.equal(await art.getAttribute('data-preset'), 'product');
    await shot(page, 'document-ai-rewrite-1440.png');
    checks.push('non-page-ai-rewrite-keeps-motion');

    // Tables only: the Style panel says why there is nothing to style.
    await page.goto(`${origin}/preview-org/documents/${DOC3}`);
    await page.getByTestId('style-btn').click();
    assert.match(await page.getByTestId('style-unavailable').innerText(), /only tables/);
    assert.equal(await page.getByRole('button', { name: 'Save style' }).count(), 0);
    await shot(page, 'document-tables-only-1440.png');
    checks.push('style-unavailable');
    await ctx.close();
  }
  {
    const { ctx, page } = await make({ edit: false, opts: { reducedMotion: 'reduce' } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/preview-org/documents/${DOC2}`);
    await page.locator('article.dv-paper .ProseMirror').first().waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('article.dv-paper').evaluate((e) => e.classList.contains('mo-armed')), false, 'not armed with reduced motion');
    checks.push('non-page-reduced-motion');
    await ctx.close();
  }
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await make({ theme, opts: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    await page.goto(`${origin}/preview-org/documents/${DOC2}`);
    await page.locator('article.dv-paper .ProseMirror').first().waitFor();
    await fitsPhone(page, `document ${theme}`, assert);
    await page.getByTestId('style-btn').click();
    await page.getByTestId('style-panel').waitFor();
    await fitsPhone(page, `document style sheet ${theme}`, assert);
    await shot(page, `document-style-390-${theme}.png`);
    await ctx.close();
  }
  checks.push('non-page-phone');

  // ---- 6. Phone: the reader and the Style panel as a bottom sheet.
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await make({ theme, opts: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    await open(page);
    await fitsPhone(page, `page ${theme}`, assert);
    await page.getByTestId('style-btn').click();
    const panel = page.getByTestId('style-panel');
    await panel.waitFor();
    const r = await panel.boundingBox();
    assert.ok(r.width >= 389 && Math.abs(r.y + r.height - 844) <= 2, `the Style panel is a bottom sheet on a phone: ${JSON.stringify(r)}`);
    await fitsPhone(page, `style sheet ${theme}`, assert);
    await shot(page, `style-sheet-390-${theme}.png`);
    await panel.getByRole('button', { name: 'Close style' }).click();
    await page.locator('.mo-sandbox').scrollIntoViewIfNeeded();
    await fitsPhone(page, `embeds ${theme}`, assert);
    await shot(page, `page-390-${theme}.png`);
    await ctx.close();
  }
  checks.push('phone');

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, artifacts: out }));
} finally {
  await browser.close();
}
