import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, download, uploadFile } from '../../api/client';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { StudioHero } from '../../components/StudioHero';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog } from '../../stores/ui';
import { payForResume } from '../../lib/razorpay';
import { ResumeDocument, TemplateThumbnail, type ResumeDesign } from './ResumeDocument';
import './resumeBuilder.css';

type Section = { heading: string; text: string };
type Content = { name: string; headline: string; contact: string; summary: string; sections: Section[] };
type Evidence = { tenantId: string; workId: string; version: number; title: string; outcome: string };
type Version = { id: string; number: number; content: Content; evidence: Evidence[]; approvedAt: string | null; createdAt: string; hasOriginal: boolean; originalFormat?: string };
type Resume = { id: string; title: string; version: number; versions: Version[]; history?: { number: number; approvedAt: string | null; createdAt: string }[] };
type Purchase = { purchaseId: string; keyId: string; orderId: string; baseMinor: number; taxMinor: number; totalMinor: number; currency: string; status: string; format: string };
type Options = { catalog?: ResumeDesign[]; templates: ResumeDesign[]; templateLimit: number; aiAvailable: boolean; aiCredits: number; cleanCheckoutEnabled: boolean; cleanPricePaise: number; cleanTaxPaise: number; taxLabel: string };
type View = 'split' | 'edit' | 'preview';

const path = '/me/resumes';
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const formatName = (f: 'pdf' | 'docx') => (f === 'pdf' ? 'PDF' : 'Word');

export function ResumeBuilderSection() {
  const user = useAuth(s => s.ctx?.user.id); const workspace = useWorkspaceId();
  return <ResumeStudio key={`${user}:${workspace}`} />;
}

function ResumeStudio() {
  const user = useAuth(s => s.ctx?.user); const wid = useWorkspaceId(); const qc = useQueryClient();
  const rows = useQuery({ queryKey: ['personal-resumes', user?.id], queryFn: () => api<Resume[]>('GET', path) });
  const options = useQuery({ queryKey: ['resume-options', wid, user?.id], queryFn: () => api<Options>('GET', `${path}/options`) });
  const evidence = useQuery({ queryKey: ['resume-evidence', wid, user?.id], queryFn: () => api<Evidence[]>('GET', `${path}/evidence`) });
  const purchases = useQuery({ queryKey: ['resume-purchases', user?.id], queryFn: () => api<Purchase[]>('GET', '/me/resume-purchases') });
  const empty = (): Content => ({ name: user?.displayName ?? '', headline: '', contact: '', summary: '', sections: [{ heading: 'Experience', text: '' }, { heading: 'Education', text: '' }, { heading: 'Skills', text: '' }] });

  const [current, setCurrent] = useState<Resume | null>(null);
  const [number, setNumber] = useState<number | null>(null);
  const [content, setContent] = useState<Content>(empty);
  const [title, setTitle] = useState('My resume');
  const [view, setView] = useState<View>('split');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [template, setTemplate] = useState(1);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [message, setMessage] = useState('');

  const selected = current?.id ?? null;
  const saved = current?.versions.find(v => v.number === number);
  const dirty = !saved || title !== current?.title || JSON.stringify(content) !== JSON.stringify(saved.content)
    || JSON.stringify(sourceIds.slice().sort()) !== JSON.stringify(saved.evidence.map(e => e.workId).sort());
  const hasWriting = !!selected || !!content.summary || content.sections.some(s => s.text);
  const allowed = options.data?.templates ?? [];
  const catalog = options.data?.catalog ?? allowed;
  const design = allowed.find(t => t.id === template) ?? allowed[0];

  useEffect(() => { if (options.data && !options.data.templates.some(t => t.id === template)) setTemplate(options.data.templates[0].id); }, [options.data, template]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty && hasWriting) e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, hasWriting]);

  function load(r: Resume, v = r.versions[0]) { setCurrent(r); setNumber(v.number); setTitle(r.title); setContent(v.content); setSourceIds(v.evidence.map(e => e.workId)); setMessage(''); setError(null); }
  function reset() { setCurrent(null); setNumber(null); setContent(empty()); setTitle('My resume'); setSourceIds([]); setMessage(''); }
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError(null); setMessage('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'This could not be done. Try again.'); } finally { setBusy(false); }
  }
  const discardOk = async (title = 'Discard unsaved edits?', confirmText = 'Discard edits') =>
    !(dirty && hasWriting) || await confirmDialog({ title, message: 'Save a version first to keep them.', confirmText });
  async function open(id?: string, chosen?: number) {
    if (!await discardOk()) return;
    if (!id) { reset(); return; }
    await act(async () => { load(await api<Resume>('GET', `${path}/${id}${chosen ? `?number=${chosen}` : ''}`)); });
  }
  const refresh = () => qc.invalidateQueries({ queryKey: ['personal-resumes'] });
  const reload = async (id: string, n?: number) => load(await api<Resume>('GET', `${path}/${id}${n ? `?number=${n}` : ''}`));

  const save = () => act(async () => {
    const r = await api<Resume>(selected ? 'PUT' : 'POST', selected ? `${path}/${selected}` : path, { title, content, expectedVersion: current?.version ?? 0, evidenceIds: sourceIds });
    await refresh(); await reload(r.id); setMessage('Saved. Check the preview, then approve this version to download it.');
  });
  const improve = () => act(async () => {
    if (!current) return;
    const r = await api<Resume>('POST', `${path}/${current.id}/improve`, { operationId: crypto.randomUUID(), targetRole: target, expectedVersion: current.version });
    await refresh(); await reload(r.id); setMessage('The suggestion is saved as a new version. Check every claim before you approve it.');
  });
  const approve = () => act(async () => {
    await api('POST', `${path}/${selected}/versions/${number}/approve`); await refresh(); await reload(selected!, number!);
    setMessage('Approved. You can download it now.');
  });
  const importFile = (file: File) => {
    if (file.size > 2 * 1024 * 1024) { setError('Choose a file under 2 MB.'); return; }
    void act(async () => {
      if (!await discardOk('Import another resume?', 'Import')) return;
      const r = await uploadFile<Resume>(`${path}/import`, file); await refresh(); await reload(r.id);
      setMessage('Imported. Sort the text into sections and check every detail.');
    });
  };
  const removeResume = () => act(async () => {
    if (!current || !await confirmDialog({ title: 'Delete this resume?', message: 'All its versions and any imported file are deleted.', confirmText: 'Delete resume', danger: true })) return;
    await api('DELETE', `${path}/${current.id}`); reset(); await refresh();
  });
  const removeOriginal = () => act(async () => {
    if (!await confirmDialog({ title: 'Delete the imported file?', message: 'Your resume and its versions stay. Only the file you imported is deleted.', confirmText: 'Delete file', danger: true })) return;
    await api('DELETE', `${path}/${selected}/versions/${number}/original`); await reload(selected!, number!);
  });
  const buyClean = (format: 'pdf' | 'docx') => act(async () => {
    const o = options.data!;
    if (!await confirmDialog({ title: `Buy a ${formatName(format)} without the mark?`, message: `For this version in the ${design?.name} design. Total ${rupees(o.cleanPricePaise + o.cleanTaxPaise)} including ${o.taxLabel || 'tax'}.`, confirmText: 'Continue to payment' })) return;
    const order = await api<Purchase>('POST', '/me/resume-purchases', { resumeId: selected, number, templateId: template, format });
    await qc.invalidateQueries({ queryKey: ['resume-purchases'] });
    if (order.status !== 'paid') {
      const proof = await payForResume(order, { name: user?.displayName ?? '', email: user?.email ?? '' });
      await api('POST', `/me/resume-purchases/${order.purchaseId}/verify`, proof); await qc.invalidateQueries({ queryKey: ['resume-purchases'] });
    }
    await download(`/me/resume-purchases/${order.purchaseId}/download`, `resume-clean-v${number}.${format}`);
  });

  const field = (key: keyof Omit<Content, 'sections'>, label: string, multi = false, max = 200) =>
    <label className="resume-field">{label}{multi
      ? <textarea value={content[key]} maxLength={max} rows={5} onChange={e => setContent({ ...content, [key]: e.target.value })} />
      : <input value={content[key]} maxLength={max} onChange={e => setContent({ ...content, [key]: e.target.value })} />}</label>;
  const setSection = (i: number, patch: Partial<Section>) => setContent({ ...content, sections: content.sections.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  if (rows.isPending || options.isPending) return <PageLoader />;
  if (rows.error || options.error) return <div role="alert" className="resume-message error">{(rows.error ?? options.error)?.message}<button className="btn" onClick={() => { void rows.refetch(); void options.refetch(); }}>Retry</button></div>;

  const status = dirty ? 'Unsaved edits' : saved?.approvedAt ? 'Approved' : 'Not approved yet';
  const canDownload = !busy && !dirty && !!saved?.approvedAt;
  const o = options.data!;

  return <div className="resume-builder">
    <StudioHero title="Resume studio" description="Private to you. Write it, pick a design, approve a version, then download it as PDF or Word.">
      <label className="btn resume-upload"><Icon name="upload" size={16} /> Import PDF or Word
        <input type="file" accept=".pdf,.docx" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importFile(f); }} />
      </label>
      <button className="btn" disabled={busy} onClick={() => void open()}><Icon name="plus" size={16} /> New resume</button>
    </StudioHero>

    <div className="resume-bar">
      <div className="resume-bar-docs">
        {!!rows.data?.length && <select aria-label="Open resume" value={selected ?? ''} disabled={busy} onChange={e => void open(e.target.value || undefined)}>
          {!selected && <option value="">New resume (not saved)</option>}
          {rows.data.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>}
        {current && <select aria-label="Saved resume version" value={number ?? ''} disabled={busy} onChange={e => void open(current.id, Number(e.target.value))}>
          {(current.history ?? current.versions).map(v => <option key={v.number} value={v.number}>Version {v.number}{v.approvedAt ? ', approved' : ''}</option>)}
        </select>}
        <span className={`resume-status ${dirty ? 'dirty' : saved?.approvedAt ? 'ok' : ''}`} role="status">{status}</span>
        {current && <details className="resume-more">
          <summary className="btn btn-sm" aria-label="More resume actions"><Icon name="more" size={16} /></summary>
          <div role="menu">
            {saved?.hasOriginal && <>
              <button role="menuitem" type="button" disabled={busy} onClick={() => void act(async () => { await download(`${path}/${selected}/versions/${number}/original`, 'original-resume.' + saved.originalFormat); })}>Download the imported file</button>
              <button role="menuitem" type="button" disabled={busy} onClick={() => void removeOriginal()}>Delete the imported file</button>
            </>}
            <button role="menuitem" type="button" className="danger" disabled={busy} onClick={() => void removeResume()}>Delete resume</button>
          </div>
        </details>}
      </div>
      <div className="resume-view-switch" role="group" aria-label="Resume workspace view">
        {([['edit', 'Edit'], ['preview', 'Preview'], ['split', 'Both']] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save version'}</button>
    </div>

    {error && <div role="alert" className="resume-message error">{error}</div>}
    {message && <div role="status" className="resume-message">{message}</div>}

    <div className="resume-layout" data-view={view}>
      <div className="resume-editor">
        <label className="resume-field">Resume title<input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
        <div className="resume-field-pair">{field('name', 'Full name', false, 150)}{field('headline', 'Professional headline')}</div>
        {field('contact', 'Contact details', false, 600)}
        {field('summary', 'Profile summary', true, 4000)}
        {content.sections.map((s, i) => <details className="resume-section-editor" key={i} open={i === 0}>
          <summary><span>{s.heading || 'Untitled section'}</span></summary>
          <label className="resume-field">Heading<input value={s.heading} maxLength={100} onChange={e => setSection(i, { heading: e.target.value })} /></label>
          <label className="resume-field">Content<textarea rows={8} value={s.text} maxLength={6000} onChange={e => setSection(i, { text: e.target.value })} /></label>
          <button type="button" className="btn btn-sm" onClick={() => setContent({ ...content, sections: content.sections.filter((_, j) => j !== i) })}>Remove section</button>
        </details>)}
        <button type="button" className="btn resume-add" disabled={content.sections.length >= 12} onClick={() => setContent({ ...content, sections: [...content.sections, { heading: 'New section', text: '' }] })}><Icon name="plus" size={16} /> Add section</button>

        <details className="resume-extra">
          <summary>Verified work outcomes<small>{sourceIds.length ? `${sourceIds.length} selected` : 'Optional'}</small></summary>
          <p>Finished work that someone else accepted. Pick the ones you may use, then mention them in your text or let AI suggest wording.</p>
          {evidence.error && <p role="alert">{evidence.error.message}</p>}
          {evidence.data && !evidence.data.length && <p>None in this workspace yet.</p>}
          {evidence.data?.map(e => <label key={e.workId} className="resume-check"><input type="checkbox" checked={sourceIds.includes(e.workId)} onChange={x => setSourceIds(x.target.checked ? [...sourceIds, e.workId] : sourceIds.filter(id => id !== e.workId))} /><span><b>{e.title}</b><small>{e.outcome}</small></span></label>)}
        </details>

        <details className="resume-extra">
          <summary>Improve the wording with AI<small>{o.aiAvailable ? `${o.aiCredits} credit${o.aiCredits === 1 ? '' : 's'}` : 'Not available'}</small></summary>
          {o.aiAvailable ? <>
            <label className="resume-field">Role you are aiming for (optional)<input value={target} maxLength={200} onChange={e => setTarget(e.target.value)} placeholder="Senior project manager" /></label>
            <p>Uses the saved version and saves the suggestion as a new one. AI does not check qualifications or achievements, so review it before you approve.</p>
            <button type="button" className="btn" disabled={busy || dirty || !current || number !== current.version} onClick={() => void improve()}><Icon name="sparkle" size={16} /> Suggest clearer wording</button>
            {(dirty || !current) && <small className="resume-hint">Save your edits first.</small>}
          </> : <p>AI is switched off in this workspace. Everything else works as usual.</p>}
        </details>
      </div>

      <aside className="resume-preview-panel" aria-label="Resume preview">
        <DesignPicker catalog={catalog} allowed={allowed} value={design?.id ?? template} onPick={setTemplate} />
        <div className="resume-document-frame"><ResumeDocument content={content} design={design} /></div>
        <div className="resume-finish">
          {saved && !saved.approvedAt && <button className="btn btn-primary" disabled={busy || dirty} onClick={() => void approve()}>Approve this version</button>}
          {(['pdf', 'docx'] as const).map(f => <button key={f} className="btn" disabled={!canDownload} onClick={() => void act(async () => { await download(`${path}/${selected}/versions/${number}/export?template=${template}&format=${f}`, `resume-v${number}.${f}`); })}><Icon name="download" size={16} />{formatName(f)}</button>)}
        </div>
        <p className="resume-hint">{!saved ? 'Save a version, approve it, then download it.' : dirty ? 'Save your edits to download them.' : !saved.approvedAt ? 'Approve this version to download it.' : 'Free downloads carry a small Project Tracker mark.'}</p>
        {(o.cleanCheckoutEnabled || !!purchases.data?.length) && <details className="resume-extra">
          <summary>Without the mark<small>{o.cleanCheckoutEnabled ? rupees(o.cleanPricePaise + o.cleanTaxPaise) : `${purchases.data?.length} bought`}</small></summary>
          {o.cleanCheckoutEnabled && <>
            <p>{rupees(o.cleanPricePaise)} plus {rupees(o.cleanTaxPaise)} {o.taxLabel} for one version, design and format. Download it again any time for free.</p>
            <div className="resume-finish">{(['pdf', 'docx'] as const).map(f => <button key={f} className="btn" disabled={!canDownload} onClick={() => void buyClean(f)}>Buy {formatName(f)}</button>)}</div>
          </>}
          {purchases.data?.map(p => <div key={p.purchaseId} className="resume-purchase">
            <span>{p.format === 'pdf' ? 'PDF' : 'Word'}, {rupees(p.totalMinor)}, {p.status}<small>Reference {p.purchaseId.slice(0, 8)}</small></span>
            {p.status === 'paid' && <button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { await download(`/me/resume-purchases/${p.purchaseId}/download`, 'resume-clean.' + p.format); })}>Download</button>}
            {p.status === 'pending' && <button className="btn btn-sm" disabled={busy} onClick={() => void act(async () => { const r = await api<Purchase>('POST', `/me/resume-purchases/${p.purchaseId}/recover`); await qc.invalidateQueries({ queryKey: ['resume-purchases'] }); setMessage(r.status === 'paid' ? 'Payment confirmed. Your file is ready.' : 'No payment yet. Finish the checkout you started rather than buying again.'); })}>Check payment</button>}
          </div>)}
        </details>}
      </aside>
    </div>

    <CertificationsPanel />
  </div>;
}

/** All designs in one place: the ones in the plan can be picked, the rest are shown with a lock. */
function DesignPicker({ catalog, allowed, value, onPick }: { catalog: ResumeDesign[]; allowed: ResumeDesign[]; value: number; onPick: (id: number) => void }) {
  const ok = new Set(allowed.map(t => t.id));
  const chosen = catalog.find(t => t.id === value);
  return <div className="resume-designs">
    <div className="resume-designs-head"><b>{chosen?.name ?? 'Design'}</b><span>{chosen?.description}</span></div>
    <div className="resume-design-grid" role="group" aria-label="Choose resume design">
      {catalog.map(t => {
        const open = ok.has(t.id);
        return <button key={t.id} type="button" className="resume-design" aria-pressed={value === t.id} aria-disabled={!open}
          aria-label={open ? t.name : `${t.name}, not in your plan`} title={open ? `${t.name}: ${t.description}` : `${t.name} is in plans with more designs`}
          onClick={() => { if (open) onPick(t.id); }}>
          <TemplateThumbnail design={t} />
          {!open && <Icon name="lock" size={12} />}
        </button>;
      })}
    </div>
    {ok.size < catalog.length && <p className="resume-hint">{ok.size} of {catalog.length} designs are in your plan. <Link to="/settings/billing">See plans</Link></p>}
  </div>;
}

type Certification = { id: string; name: string; issuer: string; issuedOn: string; expiresOn: string | null; credentialId: string | null; verificationUrl: string | null; showBadge: boolean; archived: boolean; version: number; verificationStatus: string; expiryReminders: boolean; hasAttachment: boolean; attachmentFormat: string | null };

function CertificationsPanel() {
  const user = useAuth(s => s.ctx?.user.id); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['personal-certifications', user], queryFn: () => api<Certification[]>('GET', '/me/certifications') });
  const blank = { name: '', issuer: '', issuedOn: '', expiresOn: '', credentialId: '', verificationUrl: '' };
  const [form, setForm] = useState(blank); const [editing, setEditing] = useState<Certification | null>(null); const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['personal-certifications'] }); await qc.invalidateQueries({ queryKey: ['member-profile'] }); }
    catch (e) { setError(e instanceof Error ? e.message : 'The certification could not be saved.'); } finally { setBusy(false); }
  }
  const close = () => { setEditing(null); setAdding(false); setForm(blank); };
  function edit(c: Certification) { setEditing(c); setAdding(true); setForm({ name: c.name, issuer: c.issuer, issuedOn: c.issuedOn, expiresOn: c.expiresOn ?? '', credentialId: c.credentialId ?? '', verificationUrl: c.verificationUrl ?? '' }); }
  const put = (c: Certification, patch: Partial<Certification>) => run(async () => { await api('PUT', `/me/certifications/${c.id}`, { ...c, ...patch }); });
  const field = (key: keyof typeof blank, label: string, type = 'text', required = false, max = 200) =>
    <label className="resume-field">{label}<input type={type} required={required} value={form[key]} maxLength={max} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>;
  const count = q.data?.length ?? 0;

  return <details className="resume-certifications" open={count > 0 || undefined}>
    <summary><span>Certifications</span><small>{count ? `${count}` : 'None yet'}</small></summary>
    <p className="resume-hint">Private unless you share a badge on your profile card. Entries are your own; a file or link does not verify them.</p>
    {(error || q.error) && <p role="alert" className="resume-message error">{error ?? q.error?.message}</p>}
    {q.isPending && <p className="resume-hint">Loading…</p>}
    <ul>{q.data?.map(c => <li key={c.id}>
      <div><b>{c.name}</b><span>{c.issuer}{c.archived ? ', archived' : ''}{c.showBadge ? ', on your profile' : ''}</span>{c.expiresOn && <small>Expires {c.expiresOn}</small>}{c.verificationUrl && <a href={c.verificationUrl} target="_blank" rel="noopener noreferrer">Issuer's page</a>}</div>
      <button className="btn btn-sm" disabled={busy} onClick={() => edit(c)}>Edit</button>
      <details className="resume-more">
        <summary className="btn btn-sm" aria-label={`More for ${c.name}`}><Icon name="more" size={16} /></summary>
        <div role="menu">
          <label role="menuitem" className="resume-upload">{c.hasAttachment ? 'Replace the certificate file' : 'Attach the certificate file'}<input type="file" disabled={busy} accept=".pdf,.png,.jpg,.jpeg" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; void run(async () => { if (file.size > 2 * 1024 * 1024) throw new Error('Choose a file under 2 MB.'); await uploadFile(`/me/certifications/${c.id}/attachment?version=${c.version}`, file); }); }} /></label>
          {c.hasAttachment && <>
            <button role="menuitem" type="button" disabled={busy} onClick={() => void run(async () => { await download(`/me/certifications/${c.id}/attachment`, 'certificate.' + c.attachmentFormat); })}>Download the file</button>
            <button role="menuitem" type="button" disabled={busy} onClick={() => void run(async () => { if (await confirmDialog({ title: 'Remove the file?', message: 'The certificate file is deleted. The entry stays.', confirmText: 'Remove', danger: true })) await api('DELETE', `/me/certifications/${c.id}/attachment?version=${c.version}`); })}>Remove the file</button>
          </>}
          <button role="menuitem" type="button" disabled={busy} onClick={() => void run(async () => {
            if (!c.showBadge && !await confirmDialog({ title: 'Show this on your profile?', message: 'People in your workspaces see the name, issuer and expiry on your profile card. IDs, links and files stay private.', confirmText: 'Show badge' })) return;
            await api('PUT', `/me/certifications/${c.id}`, { ...c, showBadge: !c.showBadge });
          })}>{c.showBadge ? 'Hide from profile' : 'Show on profile'}</button>
          <button role="menuitem" type="button" disabled={busy} onClick={() => void put(c, { expiryReminders: !c.expiryReminders })}>{c.expiryReminders ? 'Stop expiry reminders' : 'Remind me before expiry'}</button>
          <button role="menuitem" type="button" disabled={busy} onClick={() => void put(c, { archived: !c.archived })}>{c.archived ? 'Restore' : 'Archive'}</button>
          <button role="menuitem" type="button" className="danger" disabled={busy} onClick={() => void run(async () => { if (await confirmDialog({ title: 'Delete this certification?', message: 'The entry and its file are deleted.', confirmText: 'Delete', danger: true })) await api('DELETE', `/me/certifications/${c.id}`); })}>Delete</button>
        </div>
      </details>
    </li>)}</ul>
    {adding ? <form className="resume-cert-form" onSubmit={e => { e.preventDefault(); void run(async () => {
      await api(editing ? 'PUT' : 'POST', editing ? `/me/certifications/${editing.id}` : '/me/certifications', { ...form, expiresOn: form.expiresOn || null, credentialId: form.credentialId || null, verificationUrl: form.verificationUrl || null, showBadge: editing?.showBadge ?? false, archived: editing?.archived ?? false, expiryReminders: editing?.expiryReminders ?? true, version: editing?.version ?? 0 });
      close();
    }); }}>
      <div className="resume-cert-grid">{field('name', 'Certification', 'text', true)}{field('issuer', 'Issuer', 'text', true)}{field('issuedOn', 'Issued on', 'date', true)}{field('expiresOn', 'Expires on', 'date')}{field('credentialId', 'Credential ID')}{field('verificationUrl', 'Verification link', 'url', false, 1000)}</div>
      <div className="resume-finish"><button className="btn btn-primary" disabled={busy}>{editing ? 'Save certification' : 'Add certification'}</button><button type="button" className="btn" onClick={close}>Cancel</button></div>
    </form> : <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Add certification</button>}
  </details>;
}
