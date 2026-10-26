import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fitsPhone } from './lib/phone.mjs';
import { webcrypto, createHash } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { appCsp } from './lib/csp.mjs';

// The password vault: values are never drawn outside the edit screen (copy only), the vault covers itself when the window is left, copying clears the clipboard, confidential items ask
// for a two-step code once, use-only items can be copied but not shown, one-time codes come from the server, the editor's generator and
// strength meter, import from a CSV export, sharing, health, administration, and the phone layout in both themes. Then the sealed vault:
// keys made in the browser with a passkey (a virtual authenticator with PRF), the recovery kit, a sealed collection and item whose
// contents never reach the server readable, locking and unlocking (passkey and recovery key), and approving a new device — whose
// envelope is opened here with the new device's one-time keys and must give exactly the identity on record.
// Built frontend with a synthetic vault API only.
const origin = 'https://projecttracker-preview.test', dist = path.resolve('dist'), out = path.resolve('test-results/vault-ui');
await fs.mkdir(out, { recursive: true });
const nginx = await fs.readFile('nginx.conf', 'utf8');
const csp = await appCsp();
const user = { id: '00000000-0000-0000-0000-000000000001', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, timeZone: 'Asia/Kolkata', isPlatformAdmin: false };
const ws = { id: '00000000-0000-0000-0000-000000000002', slug: 'preview-org', name: 'Preview Workspace', type: 'Organization', role: 'Owner', planCode: 'BUSINESS', memberCount: 4 };
const token = `x.${Buffer.from(JSON.stringify({ wid: ws.id, exp: 4102444800 })).toString('base64url')}.x`;
const now = new Date().toISOString();

// ---- a tiny vault server
const SECRETS = { i1: { password: 'Tq7#vLm2!pZx9@Rk', note: 'Branch code 0042' }, i2: { password: 'Root!Acc3ss#2026zz' }, i3: { password: 'Use0nly!Secret#9q' }, i4: { password: 'Summer@2024', totp: 'JBSWY3DPEHPK3PXP' } };
const collections = [
  { id: 'c1', name: 'My vault', description: null, kind: 'Personal', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 2, atRisk: 1, requireStepUp: false, rotateEveryDays: null, locked: false, shares: null, sealed: false, rekeyNeeded: false, keyVersion: 0, requireApproval: false, requestable: false },
  { id: 'c2', name: 'Payments servers', description: 'Production and UAT', kind: 'Shared', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 2, atRisk: 0, requireStepUp: false, rotateEveryDays: 90, locked: false, sealed: false, rekeyNeeded: false, keyVersion: 0, requireApproval: false, requestable: false,
    shares: [{ id: 's1', principalType: 'User', principalId: user.id, role: null, name: 'Asha Rao', access: 'Manage', expiresAt: null }, { id: 's2', principalType: 'User', principalId: 'u2', role: null, name: 'Ravi Kumar', access: 'View', expiresAt: null }] },
];
const summary = (o) => ({ id: o.id, collectionId: o.c, collectionName: collections.find((c) => c.id === o.c).name, kind: o.kind ?? 'Login', title: o.title, url: o.url ?? null, usernameHint: o.hint ?? null, tags: o.tags ?? [],
  class: o.cls ?? 'Secret', useOnly: !!o.useOnly, owner: { id: user.id, name: user.displayName }, hasTotp: !!o.totp, strength: o.strength ?? 4, breached: !!o.breached, reused: false, expiresAt: null, expired: false,
  rotationReason: o.reason ?? null, valueChangedAt: now, lastUsedAt: null, myAccess: o.access ?? 'Manage', health: o.health ?? [] });
const items = [
  summary({ id: 'i1', c: 'c1', title: 'Bank portal', url: 'https://netbanking.example.in', hint: 'r***@fivestar.in', tags: ['finance'] }),
  summary({ id: 'i4', c: 'c1', title: 'Old router', hint: 'a***n', strength: 0, breached: true, totp: true, health: ['weak', 'breached'] }),
  summary({ id: 'i2', c: 'c2', title: 'AWS root account', url: 'console.aws.amazon.com', cls: 'Confidential', hint: 'o***s' }),
  summary({ id: 'i3', c: 'c2', title: 'Payments DB', kind: 'Database', useOnly: true, access: 'Manage', hint: 'p***r' }),
];
const fields = (id) => {
  const s = items.find((i) => i.id === id);
  if (s.kind === 'Database') return [{ key: 'host', label: 'Host', type: 'text', secret: false, value: 'db.payments.internal' }, { key: 'username', label: 'User name', type: 'text', secret: false, value: 'payuser' }, { key: 'password', label: 'Password', type: 'password', secret: true, value: null }];
  const f = [{ key: 'username', label: 'User name', type: 'text', secret: false, value: id === 'i1' ? 'ravi@fivestar.in' : 'admin' }, { key: 'password', label: 'Password', type: 'password', secret: true, value: null }];
  if (id === 'i4') f.push({ key: 'totp', label: 'One-time code (2FA)', type: 'totp', secret: true, value: null });
  if (id === 'i1') f.push({ key: 'note', label: 'Notes', type: 'note', secret: true, value: null },
    { key: 'statements', label: 'Statements portal', type: 'url', secret: false, value: 'https://statements.bank.example/login' },
    { key: 'remarks', label: 'Remarks', type: 'remark', secret: false, value: 'Shared login for the finance team.\nCall Ravi before changing it.' });
  return f;
};
const detail = (id) => {
  const s = items.find((i) => i.id === id);
  return { item: s, fields: fields(id), links: [], versions: id === 'i1' ? [{ id: 'v1', at: now, by: { id: user.id, name: user.displayName }, reason: 'Rotated' }] : [], attachments: id === 'i1' ? [{ id: 'a1', fileName: 'recovery.txt', contentType: 'text/plain', sizeBytes: 42, at: now }] : [],
    canReveal: !s.useOnly && s.myAccess !== 'UseOnly', canCopy: true, canManage: s.myAccess === 'Manage', needsStepUp: s.class === 'Confidential', rotateEveryDays: null, createdAt: now, createdBy: { id: user.id, name: user.displayName } };
};
const policy = { stepUpAlways: false, clipboardSeconds: 5, revealSeconds: 3, sharedAdminsOnly: false };
const reqState = { mine: [], toDecide: [
  { id: 'r1', kind: 'Collection', collectionId: 'c9', collectionName: 'Ops break-glass', itemId: null, itemTitle: null, requester: { id: 'u2', name: 'Ravi Kumar' }, reason: 'Firewall change window tonight', access: 'View', minutes: 240, status: 'Pending', decidedBy: null, decidedAt: null, decisionNote: null, grantedUntil: null, createdAt: now, canDecide: true },
], toHelp: [], recovery: null, links: [], machines: [], decoys: [], requestable: [{ id: 'c8', name: 'Firewall admin', description: 'Edge firewalls', kind: 'Shared', sealed: false }] };
const sealedState = { identity: null, unlocks: [], envelopes: [], items: [], events: [], pendingDevice: null };
const overview = () => ({ collections, policy, canAdmin: true, canCreateShared: true, health: { total: 4, weak: 1, reused: 0, breached: 1, expired: 0, old: 0, toRotate: 0, score: 75 }, mfaEnabled: true, identity: sealedState.identity, hasPasskeys: true });
const sha1hex = (s) => createHash('sha1').update(s).digest('hex').toUpperCase();
const collectionKeys = (id) => ({ collectionId: id, sealed: true, keyVersion: 1, rekeyNeeded: false, myAccess: 'Manage', pending: [],
  mine: sealedState.envelopes.filter((e) => e.collectionId === id).map((e) => ({ ...e, senderUserId: user.id, senderEd25519Public: sealedState.identity.ed25519Public })) });
const STEP = 'step-token-1';
const writes = [], errors = [], checks = [];
const err = (status, code, message) => ({ status, body: { errors: [{ code, message }], message } });

const browser = await chromium.launch({ ...(process.env.PM_BROWSER_EXECUTABLE ? { executablePath: process.env.PM_BROWSER_EXECUTABLE } : {}), headless: true });
try {
  const make = async (theme = 'light', extra = {}) => {
    const ctx = await browser.newContext({ ...extra, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block', acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await ctx.addInitScript((t) => { localStorage.setItem('pm_alerts_prompt', '1'); localStorage.setItem('pm_theme', t); }, theme);
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = new URL(req.url()), ep = url.pathname, method = req.method();
      if (url.origin !== origin) { await route.abort(); return; }
      if (ep.endsWith('/avatar')) { await route.fulfill({ status: 404, body: '' }); return; }
      if (!ep.startsWith('/api/')) {
        const file = path.resolve(dist, ep.startsWith('/assets/') ? ep.slice(1) : 'index.html'); assert.ok(file.startsWith(dist + path.sep));
        await route.fulfill({ contentType: { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(file)] || 'application/octet-stream', body: await fs.readFile(file), headers: ep.startsWith('/assets/') ? {} : { 'content-security-policy': csp } });
        return;
      }
      const body = method === 'GET' || method === 'DELETE' ? null : (() => { try { return req.postDataJSON(); } catch { return null; } })();
      let data = [], fail = null;
      const m = ep.match(/^\/api\/v1\/vault\/items\/([^/]+)(?:\/(reveal|totp|activity|restore|versions\/([^/]+)\/reveal))?$/);
      if (ep === '/api/v1/vault/overview') data = overview();
      else if (ep === '/api/v1/vault/step-up') { writes.push({ ep, body }); data = body.code === '123456' ? { token: STEP, expiresAt: new Date(Date.now() + 300e3).toISOString() } : null; if (!data) fail = err(422, 'MFA_CODE_INVALID', 'That code is not right. Try the current one.'); }
      else if (ep === '/api/v1/vault/items' && method === 'GET') {
        writes.push({ ep, q: Object.fromEntries(url.searchParams) });
        const c = url.searchParams.get('collectionId'), h = url.searchParams.get('health'), q = (url.searchParams.get('q') ?? '').toLowerCase();
        data = url.searchParams.get('bin') ? [] : items.filter((i) => (!c || i.collectionId === c) && (!h || (h === 'any' ? i.health.length : i.health.includes(h))) && (!q || i.title.toLowerCase().includes(q)));
      }
      else if (ep === '/api/v1/vault/items' && method === 'POST') { writes.push({ ep, body }); const s = summary({ id: `n${items.length}`, c: body.collectionId, title: body.title, cls: body.class }); items.push(s); data = detail(s.id); }
      else if (m && !m[2] && method === 'GET') data = detail(m[1]);
      else if (m && !m[2] && method === 'PUT') { writes.push({ ep, body }); const s = items.find((i) => i.id === m[1]); s.title = body.title; data = detail(m[1]); }
      else if (m && m[2] === 'reveal') {
        writes.push({ ep, body }); const s = items.find((i) => i.id === m[1]);
        if (reqState.forceStepUp && body.stepUp !== 'passkey-token') { reqState.forceStepUp = false; fail = err(403, 'STEP_UP_REQUIRED', 'This looks unusual — a new browser or device. Confirm it is you.'); }
        else if (collections.find((c) => c.id === s.collectionId)?.requireApproval && !reqState.mine.some((r) => r.itemId === s.id && r.status === 'Approved')) fail = err(403, 'VAULT_APPROVAL_REQUIRED', 'Someone else must approve this first (the two-person rule).');
        else if (s.class === 'Confidential' && body.stepUp !== STEP && body.stepUp !== 'passkey-token') fail = err(403, 'STEP_UP_REQUIRED', 'This needs a fresh two-step check. Confirm with your authenticator first.');
        else if (s.useOnly && !body.copy) fail = err(403, 'VAULT_USE_ONLY', 'This item is use-only.');
        else data = { value: SECRETS[m[1]][body.field], revealSeconds: policy.revealSeconds, clipboardSeconds: policy.clipboardSeconds };
      }
      else if (m && m[2] === 'totp') { writes.push({ ep, body }); data = { code: '492039', secondsLeft: 21, period: 30, digits: 6 }; }
      else if (m && m[2] === 'activity') data = [{ at: now, action: 'vault.revealed', by: { id: 'u2', name: 'Ravi Kumar' }, field: 'Password', ipAddress: '203.0.113.x' }, { at: now, action: 'vault.reveal_denied', by: { id: 'u3', name: 'Uma' }, field: 'password', ipAddress: null }];
      else if (m && m[3]) { writes.push({ ep, body }); data = body.stepUp === STEP ? { value: 'Old!Value#2025', revealSeconds: 3, clipboardSeconds: 5 } : null; if (!data) fail = err(403, 'STEP_UP_REQUIRED', 'Earlier values need a fresh two-step check.'); }
      else if (ep === '/api/v1/vault/links' && method === 'POST') { writes.push({ ep, body }); const l = { ...body, id: `l${reqState.links.length + 1}`, views: 0, createdAt: now, expiresAt: new Date(Date.now() + body.hours * 3600e3).toISOString() }; reqState.links.push(l);
        data = { id: l.id, note: l.note, itemId: l.itemId, itemTitle: items.find((i) => i.id === l.itemId)?.title ?? null, createdAt: now, expiresAt: l.expiresAt, views: 0, maxViews: l.maxViews, hasPassphrase: l.hasPassphrase, state: 'open', lastOpenedAt: null }; }
      else if (ep === '/api/v1/vault/links') data = reqState.links.map((l) => ({ id: l.id, note: l.note, itemId: l.itemId, itemTitle: items.find((i) => i.id === l.itemId)?.title ?? null, createdAt: now, expiresAt: l.expiresAt, views: l.views, maxViews: l.maxViews, hasPassphrase: l.hasPassphrase, state: l.views >= l.maxViews ? 'used' : 'open', lastOpenedAt: l.views ? now : null }));
      else if (ep.startsWith('/api/v1/secret-links/')) {
        const [token, act] = ep.slice('/api/v1/secret-links/'.length).split('/');
        const l = reqState.links.find((x) => x.tokenHash === createHash('sha256').update(decodeURIComponent(token)).digest('hex'));
        const live = l && l.views < l.maxViews;
        if (act === 'open') { writes.push({ ep }); if (live) { l.views++; data = { cipher: l.cipher, viewsLeft: l.maxViews - l.views }; } else fail = err(404, 'LINK_GONE', 'This link was already opened, was revoked, or has expired.'); }
        else data = live ? { state: 'ready', note: l.note, from: 'Asha Rao', workspace: 'Preview Workspace', hasPassphrase: l.hasPassphrase, salt: l.salt, params: l.params, expiresAt: l.expiresAt, viewsLeft: l.maxViews - l.views }
          : { state: 'gone', note: null, from: null, workspace: null, hasPassphrase: false, salt: null, params: null, expiresAt: null, viewsLeft: 0 };
      }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/machines$/) && method === 'POST') { writes.push({ ep, body }); const repo = body.repository.replace(/^https:\/\/github\.com\//, '');
        const m = { id: `m${reqState.machines.length + 1}`, provider: 'github', repository: repo, pinned: false, refPattern: body.refPattern.startsWith('refs/') ? body.refPattern : `refs/heads/${body.refPattern}`, environment: body.environment, label: repo, createdAt: now, lastUsedAt: null, lastRun: null,
          audience: `projecttracker-vault:${ws.id}`, endpoint: `/api/v1/machine/github/m${reqState.machines.length + 1}/secrets`, variables: ['AWS_ROOT_ACCOUNT_PASSWORD', 'PAYMENTS_DB_PASSWORD'] }; reqState.machines.push(m); data = m; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/machines$/)) data = reqState.machines;
      else if (ep === '/api/v1/vault/keys/circle') data = { circle: null };
      else if (ep === '/api/v1/vault/keys/directory') data = [{ userId: 'u2', name: 'Ravi Kumar', access: 'None', identity: null }, { userId: 'u4', name: 'Meera Iyer', access: 'None', identity: null }];
      else if (ep === '/api/v1/vault/recovery/to-help') data = reqState.toHelp;
      else if (ep.match(/^\/api\/v1\/vault\/recovery\/[^/]+\/refuse$/)) { writes.push({ ep }); reqState.toHelp = []; data = null; }
      else if (ep.match(/^\/api\/v1\/vault\/recovery\/[^/]+\/finish$/)) { writes.push({ ep, q: Object.fromEntries(url.searchParams) }); reqState.recovery.cancelled = true; data = null; }
      else if (ep === '/api/v1/vault/recovery' && method === 'POST') { writes.push({ ep, body }); reqState.recovery = { id: 'rec1', threshold: 2, helpers: 3, createdAt: now, expiresAt: new Date(Date.now() + 86400e3).toISOString(), completed: false, cancelled: false, releases: [] }; data = reqState.recovery; }
      else if (ep === '/api/v1/vault/recovery/rec1') data = reqState.recovery;
      else if (ep === '/api/v1/vault/requests') data = { mine: reqState.mine, toDecide: reqState.toDecide };
      else if (ep === '/api/v1/vault/requestable') data = reqState.requestable;
      else if (ep === '/api/v1/vault/decoys') data = reqState.decoys;
      else if (ep.match(/^\/api\/v1\/vault\/items\/[^/]+\/requests$/)) { writes.push({ ep, body }); const it = items.find((i) => i.id === ep.split('/')[5]); data = { id: `r${reqState.mine.length + 2}`, kind: 'Reveal', collectionId: it.collectionId, collectionName: it.collectionName, itemId: it.id, itemTitle: it.title, requester: { id: user.id, name: user.displayName }, reason: body.reason, access: 'View', minutes: body.minutes, status: 'Pending', decidedBy: null, decidedAt: null, decisionNote: null, grantedUntil: null, createdAt: now, canDecide: false }; reqState.mine.unshift(data); }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/requests$/)) { writes.push({ ep, body }); const c = reqState.requestable.find((x) => x.id === ep.split('/')[5]); data = { id: `r${reqState.mine.length + 2}`, kind: 'Collection', collectionId: c.id, collectionName: c.name, itemId: null, itemTitle: null, requester: { id: user.id, name: user.displayName }, reason: body.reason, access: body.access, minutes: body.minutes, status: 'Pending', decidedBy: null, decidedAt: null, decisionNote: null, grantedUntil: null, createdAt: now, canDecide: false }; reqState.mine.unshift(data); }
      else if (ep.match(/^\/api\/v1\/vault\/requests\/[^/]+\/(approve|deny|cancel)$/)) { writes.push({ ep, body }); const [, , , , , id, act] = ep.split('/'); const r = [...reqState.toDecide, ...reqState.mine].find((x) => x.id === id);
        if (act === 'cancel') r.status = 'Cancelled'; else Object.assign(r, { status: act === 'approve' ? 'Approved' : 'Denied', decidedBy: { id: user.id, name: user.displayName }, decidedAt: now, decisionNote: body.note, grantedUntil: act === 'approve' ? new Date(Date.now() + r.minutes * 60e3).toISOString() : null, canDecide: false });
        reqState.toDecide = reqState.toDecide.filter((x) => x.status === 'Pending'); data = r; }
      else if (ep.match(/^\/api\/v1\/vault\/items\/[^/]+\/decoy$/)) { writes.push({ ep, body }); const it = items.find((i) => i.id === ep.split('/')[5]); reqState.decoys = body.decoy ? [...reqState.decoys, { itemId: it.id, title: it.title, collectionName: it.collectionName, triggered: 0, lastTriggeredAt: null }] : reqState.decoys.filter((d) => d.itemId !== it.id); data = reqState.decoys.find((d) => d.itemId === it.id) ?? null; }
      else if (ep === '/api/v1/vault/step-up/passkey/options') { writes.push({ ep }); data = { challengeId: 'ch1', options: { challenge: Buffer.from('a fresh challenge for the vault').toString('base64url'), rpId: new URL(origin).hostname, allowCredentials: [], userVerification: 'required', timeout: 60000 } }; }
      else if (ep === '/api/v1/vault/step-up/passkey') { writes.push({ ep, body }); data = { token: 'passkey-token', expiresAt: new Date(Date.now() + 300e3).toISOString() }; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+$/) && method === 'PUT') { writes.push({ ep, body }); const c = collections.find((x) => x.id === ep.split('/').pop()); Object.assign(c, { requireApproval: !!body.requireApproval, requestable: !!body.requestable, requireStepUp: !!body.requireStepUp }); data = c; }
      else if (ep === '/api/v1/vault/check') { writes.push({ ep, body }); data = { strength: 4, breachCount: body.password === 'Summer@2024' ? 4321 : 0 }; }
      else if (ep.startsWith('/api/v1/vault/breach-range/')) { const prefix = ep.split('/').pop(); writes.push({ ep }); const h = sha1hex('Summer@2024'); data = { body: `0000000000000000000000000000000000A:0\r\n${h.startsWith(prefix) ? `${h.slice(5)}:4321` : ''}` }; }
      else if (ep === '/api/v1/vault/keys/me') data = { identity: sealedState.identity, unlocks: sealedState.unlocks };
      else if (ep === '/api/v1/vault/keys/setup') { writes.push({ ep, body }); sealedState.identity = { userId: user.id, ...Object.fromEntries(['x25519Public', 'mlKemPublic', 'ed25519Public', 'selfSignature', 'fingerprint'].map((k) => [k, body[k]])), generation: 1 };
        sealedState.unlocks = body.unlocks.map((u, i) => ({ ...u, id: `u${i}`, credentialId: u.credentialId ?? null, createdAt: now, lastUsedAt: null })); data = { identity: sealedState.identity, unlocks: sealedState.unlocks }; }
      else if (ep.match(/^\/api\/v1\/vault\/keys\/unlocks\/[^/]+\/used$/)) { writes.push({ ep }); data = null; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/keys$/)) { const id = ep.split('/')[5]; if (method === 'POST') { writes.push({ ep, body }); for (const e of body.envelopes) sealedState.envelopes.push({ ...e, collectionId: id }); } data = collectionKeys(id); }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+\/sealed-items$/)) { const id = ep.split('/')[5]; data = url.searchParams.get('bin') ? [] : sealedState.items.filter((i) => i.collectionId === id); }
      else if (ep === '/api/v1/vault/sealed-items' && method === 'POST') { writes.push({ ep, body }); const row = { ...body, rotationReason: null, createdAt: now, updatedAt: null, valueChangedAt: now, deletedAt: null, myAccess: 'Manage', files: [], versions: 0, rotateEveryDays: body.rotateEveryDays ?? null, expiresAt: body.expiresAt ?? null }; sealedState.items.push(row); data = row; }
      else if (ep.match(/^\/api\/v1\/vault\/sealed-items\/[^/]+\/events$/)) { sealedState.events.push(body); data = null; }
      else if (ep === '/api/v1/vault/devices/pending') data = sealedState.pendingDevice ? [sealedState.pendingDevice.link] : [];
      else if (ep.match(/^\/api\/v1\/vault\/devices\/[^/]+\/approve$/)) { writes.push({ ep, body }); sealedState.pendingDevice.approved = body; sealedState.pendingDevice = { ...sealedState.pendingDevice, link: null }; data = null; }
      else if (ep === '/api/v1/vault/import') { writes.push({ ep, body }); data = { imported: body.rows.length, skipped: 0, weak: 1 }; }
      else if (ep.match(/^\/api\/v1\/vault\/collections\/[^/]+$/) && method === 'GET') data = collections.find((c) => c.id === ep.split('/').pop());
      else if (ep.endsWith('/shares') && method === 'PUT') { writes.push({ ep, body }); data = collections[1]; }
      else if (ep === '/api/v1/vault/collections' && method === 'POST') { writes.push({ ep, body }); data = { ...collections[1], id: `c${collections.length + 1}`, name: body.name, sealed: !!body.sealed, keyVersion: body.sealed ? 1 : 0, rekeyNeeded: false, items: 0, atRisk: 0, shares: [collections[1].shares[0]] }; collections.push(data); }
      else if (ep === '/api/v1/vault/policy') { writes.push({ ep, body }); Object.assign(policy, body); data = policy; }
      else if (ep.startsWith('/api/v1/vault/access-review/')) data = { person: { id: 'u2', name: 'Ravi Kumar' }, collections: [{ id: 'c9', name: 'Ops break-glass', access: 'View', items: 3 }], used: [{ itemId: 'i2', title: 'AWS root account', collection: 'Payments servers', times: 4, last: now }] };
      else if (ep.endsWith('/admin-access')) { writes.push({ ep, body }); data = collections[1]; if (body.stepUp !== STEP) fail = err(403, 'STEP_UP_REQUIRED', 'Confirm with your authenticator first.'); }
      else if (ep.startsWith('/api/v1/vault/attachments/') && ep.endsWith('/download')) { writes.push({ ep, body }); await route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'recovery words here' }); return; }
      else {
        assert.ok(method === 'GET' || ep.endsWith('/auth/refresh'), `Unexpected write: ${method} ${ep}`);
        if (ep.endsWith('/auth/refresh')) data = { accessToken: token, expiresAt: '2099-01-01T00:00:00Z', user };
        else if (ep === '/api/v1/me') data = { user: { ...user, mfaEnabled: true }, workspaces: [ws], fingerprint: 'preview', pendingConsent: [], current: { ...ws, reportCount: 4, permissions: ['projects.view', 'projects.edit', 'tasks.view', 'org.manage', 'reports.view', 'vault.use', 'vault.admin'], modules: { projects: 3, tasks: 3, calendar: 3, work: 3, ai: 3, activity: 3, documents: 3, people: 3, reports: 3, billing: 3 }, plan: { code: 'BUSINESS', name: 'Business', status: 'Active' }, entitlements: { AI_ASSISTANT: 3 } } };
        else if (ep === '/api/v1/me/ui/sidebar') data = { key: 'sidebar', value: null, updatedAt: null };
        else if (ep === '/api/v1/workspace') data = { ...ws, aiDisabled: false };
        else if (ep === '/api/v1/workspace/members') data = [{ userId: user.id, displayName: 'Asha Rao', email: user.email, role: 'Owner', joinedAt: now, jobRole: null }, { userId: 'u2', displayName: 'Ravi Kumar', email: 'ravi@example.test', role: 'Member', joinedAt: now, jobRole: null }, { userId: 'u4', displayName: 'Meera Iyer', email: 'meera@example.test', role: 'Manager', joinedAt: now, jobRole: null }];
        else if (ep === '/api/v1/teams') data = [{ id: 't1', name: 'Payments', description: null, memberCount: 4, projectCount: 1, lead: null }];
        else if (ep.endsWith('/projects') || ep.endsWith('/tasks')) data = { items: [], page: 1, totalPages: 0, totalItems: 0 };
        else if (ep.endsWith('/me/fingerprint')) data = { fingerprint: 'preview' };
        else if (ep.endsWith('/ai/status')) data = { enabled: true, configured: true, entitled: true, allowedHere: true };
        else if (ep.endsWith('/workspace/logo')) data = { hasLogo: false };
        else if (ep === '/api/v1/chat/projects/unread') data = [];
        else if (ep.includes('/counts') || ep.includes('/unread')) data = { count: 0, total: 0 };
        else if (ep === '/api/v1/timer') data = null;
        else if (ep === '/api/v1/agent/inbox' || ep === '/api/v1/agent/assigned') data = { items: [], pending: 0, canDecide: false };
      }
      if (fail) await route.fulfill({ status: fail.status, contentType: 'application/json', body: JSON.stringify(fail.body) });
      else await route.fulfill({ contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify({ data }) });
    });
    return ctx;
  };
  const shot = async (page, name) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, name) }); };
  const waitFor = async (pred, what) => { for (let i = 0; i < 50; i++) { if (await pred()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`waited for ${what}`); };
  const html = (page) => page.evaluate(() => document.body.innerText + document.body.innerHTML);
  const clip = (page) => page.evaluate(() => navigator.clipboard.readText());

  let ctx = await make(); let page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
  assert.ok(await page.locator('.v2-rail-item', { hasText: 'Library' }).isVisible(), 'Library in the rail'); assert.ok(await page.getByRole('tab', { name: 'Vault' }).isVisible(), 'Vault is a Library tab');
  assert.deepEqual(await page.locator('.vlt-rail [data-collection]').evaluateAll((els) => els.map((e) => e.getAttribute('data-collection'))), ['My vault', 'Payments servers']);
  assert.equal(await page.locator('.vlt-item').count(), 4);
  for (const v of Object.values(SECRETS).flatMap((s) => Object.values(s))) assert.ok(!(await html(page)).includes(v), 'no secret in the list page');
  checks.push('list-without-secrets');
  // The app runs under its strict policy: Trusted Types clean anything put into innerHTML, and code from text is refused.
  const tt = await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = '<img src="x" onerror="window.__x=1"><b>ok</b><script>window.__y=1<' + '/script><svg><a href="javascript:alert(1)"><text>t</text></a></svg><iframe srcdoc="x"></iframe>';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.innerHTML = '<rect x="2" y="6" width="14" height="12"/><polygon points="22 8 16 12 22 16"/><line x1="1" y1="1" x2="2" y2="2" onclick="window.__z=1"/>';
    return { html: d.innerHTML, policy: !!(window.trustedTypes && window.trustedTypes.defaultPolicy), icon: [...icon.children].map((c) => c.localName).join(' '), iconHtml: icon.innerHTML };
  });
  assert.ok(tt.policy, 'a default Trusted Types policy');
  assert.ok(/require-trusted-types-for 'script'/.test(csp) && !/unsafe-inline|unsafe-eval/.test(csp.match(/script-src[^;]*/)[0]), 'scripts by hash only, Trusted Types required');
  assert.match(tt.html, /<b>ok<\/b>/); assert.ok(!/onerror|<script|javascript:|<iframe/i.test(tt.html), `cleaned: ${tt.html}`);
  assert.equal(tt.icon, 'rect polygon line', 'an icon drawn from several shapes keeps every shape, side by side');   // not nested in the first one
  assert.ok(!/onclick/.test(tt.iconHtml));
  checks.push('trusted-types');
  // Tiles drawn here (nothing fetched), health at a glance, and copying straight from the list with the keyboard.
  assert.equal(await page.locator('.vlt-item[data-item="AWS root account"] .vlt-tile-text').innerText(), 'aws');
  assert.equal(await page.locator('.vlt-item[data-item="Bank portal"] .vlt-tile-text').innerText(), 'BP');
  assert.match(await page.getByTestId('posture').innerText(), /75/);
  await page.getByTestId('posture').getByRole('button', { name: /in a public breach/i }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items' && w.q?.health === 'breached'), 'posture filter');
  await page.locator('.vlt-chip-on').click();
  await page.locator('.vlt-item[data-item="Bank portal"]').waitFor();
  await page.locator('.vlt-item[data-item="Bank portal"]').focus();
  await page.keyboard.press('c');
  await waitFor(() => writes.some((w) => w.ep.endsWith('/i1/reveal') && w.body.copy && w.body.field === 'password'), 'quick copy');
  await waitFor(async () => (await clip(page)) === SECRETS.i1.password, 'copied from the list');
  await page.getByTestId('clipboard-countdown').waitFor();
  assert.match(await page.getByTestId('clipboard-countdown').innerText(), /Clipboard clears in \d+s/);
  await page.getByTestId('clipboard-countdown').getByRole('button', { name: 'Clear now' }).click();
  await waitFor(async () => (await clip(page)) === '', 'cleared on request');
  await page.getByTestId('clipboard-countdown').waitFor({ state: 'detached' });
  assert.ok(!(await html(page)).includes(SECRETS.i1.password), 'a copy from the list is never shown');
  writes.length = 0;
  checks.push('tiles-health-quick-copy');
  await shot(page, 'list-1440.png');

  // The item view never draws a secret: masked, copy only (the edit screen is the one place a value shows).
  await page.locator('.vlt-item[data-item="Bank portal"]').click();
  await page.locator('.vlt-panel[data-item="Bank portal"]').waitFor();
  assert.equal(await page.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
  assert.ok(await page.getByText('ravi@fivestar.in').isVisible(), 'non-secret user name shown');
  assert.ok(!(await html(page)).includes(SECRETS.i1.password));
  assert.equal(await page.locator('.vlt-panel').getByRole('button', { name: /^(Reveal|Show) / }).count(), 0, 'no reveal button in the item view');
  assert.equal(await page.locator('.vlt-panel [data-state="revealed"]').count(), 0);
  assert.equal(writes.filter((w) => w.ep.endsWith('/reveal')).length, 0, 'opening an item fetches no value');
  assert.match(await page.locator('.vlt-copy-only').innerText(), /never shown here/);
  // Remarks are for reading (line breaks kept) and a second address is a link; neither is masked.
  const remark = page.locator('[data-field="remarks"] .vlt-remark');
  assert.equal(await remark.innerText(), 'Shared login for the finance team.\nCall Ravi before changing it.');
  assert.equal(await page.locator('[data-field="statements"] a').getAttribute('href'), 'https://statements.bank.example/login');
  assert.equal(await page.locator('[data-field="statements"] a').getAttribute('rel'), 'noopener noreferrer nofollow');
  await shot(page, 'item-remarks-1440.png');
  assert.match(await page.getByTestId('shield-note').innerText(), /Screen sharing can see a browser tab/);
  checks.push('item-view-copy-only');

  // Copy: on the clipboard, then cleared.
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/i1/reveal') && w.body.copy), 'copy request');
  await page.waitForTimeout(300);
  assert.equal(await clip(page), SECRETS.i1.password);
  assert.ok(!(await html(page)).includes(SECRETS.i1.password), 'a copy is never shown');
  await page.waitForTimeout(5600);
  assert.equal(await clip(page), '', 'clipboard cleared after the workspace time');
  checks.push('copy-and-clear-clipboard');

  // Switching to another window (a meeting app sharing the screen) covers the vault at once; coming back uncovers it.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.getByTestId('vault-cover').waitFor();
  assert.match(await page.getByTestId('vault-cover').innerText(), /Vault hidden/);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByTestId('vault-cover').waitFor({ state: 'detached' });
  checks.push('cover-when-window-left');

  // Files: download goes by POST and records.
  await page.getByRole('tab', { name: /Files/ }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recovery.txt' }).click()]);
  assert.equal(dl.suggestedFilename(), 'recovery.txt');
  assert.ok(writes.some((w) => w.ep === '/api/v1/vault/attachments/a1/download'));
  // History: copied, never shown; always a two-step check (asked for first, so nothing is refused for nothing).
  await page.getByRole('tab', { name: /Earlier values/ }).click();
  assert.equal(await page.locator('.vlt-history').getByRole('button', { name: /Reveal/ }).count(), 0);
  await page.locator('.vlt-history').getByRole('button', { name: 'Copy the earlier Password' }).click();
  await page.locator('.modal').getByText('Confirm it is you').waitFor();
  assert.equal(writes.filter((w) => w.ep.includes('/versions/')).length, 0, 'the code is asked for before the request');
  await page.getByLabel('Two-step code').fill('000000'); await page.getByRole('button', { name: 'Confirm' }).click();
  await page.locator('.modal .form-error').waitFor();
  await page.getByLabel('Two-step code').fill('123 456'); await page.getByRole('button', { name: 'Confirm' }).click();
  await waitFor(() => writes.some((w) => w.ep.includes('/versions/') && w.body.stepUp === STEP), 'earlier value copied');
  await page.waitForTimeout(300);
  assert.equal(await clip(page), 'Old!Value#2025');
  assert.equal(writes.filter((w) => w.ep.includes('/versions/')).at(-1).body.copy, true);
  assert.ok(!(await html(page)).includes('Old!Value#2025'), 'an earlier value is never drawn');
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.locator('.vlt-activity li.warn').waitFor();
  checks.push('files-history-activity');

  // Confidential: the check made a moment ago is reused (no second prompt).
  await page.locator('.vlt-item[data-item="AWS root account"]').click();
  await page.locator('.vlt-panel[data-item="AWS root account"]').waitFor();
  assert.ok(await page.locator('.vlt-badges').getByText('Confidential').isVisible());
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/i2/reveal')), 'confidential copy');
  assert.equal(await page.locator('.modal').count(), 0);
  assert.equal(writes.filter((w) => w.ep.endsWith('/i2/reveal')).at(-1).body.stepUp, STEP);
  assert.equal(writes.filter((w) => w.ep.endsWith('/i2/reveal')).at(-1).body.copy, true);
  checks.push('confidential-step-up-once');

  // Use only: no reveal, only copy.
  await page.locator('.vlt-item[data-item="Payments DB"]').click();
  await page.locator('.vlt-panel[data-item="Payments DB"]').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Reveal Password' }).count(), 0);
  assert.ok(await page.getByRole('button', { name: 'Copy Password' }).isVisible());
  assert.ok(await page.locator('.vlt-badges').getByText('Use only').isVisible());
  checks.push('use-only');

  // One-time code from the server.
  await page.locator('.vlt-item[data-item="Old router"]').click();
  await page.locator('.vlt-panel[data-item="Old router"]').waitFor();
  assert.ok(await page.locator('.vlt-health-callout').isVisible(), 'health warning');
  await page.getByRole('button', { name: 'Show code' }).click();
  await page.locator('.vlt-totp').waitFor();
  assert.equal(await page.locator('.vlt-totp').innerText(), '492 039');
  assert.ok(!(await html(page)).includes(SECRETS.i4.totp), 'the seed never comes to the page');
  checks.push('totp');
  await shot(page, 'item-1440.png');

  // New item: generator, strength, breach check, a bad one-time-code key.
  await page.getByRole('button', { name: 'New item' }).click();
  await page.locator('.modal').getByText('New vault item').waitFor();
  await page.getByRole('radio', { name: 'Login' }).click();
  await page.locator('#vi-title').fill('GitHub');
  await page.locator('#vf-username').fill('asha-rao');
  await page.locator('#vf-password').fill('Summer@2024');
  assert.match(await page.locator('[data-field="password"] .vlt-meter span').innerText(), /Very weak/);
  await page.getByRole('button', { name: 'Check breaches' }).click();
  await page.locator('.vlt-check.bad').waitFor();
  await page.getByRole('button', { name: 'Generate' }).click();
  const generated = await page.getByTestId('generated').innerText();
  assert.equal(generated.length, 20);
  await page.getByRole('button', { name: 'Use this' }).click();
  assert.equal(await page.locator('#vf-password').inputValue(), generated);
  assert.match(await page.locator('[data-field="password"] .vlt-meter span').innerText(), /Strong|Good/);
  await page.locator('#vf-totp').fill('not a key');
  assert.ok(await page.locator('[data-field="totp"] .field-error').isVisible());
  await page.locator('#vf-totp').fill('JBSW Y3DP EHPK 3PXP');
  await page.locator('#vf-remarks').fill('Org owner account. Ask in #platform before changing.');
  await page.getByRole('button', { name: 'Add a field' }).click();
  await page.getByLabel('New field name').fill('Admin console');
  await page.getByLabel('New field type').selectOption('url');
  await page.locator('.vlt-add-field').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#vf-adminConsole').fill('https://github.com/organizations/fivestar/settings');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items' && w.body), 'create');
  const created = writes.find((w) => w.ep === '/api/v1/vault/items' && w.body).body;
  assert.equal(created.title, 'GitHub'); assert.equal(created.collectionId, 'c1'); assert.equal(created.class, 'Secret');
  assert.deepEqual(created.fields.find((f) => f.key === 'password'), { key: 'password', label: 'Password', type: 'password', secret: true, value: generated });
  assert.equal(created.fields.find((f) => f.key === 'totp').value, 'JBSW Y3DP EHPK 3PXP');
  assert.deepEqual(created.fields.find((f) => f.key === 'remarks'), { key: 'remarks', label: 'Remarks', type: 'remark', secret: false, value: 'Org owner account. Ask in #platform before changing.' });
  assert.deepEqual(created.fields.find((f) => f.key === 'adminConsole'), { key: 'adminConsole', label: 'Admin console', type: 'url', secret: false, value: 'https://github.com/organizations/fivestar/settings' });
  checks.push('create-with-generator');

  // Edit: the one place a value shows — fetched only when asked for (recorded as for the edit screen), masked again when the window is
  // left; a secret left as it was is kept, not erased or re-saved.
  await page.locator('.vlt-item[data-item="Bank portal"]').click();
  await page.locator('.vlt-panel[data-item="Bank portal"]').waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('.modal').getByText('Edit “Bank portal”').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), '');
  assert.ok(!(await html(page)).includes(SECRETS.i1.password), 'not in the edit screen until asked for');
  await page.getByRole('button', { name: 'Show the current Password' }).click();
  await page.locator('#vf-password[data-state="revealed"]').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), SECRETS.i1.password);
  assert.equal(await page.locator('#vf-password').getAttribute('type'), 'text');
  { const b = writes.filter((w) => w.ep.endsWith('/i1/reveal')).at(-1).body; assert.deepEqual([b.field, b.copy, b.forEdit], ['password', false, true]); }
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.locator('#vf-password[data-state="masked"]').waitFor();
  assert.equal(await page.locator('#vf-password').getAttribute('type'), 'password');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('#vi-title').fill('Bank portal (main)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items/i1' && w.body), 'update');
  const updated = writes.find((w) => w.ep === '/api/v1/vault/items/i1').body;
  assert.deepEqual(updated.fields.find((f) => f.key === 'password'), { key: 'password', label: 'Password', type: 'password', secret: true, keep: true });
  assert.equal(updated.title, 'Bank portal (main)');
  checks.push('edit-shows-on-request-and-keeps-secret');

  // Import a Bitwarden export.
  await page.getByRole('button', { name: 'Import' }).click();
  const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,Gmail,,,0,https://mail.google.com,asha,"G,m@il#Pass1",\n,,login,Jira,,,0,https://jira.example,asha,password1,\n';
  await page.locator('.modal input[type=file]').setInputFiles({ name: 'bitwarden.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.locator('.vlt-import-preview').waitFor();
  assert.match(await page.locator('.vlt-import-preview').innerText(), /2 items found \(Bitwarden\)/);
  assert.ok(!(await page.locator('.vlt-import-preview').innerText()).includes('G,m@il'), 'no password in the preview');
  await page.getByRole('button', { name: 'Import 2' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/import'), 'import');
  const imp = writes.find((w) => w.ep === '/api/v1/vault/import').body;
  assert.equal(imp.rows.length, 2); assert.equal(imp.rows[0].password, 'G,m@il#Pass1'); assert.equal(imp.collectionId, 'c1');
  checks.push('import');

  // Sharing a collection.
  await page.locator('.vlt-rail [data-collection="Payments servers"]').click();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.locator('.vlt-share-row').first().waitFor();
  assert.equal(await page.locator('.vlt-share-row').count(), 2);
  await page.getByRole('button', { name: 'Add a person' }).click();
  await page.locator('.vlt-share-row').last().getByLabel('Name').selectOption('u4');
  await page.locator('.vlt-share-row').last().getByLabel('Access').selectOption('UseOnly');
  await page.getByRole('button', { name: 'Save access' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/c2/shares')), 'shares');
  const shares = writes.find((w) => w.ep.endsWith('/c2/shares')).body.shares;
  assert.deepEqual(shares.at(-1), { principalType: 'User', principalId: 'u4', access: 'UseOnly', expiresAt: null });
  assert.equal(shares.length, 3);
  checks.push('sharing');
  // A GitHub Actions pipeline may read the collection with its own run token: no secret stored in GitHub.
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await page.getByTestId('machines').waitFor();
  await page.getByRole('button', { name: 'Allow a GitHub Actions pipeline' }).click();
  await page.getByLabel('Repository').fill('https://github.com/fivestar/payments-api');
  await page.getByLabel('Environment').fill('production');
  await page.getByRole('button', { name: 'Allow this pipeline' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/c2/machines') && w.body), 'pipeline allowed');
  const mBody = writes.find((w) => w.ep.endsWith('/c2/machines')).body;
  assert.equal(mBody.repository, 'https://github.com/fivestar/payments-api'); assert.equal(mBody.refPattern, 'main'); assert.equal(mBody.environment, 'production');
  await page.getByTestId('workflow-snippet').waitFor();
  const snippet = await page.getByTestId('workflow-snippet').innerText();
  assert.match(snippet, /id-token: write/); assert.match(snippet, new RegExp(`audience=projecttracker-vault:${ws.id}`)); assert.match(snippet, /::add-mask::/); assert.match(snippet, /environment: production/);
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  checks.push('pipeline-access');

  // Health.
  await page.locator('.vlt-rail button', { hasText: 'Health' }).click();
  await page.locator('.vlt-score').waitFor();
  await page.locator('.vlt-health-list button', { hasText: 'In a public breach' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items' && w.q?.health === 'breached'), 'health filter request');
  await page.waitForFunction(() => document.querySelectorAll('.vlt-item').length === 1);
  assert.equal(await page.locator('.vlt-item').first().getAttribute('data-item'), 'Old router');
  assert.ok(await page.locator('.vlt-chip-on', { hasText: 'In a public breach' }).isVisible());
  checks.push('health');

  // Administration: rules, review, announced access.
  await page.locator('.vlt-rail button', { hasText: 'Administration' }).click();
  await page.getByText('Vault rules').waitFor();
  await page.getByText('Two-step check for every reveal, copy and code').click();
  await page.getByRole('button', { name: 'Save rules' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/policy'), 'policy');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/policy').body, { stepUpAlways: true, clipboardSeconds: 5, sharedAdminsOnly: false });
  await page.getByLabel('Person to review').selectOption('u2');
  await page.locator('.vlt-review').getByText('Ops break-glass').waitFor();
  await page.getByRole('button', { name: 'Take 24-hour access' }).click();
  await page.locator('.modal textarea').fill('Kavya is on leave and the firewall is down');
  await page.getByRole('button', { name: 'Take access' }).click();
  await waitFor(() => writes.some((w) => w.ep.endsWith('/admin-access')), 'admin access');
  assert.deepEqual(writes.find((w) => w.ep.endsWith('/admin-access')).body, { reason: 'Kavya is on leave and the firewall is down', stepUp: STEP });
  checks.push('admin');

  // Decoys: a vault admin marks one from its page; the admin view lists it.
  await page.locator('.vlt-rail button', { hasText: 'All items' }).click();
  await page.locator('.vlt-item[data-item="Payments DB"]').click();
  await page.locator('.vlt-panel[data-item="Payments DB"]').waitFor();
  await page.getByRole('button', { name: 'Make it a decoy' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Make it a decoy' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items/i3/decoy'), 'decoy set');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/items/i3/decoy').body, { decoy: true });
  await page.locator('.vlt-badges').getByText('Decoy').waitFor();
  await page.locator('.vlt-rail button', { hasText: 'Administration' }).click();
  await page.getByTestId('decoys').getByText('Payments DB').waitFor();
  checks.push('decoys');

  // The two-person rule on a collection, set from its settings.
  await page.locator('.vlt-rail [data-collection="Payments servers"]').click();
  await page.getByRole('button', { name: 'Collection settings' }).click();
  await page.locator('.modal').getByText('Two-person rule').click();
  await page.locator('.modal').getByText('People may ask to join for a while').click();
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/collections/c2' && w.body), 'collection rules');
  const rules = writes.find((w) => w.ep === '/api/v1/vault/collections/c2').body;
  assert.equal(rules.requireApproval, true); assert.equal(rules.requestable, true);
  // A copy now asks for approval first; asking sends the reason and the window.
  await page.reload(); await page.locator('.vlt-items').waitFor();
  await page.locator('.vlt-item[data-item="AWS root account"]').click();
  await page.getByTestId('approval').waitFor();
  assert.match(await page.getByTestId('approval').innerText(), /Two-person rule/);
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await page.locator('.modal').getByText('Confirm it is you').waitFor();   // confidential: the check first (the reload forgot it)
  await page.getByLabel('Two-step code').fill('123456'); await page.getByRole('button', { name: 'Confirm' }).click();
  await page.locator('.modal').getByText('Ask for “AWS root account”').waitFor();
  assert.ok(!(await html(page)).includes(SECRETS.i2.password));
  await page.locator('.modal').getByRole('radio', { name: '15 minutes' }).click();
  await page.locator('.modal textarea').fill('Rotating the root key in tonight’s window');
  await page.locator('.modal').getByRole('button', { name: 'Ask', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/items/i2/requests'), 'reveal request');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/items/i2/requests').body, { reason: 'Rotating the root key in tonight’s window', minutes: 15 });
  await page.getByTestId('approval').getByText(/waiting for someone to approve/).waitFor();
  checks.push('two-person-rule-ask');

  // Requests: decide on someone else's, and ask to join a collection for a while.
  assert.match(await page.getByTestId('rail-requests').innerText(), /1/);
  await page.getByTestId('rail-requests').click();
  await page.getByTestId('requests').waitFor();
  await page.locator('[data-request="r1"]').getByRole('button', { name: /Approve/ }).click();
  await page.locator('.modal input').fill('Go ahead, rotate after');
  await page.locator('.modal').getByRole('button', { name: 'Approve', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/requests/r1/approve'), 'approve');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/requests/r1/approve').body, { note: 'Go ahead, rotate after' });
  await page.getByRole('button', { name: 'Ask for access' }).click();
  await page.locator('.modal').getByRole('radio', { name: 'View' }).click();
  await page.locator('.modal').getByRole('radio', { name: '1 day' }).click();
  await page.locator('.modal textarea').fill('Covering the network on-call this week');
  await page.locator('.modal').getByRole('button', { name: 'Ask', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/collections/c8/requests'), 'collection request');
  assert.deepEqual(writes.find((w) => w.ep === '/api/v1/vault/collections/c8/requests').body, { reason: 'Covering the network on-call this week', minutes: 1440, access: 'View' });
  await page.getByTestId('requests').getByText(/Waiting/).first().waitFor();
  await shot(page, 'requests-1440.png');
  // Approved: the copy goes through.
  reqState.mine.find((r) => r.itemId === 'i2').status = 'Approved';
  reqState.mine.find((r) => r.itemId === 'i2').grantedUntil = new Date(Date.now() + 900e3).toISOString();
  reqState.mine.find((r) => r.itemId === 'i2').decidedBy = { id: 'u4', name: 'Meera Iyer' };
  await page.goto(`${origin}/preview-org/vault?item=i2`); await page.getByTestId('approval').getByText(/Approved by Meera Iyer/).waitFor();
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await page.locator('.modal').getByText('Confirm it is you').waitFor();   // a reload forgot the check: confidential asks again
  await page.getByLabel('Two-step code').fill('123456'); await page.getByRole('button', { name: 'Confirm' }).click();
  await waitFor(async () => (await clip(page)) === SECRETS.i2.password, 'approved copy');
  collections[1].requireApproval = false;
  checks.push('requests');

  // Send once: encrypted here; the link carries the key after #; it opens once, without signing in, then it is gone.
  await page.goto(`${origin}/preview-org/vault?item=i1`); await page.locator('.vlt-panel[data-item^="Bank portal"]').waitFor();
  await page.getByRole('button', { name: 'Send once' }).click();
  await page.locator('.modal').getByText('Notes').click();   // not the notes
  await page.locator('.modal').getByText('Also ask for a passphrase').click();
  await page.getByRole('textbox', { name: 'Passphrase' }).fill('blue elephant');
  await page.locator('.modal').getByPlaceholder('For the vendor audit on Friday').fill('For the bank audit');
  await page.locator('.modal').getByRole('button', { name: 'Make the link' }).click();
  await page.getByTestId('link-made').waitFor();
  const linkUrl = await page.locator('.vlt-link-url').innerText();
  assert.match(linkUrl, new RegExp(`^${origin}/s/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$`));
  const madeLink = writes.find((w) => w.ep === '/api/v1/vault/links').body;
  const fragKey = linkUrl.split('#')[1];
  for (const x of [SECRETS.i1.password, 'blue elephant', fragKey, linkUrl.split('/s/')[1].split('#')[0]]) assert.ok(!JSON.stringify(madeLink).includes(x), 'the server gets no secret, passphrase, key or token');
  assert.equal(madeLink.itemId, 'i1'); assert.equal(madeLink.maxViews, 1); assert.equal(madeLink.hasPassphrase, true); assert.equal(madeLink.note, 'For the bank audit');
  assert.ok(writes.some((w) => w.ep.endsWith('/i1/reveal') && w.body.copy && w.body.field === 'password'), 'a guarded value is fetched like a copy');
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click();
  // The recipient: no sign-in, the key leaves the address bar, a wrong passphrase can be retried without using the link again.
  const rpage = await ctx.newPage(); rpage.on('pageerror', (e) => errors.push(e.message));
  await rpage.goto(linkUrl); await rpage.getByTestId('secret-page').getByText('Asha Rao sent you a secret').waitFor();
  assert.ok(!rpage.url().includes('#'), 'the key is taken out of the address bar');
  assert.match(await rpage.getByTestId('secret-page').innerText(), /For the bank audit/);
  assert.equal(writes.filter((w) => w.ep.startsWith('/api/v1/secret-links/') && w.ep.endsWith('/open')).length, 0, 'looking does not use it up');
  await rpage.getByLabel('Passphrase').fill('blue elefant');
  await rpage.getByRole('button', { name: 'Open the secret' }).click();
  await rpage.getByText(/That passphrase does not open it/).waitFor();
  await rpage.getByLabel('Passphrase').fill('blue elephant');
  await rpage.getByRole('button', { name: 'Try again' }).click();
  await rpage.getByRole('heading', { name: 'Bank portal' }).waitFor();
  assert.equal(writes.filter((w) => w.ep.endsWith('/open')).length, 1, 'opened once');
  assert.ok(!(await rpage.evaluate(() => document.body.innerText)).includes(SECRETS.i1.password), 'masked until asked');
  assert.ok(!(await rpage.evaluate(() => document.body.innerText)).includes(SECRETS.i1.note), 'only what was chosen');
  await rpage.getByRole('button', { name: 'Copy Password' }).click();
  await waitFor(async () => (await rpage.evaluate(() => navigator.clipboard.readText())) === SECRETS.i1.password, 'copied on the recipient page');
  await shot(rpage, 'secret-link-1440.png');
  await rpage.close();
  const again = await ctx.newPage(); again.on('pageerror', (e) => errors.push(e.message));
  await again.goto(linkUrl); await again.getByText('This link no longer works').waitFor();
  await again.close();
  await page.locator('.vlt-rail button', { hasText: 'One-time links' }).click();
  await page.getByTestId('links').getByText('Opened and destroyed').waitFor();
  checks.push('one-time-link');

  // ---- the sealed vault, with a passkey from a virtual authenticator that supports PRF
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
  assert.match(await page.getByTestId('lock-state').innerText(), /Set up sealed vault/);
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Create my vault keys' }).click();
  await page.getByTestId('recovery-kit').waitFor();
  const kit = (await page.getByLabel('Recovery key').innerText()).trim();
  assert.match(kit, /^PTV1(-[A-Z2-9]{4}){8}$/);
  const setup = writes.find((w) => w.ep === '/api/v1/vault/keys/setup').body;
  assert.deepEqual(setup.unlocks.map((u) => u.kind), ['RecoveryKey', 'Passkey'], 'a recovery key and a passkey');
  assert.equal(Buffer.from(setup.mlKemPublic, 'base64').length, 1184, 'an ML-KEM-768 public key');
  assert.ok(!JSON.stringify(setup).includes(kit) && !JSON.stringify(setup).includes(kit.replace(/-/g, '')), 'the recovery key never leaves the page');
  assert.match(setup.fingerprint, /^\d{5}( \d{5}){11}$/);
  await page.getByText('I have saved it somewhere safe and offline.').click();
  await page.getByLabel('Last four characters').fill(kit.slice(-4));
  await page.getByRole('button', { name: 'Done — open my vault' }).click();
  await page.getByTestId('safety-code').waitFor();
  assert.equal(await page.getByTestId('safety-code').innerText(), setup.fingerprint);
  assert.match(await page.getByTestId('lock-state').innerText(), /Sealed vault open/);
  checks.push('sealed-keys-with-passkey');
  // The recovery circle: offered once keys exist; only colleagues with vault keys can be chosen.
  assert.match(await page.getByTestId('circle').innerText(), /No circle yet/);
  await page.getByRole('button', { name: 'Set up a recovery circle' }).click();
  await page.locator('.modal').getByText('Ravi Kumar').waitFor();
  assert.ok(await page.locator('.modal input[type=checkbox]').first().isDisabled(), 'nobody without vault keys');
  assert.ok(await page.locator('.modal').getByRole('button', { name: 'Split and share' }).isDisabled());
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  checks.push('recovery-circle-card');
  await shot(page, 'sealed-keys-1440.png');

  // A sealed collection: its key is made here and wrapped to me (hybrid X25519 + ML-KEM-768 envelope).
  await page.getByRole('button', { name: 'New collection' }).click();
  await page.locator('.modal').getByRole('radio', { name: /Sealed/ }).waitFor();
  assert.equal(await page.locator('.modal').getByRole('radio', { name: /Sealed/ }).getAttribute('aria-checked'), 'true', 'sealed is the default once keys are open');
  await page.locator('.modal').getByLabel('Name', { exact: false }).first().fill('Root secrets');
  await page.locator('.modal').getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep.match(/collections\/c\d+\/keys$/) && w.body), 'first key');
  const madeCol = writes.find((w) => w.ep === '/api/v1/vault/collections' && w.body?.sealed);
  assert.ok(madeCol, 'collection made sealed');
  const env = writes.find((w) => w.ep.match(/collections\/c\d+\/keys$/) && w.body).body.envelopes[0];
  assert.equal(Buffer.from(env.envelope, 'base64').length, 1 + 32 + 1088 + 1 + 12 + 32 + 16, 'version, ephemeral X25519, ML-KEM ciphertext, wrapped key');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();   // the access list that opens next
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByRole('button', { name: 'New item' }).first().click();
  await page.locator('#vi-title').fill('Cloud root');
  await page.locator('#vf-username').fill('root@fivestar.in');
  await page.locator('#vf-password').fill('Se@led!Root#2026x');
  assert.match(await page.locator('.modal-head p').innerText(), /encrypted on this device/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/sealed-items'), 'sealed item');
  const sent = writes.find((w) => w.ep === '/api/v1/vault/sealed-items').body;
  for (const secret of ['Cloud root', 'Se@led!Root#2026x', 'root@fivestar.in']) assert.ok(!JSON.stringify(sent).includes(secret), `"${secret}" never reaches the server`);
  assert.match(sent.id, /^[0-9a-f-]{36}$/, 'the id is made in the browser (it is bound into the encryption)');
  await page.locator('.vlt-panel-sealed[data-item="Cloud root"]').waitFor();
  const revealsBefore = writes.filter((w) => w.ep.endsWith('/reveal')).length;
  assert.equal(await page.locator('.vlt-panel-sealed').getByRole('button', { name: /^(Reveal|Show) / }).count(), 0, 'no reveal in the sealed item view');
  assert.ok(!(await html(page)).includes('Se@led!Root#2026x'), 'decrypted in memory, never drawn');
  await page.locator('.vlt-panel-sealed').getByRole('button', { name: 'Copy Password' }).click();
  await page.waitForTimeout(300);
  assert.equal(await clip(page), 'Se@led!Root#2026x');
  assert.equal(writes.filter((w) => w.ep.endsWith('/reveal')).length, revealsBefore, 'decrypted here, not asked of the server');
  await waitFor(() => sealedState.events.some((e) => e.action === 'copied'), 'the copy is recorded');
  assert.ok(await page.locator('.vlt-panel-sealed .vlt-e2ee').isVisible());
  // In the edit screen it can be shown (recorded), and it masks itself again.
  await page.locator('.vlt-panel-sealed').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#vf-password[data-state="masked"]').waitFor();
  await page.getByRole('button', { name: 'Show Password', exact: true }).click();
  await page.locator('#vf-password[data-state="revealed"]').waitFor();
  assert.equal(await page.locator('#vf-password').inputValue(), 'Se@led!Root#2026x');
  await waitFor(() => sealedState.events.some((e) => e.action === 'revealed' && /edit screen/.test(e.field)), 'the edit-screen reveal is recorded');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();
  checks.push('sealed-item-never-readable-on-server');
  await shot(page, 'sealed-item-1440.png');

  // Lock: keys wiped from memory. Unlock with the passkey, then with the recovery key; a waiting device is approved after its code is checked.
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  assert.match(await page.getByTestId('lock-state').innerText(), /locked/);
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByTestId('unlock').waitFor();
  assert.ok(!(await html(page)).includes('Se@led!Root#2026x'));
  const helper = { xPriv: x25519.utils.randomSecretKey(), kem: ml_kem768.keygen() };
  reqState.toHelp = [{ requestId: 'h1', person: { id: 'u2', name: 'Ravi Kumar' }, x25519Public: Buffer.from(x25519.getPublicKey(helper.xPriv)).toString('base64'), mlKemPublic: Buffer.from(helper.kem.publicKey).toString('base64'),
    createdAt: now, expiresAt: now, ipAddress: '203.0.113.x', userAgent: 'Firefox', shareEnvelope: 'AAAA', shareSignature: 'AAAA', ownerEd25519Public: 'AAAA', ownerGeneration: 1, threshold: 2 }];
  await page.getByRole('button', { name: 'Unlock with passkey' }).click();
  await page.locator('.vlt-item[data-item="Cloud root"]').waitFor();
  checks.push('unlock-with-passkey');
  // A colleague asks their circle for help: the code to compare, a warning to call them, and a refusal that reaches the server.
  await page.getByTestId('circle-help').waitFor();
  { const hh = sha256(Buffer.concat([Buffer.from('pt-vault/link/v1'), x25519.getPublicKey(helper.xPriv), helper.kem.publicKey]));
    const nn = String((((hh[0] << 24) >>> 0) + (hh[1] << 16) + (hh[2] << 8) + hh[3]) % 100000000).padStart(8, '0');
    assert.equal(await page.locator('[data-testid="circle-help"] .vlt-link-code').innerText(), `${nn.slice(0, 4)} ${nn.slice(4)}`); }
  assert.match(await page.getByTestId('circle-help').innerText(), /Call Ravi Kumar or see them in person/);
  await page.getByTestId('circle-help').getByRole('button', { name: 'Refuse' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/recovery/h1/refuse'), 'refused');
  await page.getByTestId('circle-help').waitFor({ state: 'detached' });
  checks.push('circle-help-request');

  // A passkey answers a step-up too (the risk check asks here): fingerprint, face or screen lock instead of a code.
  await page.locator('.vlt-rail button', { hasText: 'All items' }).click();
  await page.locator('.vlt-item[data-item="AWS root account"]').click();
  await page.locator('.vlt-panel[data-item="AWS root account"]').waitFor();
  reqState.forceStepUp = true;
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByRole('button', { name: 'Copy Password' }).click();
  await page.getByTestId('step-up-passkey').click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/step-up/passkey'), 'passkey step-up');
  const pk = writes.find((w) => w.ep === '/api/v1/vault/step-up/passkey').body;
  assert.equal(pk.challengeId, 'ch1'); assert.ok(pk.response.response.signature && pk.response.response.authenticatorData, 'a signed assertion');
  await waitFor(async () => (await clip(page)) === SECRETS.i2.password, 'copy after the passkey check');
  assert.equal(writes.filter((w) => w.ep.endsWith('/i2/reveal')).at(-1).body.stepUp, 'passkey-token');
  checks.push('passkey-step-up');

  const eph = { xPriv: x25519.utils.randomSecretKey(), kem: ml_kem768.keygen() };
  const ephPub = { x25519Public: Buffer.from(x25519.getPublicKey(eph.xPriv)).toString('base64'), mlKemPublic: Buffer.from(eph.kem.publicKey).toString('base64') };
  sealedState.pendingDevice = { link: { id: 'd1', label: 'A phone', ...ephPub, createdAt: now, expiresAt: new Date(Date.now() + 600e3).toISOString(), ipAddress: '203.0.113.20', userAgent: 'Mobile Safari', approved: false, denied: false, envelope: null, signature: null } };
  await page.getByTestId('lock-state').click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  await page.locator('.vlt-rail [data-collection="Root secrets"]').click();
  await page.getByRole('button', { name: 'Ask my recovery circle' }).click();
  await page.getByRole('button', { name: 'Ask my circle' }).click();
  await page.getByTestId('circle-code').waitFor();
  { const sentEph = writes.find((w) => w.ep === '/api/v1/vault/recovery').body;
    const hh = sha256(Buffer.concat([Buffer.from('pt-vault/link/v1'), Buffer.from(sentEph.x25519Public, 'base64'), Buffer.from(sentEph.mlKemPublic, 'base64')]));
    const nn = String((((hh[0] << 24) >>> 0) + (hh[1] << 16) + (hh[2] << 8) + hh[3]) % 100000000).padStart(8, '0');
    assert.equal(await page.getByTestId('circle-code').innerText(), `${nn.slice(0, 4)} ${nn.slice(4)}`, 'the code helpers compare');
    assert.equal(Buffer.from(sentEph.mlKemPublic, 'base64').length, 1184, 'one-time post-quantum keys for the shares'); }
  await page.getByTestId('ask-circle').getByText(/0 of 2 helped/).waitFor();
  await page.getByTestId('ask-circle').getByRole('button', { name: 'Cancel' }).click();
  await waitFor(() => writes.some((w) => w.ep === '/api/v1/vault/recovery/rec1/finish' && w.q.recovered === 'false'), 'cancelled');
  checks.push('ask-recovery-circle');
  await page.getByRole('button', { name: 'Use my recovery key' }).click();
  await page.getByLabel('Recovery key').fill(kit.toLowerCase());
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByTestId('device-approval').waitFor();
  const h = sha256(Buffer.concat([Buffer.from('pt-vault/link/v1'), x25519.getPublicKey(eph.xPriv), eph.kem.publicKey]));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3], code = String(n % 100000000).padStart(8, '0');
  assert.equal(await page.locator('[data-testid="device-approval"] .vlt-link-code').innerText(), `${code.slice(0, 4)} ${code.slice(4)}`, 'the same code as the new device');
  await page.getByRole('button', { name: 'The codes match — approve' }).click();
  await waitFor(() => sealedState.pendingDevice.approved, 'approval');
  // Open the envelope as the new device would: it must hold the identity secret that gives exactly the keys on record.
  const ctxStr = `device|${ws.id}|${user.id}|d1`;
  const raw = Buffer.from(sealedState.pendingDevice.approved.envelope, 'base64');
  const ePub = raw.subarray(1, 33), kemCt = raw.subarray(33, 33 + 1088);
  const key = hkdf(sha256, Buffer.concat([x25519.getSharedSecret(eph.xPriv, ePub), ml_kem768.decapsulate(kemCt, eph.kem.secretKey)]), Buffer.concat([ePub, sha256(kemCt)]), Buffer.from(`pt-vault/wrap/v1|${ctxStr}`), 32);
  const aes = raw.subarray(33 + 1088);
  const k = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  const seed = new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: aes.subarray(1, 13), additionalData: Buffer.from(ctxStr) }, k, aes.subarray(13)));
  const xPub = x25519.getPublicKey(hkdf(sha256, seed, undefined, Buffer.from('pt-vault/x25519/v1'), 32));
  assert.equal(Buffer.from(xPub).toString('base64'), sealedState.identity.x25519Public, 'the linked device gets the real identity');
  checks.push('recovery-unlock-and-device-link');

  // A reload starts locked: nothing of the keys survives in storage.
  await page.reload();
  await page.locator('.vlt-rail').waitFor();
  assert.match(await page.getByTestId('lock-state').innerText(), /locked/);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.ok(!stored.includes(kit) && !stored.includes('Se@led!Root#2026x'));
  checks.push('reload-starts-locked');
  await shot(page, 'admin-1440.png');
  assert.deepEqual(errors, []);
  await ctx.close();

  // Dark theme and the phone.
  for (const theme of ['dark', 'light']) {
    ctx = await make(theme); page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
    await fitsPhone(page, `vault list ${theme}`, assert);
    await shot(page, `phone-list-${theme}.png`);
    await page.locator('.vlt-item[data-item^="Bank portal"]').click();
    await page.locator('.vlt-panel[data-item^="Bank portal"]').waitFor();
    assert.equal(await page.locator('.vlt-main').isVisible(), false, 'the panel replaces the list on a phone');
    assert.equal(await page.locator('[data-field="password"] .vlt-secret').getAttribute('data-state'), 'masked');
    await fitsPhone(page, `vault item ${theme}`, assert);
    await shot(page, `phone-item-${theme}.png`);
    await page.getByRole('button', { name: 'Back to the list' }).click();
    await page.locator('.vlt-items').waitFor();
    await page.getByRole('button', { name: 'New item' }).click();
    await page.locator('.modal').getByText('New vault item').waitFor();
    await fitsPhone(page, `vault editor ${theme}`, assert);
    await shot(page, `phone-editor-${theme}.png`);
    await ctx.close();
  }
  checks.push('phone-both-themes');

  // The desktop app: the window is kept out of screen sharing while the vault is open, and let go when it is left.
  ctx = await make('light', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141 ProjectTrackerDesktop/1.0.0' });
  await ctx.addInitScript(() => { window.__shield = []; window.ptDesktop = { platform: 'win32', protectContent: (on) => window.__shield.push(on), windowControl: () => {}, onMaximizeChange: () => {}, attention: () => {} }; });
  page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/preview-org/vault`); await page.locator('.vlt-items').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__shield), [true], 'shield on while the vault is open');
  assert.match(await page.getByTestId('shield-note').innerText(), /Hidden from screen sharing/);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('vault-cover').count(), 0, 'no cover needed where the system hides the window');
  await page.evaluate(() => { history.pushState({}, '', '/preview-org/projects'); dispatchEvent(new PopStateEvent('popstate')); });
  await waitFor(() => true, 'navigation');
  await page.waitForFunction(() => window.__shield.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__shield), [true, false], 'shield off once the vault is left');
  await ctx.close();
  checks.push('desktop-screen-share-shield');
  assert.deepEqual(errors, []);
  console.log(`Vault UI OK: ${checks.join(', ')}`);
} finally { await browser.close(); }
