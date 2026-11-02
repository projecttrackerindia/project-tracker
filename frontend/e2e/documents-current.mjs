// Seeded live-API journeys for the current Library/reader. API assertions cover persisted business state;
// browser assertions cover the real navigation, wizard, editor, readers, inspectors and downloads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { account, business, createDoc, go, publish, reader, rich, saveText, start, unique, waitFor } from './support.mjs';

async function inspector(s, name) {
  const button = s.page.getByTestId('doc-inspector').getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function core(s) {
  await go(s, '/library');
  await s.page.getByRole('button', { name: 'New doc', exact: true }).click();
  await s.page.getByRole('menuitem', { name: /From a template/ }).click();
  const modal = s.page.getByRole('dialog', { name: 'New document', exact: true });
  await modal.getByRole('radio', { name: /Business requirement document/ }).click();
  const title = unique('Employee portal integration');
  await modal.locator('input.input').first().fill(title);
  const projects = await s.api('/projects?pageSize=100');
  assert.ok(projects.items.length, 'A seeded project exists');
  await modal.locator('.ss-trigger').first().click();
  await s.page.getByRole('listbox', { name: 'Project', exact: true }).getByRole('option', { name: new RegExp(projects.items[0].key) }).click();
  await modal.getByRole('button', { name: /^Next/ }).click();
  const content = modal.locator('.rte-content').first();
  await content.click(); await s.page.keyboard.insertText('Employees must see their payslip online.');
  const steps = await modal.locator('.wiz-steps li').count();
  assert.ok(steps >= 2 && steps <= 6, 'The BRD wizard stays bounded');
  for (let i = 0; i < steps; i++) {
    const create = modal.getByRole('button', { name: 'Create document', exact: true });
    if (await create.isVisible()) { await create.click(); break; }
    await modal.getByRole('button', { name: /^(Next|Review)/ }).click();
  }
  await s.page.getByTestId('doc-reader').waitFor();
  await s.page.getByRole('heading', { name: title, exact: true }).waitFor();
  const id = s.page.url().match(/\/(?:docs|d)\/([0-9a-f-]{36})/)?.[1];
  assert.ok(id, 'The document opens in its Library space');
  let doc = await s.api(`/documents/${id}`);
  assert.ok(doc.item.key.startsWith('DOC-'));
  assert.ok(JSON.stringify(doc.sections).includes('Employees must see their payslip online.'));
  await s.page.getByRole('toolbar', { name: 'Document actions' }).getByRole('button', { name: 'Edit', exact: true }).click();
  await s.page.locator('#sec-scope .rte-content').click();
  await s.page.keyboard.insertText('Scope: payslips only.');
  await s.page.getByTestId('edit-toolbar').getByText('Unsaved changes', { exact: true }).waitFor();
  await s.page.getByTestId('edit-toolbar').getByRole('button', { name: /^Save/ }).click();
  await s.page.getByTestId('edit-toolbar').getByText('All changes saved', { exact: true }).waitFor();
  await s.page.reload();
  await s.page.locator('#sec-scope').getByText('Scope: payslips only.', { exact: false }).waitFor();
  doc = await s.api(`/documents/${id}`);
  const first = await publish(s, doc, 'First complete draft');
  assert.equal(first.publishedLabel, '1.0');
  await saveText(s, doc, 'Tax forms too.');
  const second = await publish(s, doc, 'Added tax forms');
  assert.equal(second.publishedLabel, '1.1');
  const v1 = second.items.find((v) => v.label === '1.0'), v2 = second.items.find((v) => v.label === '1.1');
  const diff = await s.api(`/documents/${id}/compare?from=${v1.id}&to=${v2.id}`);
  assert.ok(diff.changed > 0, 'Version compare detects changed text');
  const latest = await s.api(`/documents/${id}`);
  const restored = await s.api(`/documents/${id}/versions/${v1.id}/restore`, 'POST', { reason: 'Restore checked scope', discardChanges: true, revision: latest.revision });
  assert.equal(restored.publishedLabel, '1.2');
  const restoredDoc = await s.api(`/documents/${id}`);
  assert.ok(JSON.stringify(restoredDoc.sections).includes('Scope: payslips only.'));
  assert.ok(!JSON.stringify(restoredDoc.sections).includes('Tax forms too.'));
  const priya = await account('priya@example.com');
  const access = await s.api(`/documents/${id}/grants`, 'POST', { principalType: 'User', principalId: priya.user.id, level: 'Editor' });
  const grant = access.grants.find((g) => g.principalId === priya.user.id); assert.ok(grant);
  await s.api(`/documents/${id}/grants/${grant.id}`, 'DELETE');
  assert.ok(!(await s.api(`/documents/${id}/access`)).grants.some((g) => g.id === grant.id));
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'flow.png');
  await s.api(`/documents/${id}/files`, 'POST', form);
  assert.ok((await s.api(`/documents/${id}/files`)).some((f) => f.fileName === 'flow.png'));
  await s.api(`/documents/${id}/links`, 'POST', { targetType: 'Project', targetId: projects.items[0].id, relation: 'Describes' });
  const backlinks = await s.api(`/linked-documents?targetType=Project&targetId=${projects.items[0].id}`);
  assert.ok(JSON.stringify(backlinks).includes(id), 'The project links back to the document');
  await reader(s, restoredDoc);
  await inspector(s, 'Versions');
  await s.page.getByTestId('doc-inspector').getByText('First complete draft', { exact: false }).waitFor();
  await s.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  console.log('PASS document wizard, edit/save/reload, publish/compare/restore, grants, files, project links and phone reader');
}

async function apiReference(s) {
  const doc = await createDoc(s, 'API', unique('Payments API reference'));
  const id = doc.item.id;
  const spec = { openapi: '3.0.3', info: { title: 'Imported shop', version: '3' }, servers: [{ url: 'https://shop.example.test' }], paths: {
    '/orders': { get: { summary: 'List orders', responses: { 200: { description: 'ok' } } }, post: { summary: 'Create order', responses: { 201: { description: 'created' } } } },
    '/orders/{id}': { get: { summary: 'Get an order', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } },
  } };
  const request = { content: JSON.stringify(spec), fileName: 'shop.openapi.json', mode: 'merge', dryRun: true };
  const preview = await s.api(`/documents/${id}/api/import`, 'POST', request);
  assert.equal(preview.success, true); assert.equal(preview.applied, false); assert.equal(preview.added, 3);
  assert.equal((await s.api(`/documents/${id}/api`)).endpoints, 0, 'Dry run does not write endpoints');
  const imported = await s.api(`/documents/${id}/api/import`, 'POST', { ...request, dryRun: false });
  assert.equal(imported.applied, true);
  const list = await s.api(`/documents/${id}/api/endpoints`); assert.equal(list.items.length, 3);
  const endpoint = list.items.find((e) => e.path === '/orders/{id}');
  const details = await s.api(`/documents/${id}/api/endpoints/${endpoint.id}`);
  assert.ok(details.details.parameters.some((p) => p.name === 'id' && p.required));
  const defs = await s.api(`/documents/${id}/api`), def = defs.definitions[0];
  const exported = await s.raw(`/documents/${id}/api/export?format=openapi&definitionId=${def.id}`);
  assert.ok(exported.ok); assert.ok((await exported.text()).includes('/orders/{id}'));
  await publish(s, doc, 'Initial API');
  const versions = await s.api(`/documents/${id}/versions`), version = versions.items.find((v) => !v.isDraft);
  await s.api(`/documents/${id}/api/endpoints/${endpoint.id}`, 'DELETE');
  const draft = (await s.api(`/documents/${id}/versions`)).items.find((v) => v.isDraft); assert.ok(draft);
  const changes = await s.api(`/documents/${id}/api/changes?from=${version.id}&to=${draft.id}`);
  assert.ok(changes.removed >= 1 && changes.breaking >= 1, 'Removing a documented endpoint is breaking');
  const curl = "curl 'https://shop.example.test/private' -H 'Authorization: Bearer synthetic-smoke-credential'";
  const checked = await s.api(`/documents/${id}/api/import`, 'POST', { content: curl, fileName: 'request.curl', mode: 'merge', dryRun: true });
  assert.ok(!JSON.stringify(checked).includes('synthetic-smoke-credential'), 'Import preview does not disclose credentials');
  await reader(s, doc);
  await s.page.getByTestId('endpoint-cards').waitFor();
  await s.page.getByTestId('endpoint-cards').getByText('/orders', { exact: true }).first().waitFor();
  console.log('PASS API import dry-run/apply, required parameter, export, breaking change, credential redaction and endpoint reader');
}

async function review(s) {
  const priya = await account('priya@example.com'), kumar = await account('kumar@example.com');
  const workflow = await s.api('/document-workflows', 'POST', { typeId: null, name: unique('Business approval'), isActive: true, remind: false,
    steps: [{ name: 'Business owner', kind: 'User', principalId: priya.user.id, rule: 'Any', dueDays: null }] });
  try {
    const doc = await createDoc(s, 'BRD', unique('Leave management'));
    const saved = await saveText(s, doc, 'Employees request leave online.');
    const submitted = await s.api(`/documents/${doc.item.id}/submit`, 'POST', { revision: saved.revision, changeSummary: 'First complete draft', major: false });
    assert.equal(submitted.current.state, 'Pending'); assert.equal(submitted.current.canDecide, false);
    const denied = await s.raw(`/documents/${doc.item.id}/approve`, 'POST', { comment: 'Self approval must fail' }); assert.ok(!denied.ok);
    assert.ok((await priya.api('/documents/inbox')).toReview.some((r) => r.document.id === doc.item.id));
    const approved = await priya.api(`/documents/${doc.item.id}/approve`, 'POST', { comment: 'Looks right.' });
    assert.equal(approved.current.state, 'Approved');
    const published = await publish(s, doc, 'First complete draft'); assert.equal(published.publishedLabel, '1.0');
    const requirements = await s.api(`/documents/${doc.item.id}/requirements`, 'POST', { titles: ['Request leave', 'Approve leave', 'Show balances'] });
    assert.equal(requirements.length, 3);
    const coverage = await s.api(`/documents/${doc.item.id}/coverage`); assert.equal(coverage.requirements, 3); assert.equal(coverage.withoutTask, 3);
    assert.ok((await s.api(`/documents/${doc.item.id}/activity`)).length >= 4);
    await reader(s, doc); await inspector(s, 'Versions');
    await s.page.getByTestId('doc-inspector').getByText('First complete draft', { exact: false }).waitFor();
    const privateDoc = await createDoc(s, 'BRD', unique('Salary bands'), { visibility: 'Private' });
    assert.ok(!(await kumar.raw(`/documents/${privateDoc.item.id}`)).ok, 'A private document refuses an unrelated user');
    const request = await kumar.api(`/documents/${privateDoc.item.id}/access-requests`, 'POST', { level: 'Viewer', reason: 'Review access for the seeded smoke test', durationDays: 1 });
    assert.equal(request.status, 'Pending');
    await s.api(`/access-requests/${request.id}/decide`, 'POST', { approve: true, level: 'Viewer', durationDays: 1, note: 'Approved for smoke' });
    assert.ok((await kumar.raw(`/documents/${privateDoc.item.id}`)).ok, 'Approved access allows reading');
    console.log('PASS cross-user review/self-approval denial, publish history, requirements/coverage, activity and private access request');
  } finally { await s.api(`/document-workflows/${workflow.id}`, 'DELETE'); }
}

async function secrets(s) {
  const doc = await createDoc(s, 'BRD', unique('Integration credentials')), id = doc.item.id;
  const value = 'synthetic-smoke-key-not-a-real-credential';
  const list = await s.api(`/documents/${id}/secrets`, 'POST', { label: 'Smoke key', value, note: 'Only in the disposable local test server', class: 'Secret' });
  assert.ok(!JSON.stringify(list).includes(value));
  const secret = list.items.find((i) => i.label === 'Smoke key'); assert.ok(secret);
  const confidential = await s.api(`/documents/${id}/secrets`, 'POST', { label: 'Confidential smoke', value: 'synthetic-confidential', class: 'Confidential' });
  const confidentialId = confidential.items.find((i) => i.label === 'Confidential smoke').id;
  const denied = await s.raw(`/documents/${id}/secrets/${confidentialId}/reveal`, 'POST', {});
  assert.ok(!denied.ok, 'Confidential reveals require a fresh second-factor check');
  const security = await s.api('/document-security');
  try {
    await s.api('/document-security/reveal-duration', 'PUT', { seconds: 5 });
    await reader(s, doc); await inspector(s, 'Related docs & work');
    const row = s.page.locator('li[data-secret="Smoke key"]');
    await row.locator('[data-state="masked"]').waitFor();
    assert.ok(!(await s.page.content()).includes(value));
    await row.getByRole('button', { name: 'Reveal Smoke key', exact: true }).click();
    await row.getByText(value, { exact: true }).waitFor();
    await row.getByRole('timer').waitFor();
    await row.getByRole('button', { name: 'Hide Smoke key', exact: true }).click();
    await row.locator('[data-state="masked"]').waitFor();
    await row.getByRole('button', { name: 'Reveal Smoke key', exact: true }).click();
    await row.getByText(value, { exact: true }).waitFor();
    await row.locator('[data-state="masked"]').waitFor({ timeout: 7000 });
    assert.ok(!(await s.page.content()).includes(value));
    assert.ok((await s.api(`/documents/${id}/audit`)).items.length > 0);
    const rotated = await s.api('/document-security/rotate-key', 'POST'); assert.ok(rotated.keyVersion > security.keyVersion);
    assert.equal((await s.api(`/documents/${id}/secrets/${secret.id}/reveal`, 'POST', {})).value, value, 'Rotation preserves decryption');
    assert.equal((await s.api('/document-security/verify-audit', 'POST')).intact, true);
    console.log('PASS masked list, reveal/hide, timed re-mask, audited reveal, key rotation and audit integrity');
  } finally { await s.api('/document-security/reveal-duration', 'PUT', { seconds: security.revealSeconds }); }
}

async function pdf(s) {
  const title = unique('Quokka onboarding flow'), doc = await createDoc(s, 'BRD', title), id = doc.item.id;
  const latest = await s.api(`/documents/${id}`), first = latest.sections.find((x) => x.kind === 'RichText');
  const mermaid = 'flowchart LR\n A[Sign up] --> B{Email verified?}\n B -->|yes| C[Welcome tour]\n B -->|no| D[Send reminder]\n D --> B';
  const body = JSON.parse(rich('New users meet the marsupial mascot during sign-up.'));
  body.content.push({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: mermaid }] });
  await s.api(`/documents/${id}/sections`, 'PUT', { revision: latest.revision, sections: [{ key: first.key, content: JSON.stringify(body) }] });
  await reader(s, doc);
  await s.page.locator('.doc-diagram svg').waitFor({ timeout: 15000 });
  await s.page.locator('.doc-diagram svg').getByText('Welcome tour', { exact: true }).waitFor();
  await inspector(s, 'Sharing & access');
  const download = s.page.waitForEvent('download', { timeout: 60000 });
  await s.page.getByTestId('doc-inspector').getByRole('button', { name: 'Export PDF', exact: true }).click();
  const file = await download, bytes = await fs.readFile(await file.path()), raw = bytes.toString('latin1');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.ok(file.suggestedFilename().endsWith('.pdf'));
  assert.ok(raw.includes('marsupial mascot') && raw.includes('(CONTENTS)') && /Page \d+ of \d+/.test(raw));
  assert.ok(raw.includes('Welcome tour') && raw.includes('Email verified?'), 'The PDF includes its diagram');
  const hit = await waitFor(async () => { const r = await s.api('/documents/search?q=marsupial'); return JSON.stringify(r.hits).includes(id); }, 'Full-text search finds section text'); assert.ok(hit);
  assert.ok(!JSON.stringify((await s.api('/documents/search?q=zzzqqq-nothing-ever')).hits).includes(id));
  const list = await s.api('/documents'), dashboard = await s.api('/documents/dashboard');
  assert.equal(dashboard.total, list.total);
  console.log('PASS diagram render, PDF bytes/contents/page numbers/diagram, full-text search and overview counts');
}

export async function runDocumentsJourney(kind) {
  const s = await start();
  try { await business(s); await ({ core, api: apiReference, review, secrets, pdf }[kind])(s); }
  finally { await s.finish(); }
}
