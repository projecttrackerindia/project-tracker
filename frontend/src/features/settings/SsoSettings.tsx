import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { ssoApi, teamApi } from '../../api/endpoints';
import type { Role, SsoProtocol, SsoSettings as Settings } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Badge, ErrorState, Field, Modal, PageHead, PageLoader } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

export async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { toast('Could not copy. Select the text and copy it by hand.', 'warning'); }
}

/** A label and a value with a copy button (addresses, records, secrets to paste elsewhere). */
export function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="copy-row">
      <div className="copy-label">{label}{hint && <span className="muted"> · {hint}</span>}</div>
      <div className="copy-value"><code title={value}>{value}</code>
        <button type="button" className="btn-icon" title="Copy" aria-label={`Copy ${label}`} onClick={() => void copy(value, label)}><Icon name="copy" size={15} /></button>
      </div>
    </div>
  );
}

/**
 * Workspace settings → Single sign-on: prove the company's email domains, connect its identity provider (OpenID Connect or SAML 2.0),
 * decide whether passwords are still allowed, and hand the provider a SCIM token so it can add and remove people by itself.
 */
export function SsoSettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['sso'], ssoApi.get);
  const set = (d: Settings) => queryClient.setQueryData([wid, 'sso'], d);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const verified = d.domains.filter((x) => x.verified).length;

  return (
    <>
      <PageHead title="Single sign-on" sub="People sign in with your company's identity provider, and it can add and remove them for you." />
      {!d.entitled && (
        <div className="form-warn" style={{ marginTop: 0 }}>
          <Icon name="lock" size={14} /> Single sign-on and SCIM provisioning are part of the Business plan. <Link className="link" to="/settings/billing">See plans</Link>
        </div>
      )}
      <div className="explainer" role="note">
        <Icon name="info" size={16} />
        <div>
          Set it up in three steps:
          <ol>
            <li><b>Verify your email domains.</b> Only people on them can sign in this way, so an identity provider can never speak for anyone else.</li>
            <li><b>Connect your identity provider</b> (Microsoft Entra ID, Okta, Google Workspace, OneLogin ...) with OpenID Connect or SAML 2.0.</li>
            <li><b>Optionally, turn on SCIM</b> so the provider adds people when they join and removes them when they leave.</li>
          </ol>
        </div>
      </div>

      <Domains settings={d} onChange={set} />
      <Connection settings={d} verified={verified} onChange={set} />
      <Scim settings={d} onChange={set} onCreated={() => void invalidateWorkspace(wid, 'sso')} />
      <GroupMappings entitled={d.entitled} />
    </>
  );
}

function Domains({ settings: d, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<Settings>, ok?: string) => {
    setBusy(key);
    try { onChange(await fn()); if (ok) toast(ok); } catch (e) { toast(errText(e, 'That did not work.'), 'error'); } finally { setBusy(null); }
  };
  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>1. Verified domains</h3><p>Prove each domain with a DNS TXT record. Single sign-on and provisioning only act on these.</p></div></div>
      <div className="card-body">
        <form className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }} onSubmit={(e) => { e.preventDefault(); if (domain.trim()) void run('add', () => ssoApi.addDomain(domain.trim()), 'Domain added. Publish the TXT record, then check it.').then(() => setDomain('')); }}>
          <input className="input" style={{ maxWidth: 300 }} placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain" disabled={!d.entitled} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!d.entitled || !domain.trim() || busy === 'add'}><Icon name="plus" /> Add domain</button>
        </form>
        {d.domains.length === 0 ? <p className="muted">No domains yet. Add the domain of your company's email addresses.</p> : (
          <div className="sso-domains">
            {d.domains.map((x) => (
              <div className="sso-domain" key={x.id}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                  <div className="row" style={{ gap: 8 }}><b>{x.domain}</b>{x.verified ? <Badge tone="success">Verified {formatDate(x.verifiedAt)}</Badge> : <Badge tone="warning">Waiting for DNS</Badge>}</div>
                  <div className="row" style={{ gap: 6 }}>
                    {!x.verified && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === x.id} onClick={() => void run(x.id, () => ssoApi.verifyDomain(x.id), `${x.domain} is verified.`)}>{busy === x.id ? <span className="spinner" /> : <Icon name="refresh" size={14} />} Check now</button>}
                    <button type="button" className="btn-icon danger" title="Remove" aria-label={`Remove ${x.domain}`} onClick={async () => {
                      if (await confirmDialog({ title: `Remove ${x.domain}?`, message: 'People on this domain can no longer use single sign-on or be provisioned. If it was the last verified domain, single sign-on is switched off.', confirmText: 'Remove' }))
                        void run(x.id, () => ssoApi.removeDomain(x.id), 'Domain removed.');
                    }}><Icon name="trash" /></button>
                  </div>
                </div>
                {!x.verified && (
                  <div className="sso-txt">
                    <p className="sso-note" style={{ margin: '8px 0' }}>Add this record at your DNS provider, then press <b>Check now</b>. DNS changes can take a few minutes to appear.{x.lastCheckedAt && <> Last checked {timeAgo(x.lastCheckedAt)}.</>}</p>
                    <CopyRow label="Type" value="TXT" />
                    <CopyRow label="Name / host" value={x.txtName} hint="or @" />
                    <CopyRow label="Value" value={x.txtValue} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const ROLES: Role[] = ['Member', 'Manager', 'Admin', 'Guest'];

function Connection({ settings: d, verified, onChange }: { settings: Settings; verified: number; onChange: (s: Settings) => void }) {
  const c = d.connection;
  const [protocol, setProtocol] = useState<SsoProtocol>(c?.protocol ?? 'Oidc');
  const [name, setName] = useState(c?.name ?? 'Company SSO');
  const [authority, setAuthority] = useState(c?.authority ?? '');
  const [clientId, setClientId] = useState(c?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [entityId, setEntityId] = useState(c?.samlEntityId ?? '');
  const [ssoUrl, setSsoUrl] = useState(c?.samlSsoUrl ?? '');
  const [certificate, setCertificate] = useState('');
  const [enabled, setEnabled] = useState(c?.enabled ?? false);
  const [enforce, setEnforce] = useState(c?.enforceForDomains ?? false);
  const [autoProvision, setAutoProvision] = useState(c?.autoProvision ?? true);
  const [role, setRole] = useState<Role>(c?.defaultRole ?? 'Member');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => { if (!enabled) setEnforce(false); }, [enabled]);
  const sp = d.serviceProvider;

  const save = async () => {
    setBusy(true); setErrors({}); setCheck(null);
    try {
      onChange(await ssoApi.save({
        protocol, name, enabled, enforceForDomains: enforce, autoProvision, defaultRole: role,
        authority, clientId, clientSecret: clientSecret || null, samlEntityId: entityId, samlSsoUrl: ssoUrl, samlCertificate: certificate || null,
      }));
      setClientSecret(''); setCertificate('');
      toast(enabled ? 'Single sign-on is on.' : 'Settings saved.');
    } catch (e) {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'form'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { form: errText(e, 'Could not save.') });
    } finally { setBusy(false); }
  };
  const test = async () => {
    try { setCheck(await ssoApi.check()); } catch (e) { setCheck({ ok: false, message: errText(e, 'Could not check the settings.') }); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>2. Identity provider</h3><p>{c?.lastUsedAt ? `Last sign-in through it ${timeAgo(c.lastUsedAt)}.` : 'Connect it once; people then use "Sign in with SSO".'}</p></div>
        {c && <Badge tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? 'On' : 'Off'}</Badge>}
      </div>
      <form className="card-body" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {errors.form && <div className="form-error" role="alert">{errors.form}</div>}
        <div className="seg mb-18" role="group" aria-label="Protocol">
          {([['Oidc', 'OpenID Connect'], ['Saml', 'SAML 2.0']] as const).map(([id, label]) => (
            <button key={id} type="button" className={protocol === id ? 'active' : ''} aria-pressed={protocol === id} onClick={() => setProtocol(id)}>{label}</button>
          ))}
        </div>

        <div className="sso-provider-values">
          <div className="sso-note" style={{ marginBottom: 6 }}>Give your identity provider these values when you create the application:</div>
          {protocol === 'Oidc'
            ? <CopyRow label="Redirect (sign-in) URI" value={sp.oidcRedirectUri} />
            : <><CopyRow label="Entity ID (audience)" value={sp.samlEntityId} /><CopyRow label="Reply / ACS URL" value={sp.samlAcsUrl} /><CopyRow label="Metadata URL" value={sp.samlMetadataUrl} /></>}
        </div>

        <div className="form-grid" style={{ marginTop: 14 }}>
          <Field label="Button name" hint={'Shown as "Continue with …" on the sign-in page.'}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <div />
          {protocol === 'Oidc' ? <>
            <Field label="Issuer (authority)" required full error={errors.authority} hint="e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 or https://acme.okta.com">
              <input className="input" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="https://" />
            </Field>
            <Field label="Client ID" required error={errors.clientId}><input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} /></Field>
            <Field label="Client secret" required={!c?.hasClientSecret} error={errors.clientSecret} hint={c?.hasClientSecret ? 'Saved. Leave empty to keep it.' : undefined}>
              <input className="input" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={c?.hasClientSecret ? '•••••••• saved' : ''} />
            </Field>
          </> : <>
            <Field label="Identity provider entity ID (issuer)" required error={errors.samlEntityId}><input className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} /></Field>
            <Field label="Sign-in URL (SSO URL)" required error={errors.samlSsoUrl}><input className="input" value={ssoUrl} onChange={(e) => setSsoUrl(e.target.value)} placeholder="https://" /></Field>
            <Field label="Signing certificate" required={!c?.hasSamlCertificate} full error={errors.samlCertificate}
              hint={c?.hasSamlCertificate ? `Saved: ${c.certificateSubject ?? 'certificate'}${c.certificateExpiresAt ? `, valid until ${formatDate(c.certificateExpiresAt)}` : ''}. Paste a new one to replace it.` : 'Paste the PEM text (-----BEGIN CERTIFICATE-----) or the base64 value.'}>
              <textarea className="textarea" rows={4} value={certificate} onChange={(e) => setCertificate(e.target.value)} spellCheck={false} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }} />
            </Field>
          </>}
        </div>

        <div className="sso-switches">
          <div className="setting-row">
            <div className="setting-info"><h4>Single sign-on is on</h4><p>{verified === 0 ? 'Verify a domain first.' : 'People on your verified domains can use "Sign in with SSO".'}</p></div>
            <button type="button" className={`switch ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label="Single sign-on on" disabled={verified === 0} onClick={() => setEnabled((v) => !v)} />
          </div>
          <div className="setting-row">
            <div className="setting-info"><h4>Require single sign-on</h4><p>Passwords, Google and other sign-ins stop working for addresses on your domains. Owners keep their password as a way back in.</p></div>
            <button type="button" className={`switch ${enforce ? 'on' : ''}`} role="switch" aria-checked={enforce} aria-label="Require single sign-on" disabled={!enabled} onClick={() => setEnforce((v) => !v)} />
          </div>
          <div className="setting-row">
            <div className="setting-info"><h4>Add people on their first sign-in</h4><p>Someone new on your domains gets an account and joins this organization automatically.</p></div>
            <div className="row" style={{ gap: 10 }}>
              {autoProvision && <Select className="select" style={{ width: 130 }} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Access level for new people">{ROLES.map((r) => <option key={r}>{r}</option>)}</Select>}
              <button type="button" className={`switch ${autoProvision ? 'on' : ''}`} role="switch" aria-checked={autoProvision} aria-label="Add people on first sign-in" onClick={() => setAutoProvision((v) => !v)} />
            </div>
          </div>
        </div>

        {check && <div className={check.ok ? 'notice' : 'form-error'} role="status" style={{ marginTop: 12 }}>{check.message}</div>}
        <div className="row" style={{ gap: 8, marginTop: 16 }}>
          <button type="submit" className="btn btn-primary" disabled={busy || !d.entitled}>{busy && <span className="spinner" />}Save</button>
          {c && <button type="button" className="btn btn-ghost" onClick={() => void test()}><Icon name="checkCircle" /> Test the settings</button>}
        </div>
      </form>
    </div>
  );
}

function Scim({ settings: d, onChange, onCreated }: { settings: Settings; onChange: (s: Settings) => void; onCreated: () => void }) {
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [name, setName] = useState('Identity provider');
  const create = async () => {
    try { const r = await ssoApi.createScimToken(name); setSecret(r.secret); setCreating(false); onCreated(); }
    catch (e) { toast(errText(e, 'Could not create the token.'), 'error'); }
  };
  const active = d.scimTokens.filter((t) => !t.revoked);
  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>3. Automatic provisioning (SCIM 2.0)</h3><p>Your identity provider adds people, updates their names, removes them when they leave, and keeps teams in step.</p></div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!d.entitled} onClick={() => setCreating(true)}><Icon name="plus" /> New token</button>
      </div>
      <div className="card-body">
        <CopyRow label="SCIM base URL (tenant URL)" value={d.serviceProvider.scimBaseUrl} />
        <p className="sso-note" style={{ margin: '10px 0' }}>Deactivating someone in the provider removes them from this organization; their account and other workspaces are untouched. Only addresses on verified domains can be provisioned.</p>
        {active.length === 0 ? <p className="muted">No tokens yet.</p> : (
          <div className="member-list">
            {active.map((t) => (
              <div className="member-item" key={t.id}>
                <Icon name="key" />
                <div className="member-main"><div className="member-name">{t.name} <code style={{ fontSize: 11.5 }}>{t.prefix}…</code></div><div className="member-role">Created {formatDate(t.createdAt)} · {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : 'not used yet'}</div></div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={async () => {
                  if (await confirmDialog({ title: 'Revoke this token?', message: 'Provisioning with it stops at once.', confirmText: 'Revoke' })) {
                    try { onChange(await ssoApi.revokeScimToken(t.id)); toast('Token revoked.', 'warning'); } catch (e) { toast(errText(e, 'Could not revoke.'), 'error'); }
                  }
                }}>Revoke</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && (
        <Modal size="sm" title="New SCIM token" onClose={() => setCreating(false)} onSubmit={(e) => { e.preventDefault(); void create(); }}
          footer={<><button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="btn btn-primary">Create token</button></>}>
          <Field label="Name" hint="Which provider uses it, e.g. Microsoft Entra ID."><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
        </Modal>
      )}
      {secret && (
        <Modal size="sm" title="Copy the token now" onClose={() => setSecret(null)}
          footer={<><button type="button" className="btn btn-ghost" onClick={() => void copy(secret, 'Token')}><Icon name="copy" /> Copy</button><button type="button" className="btn btn-primary" onClick={() => setSecret(null)}>Done</button></>}>
          <div className="form-warn" style={{ marginTop: 0 }}><Icon name="alert" size={14} /> It is shown only once. Paste it into your identity provider as the secret token (bearer token).</div>
          <code className="secret-box">{secret}</code>
        </Modal>
      )}
    </div>
  );
}

/** Directory groups to teams: at sign-in a person joins the team of each group their provider reports and leaves the ones they no longer have. Teams are what documents are shared with. */
function GroupMappings({ entitled }: { entitled: boolean }) {
  const wid = useWorkspaceId();
  const maps = useWsQuery(['sso', 'group-mappings'], ssoApi.groupMappings);
  const teams = useWsQuery(['teams'], teamApi.list);
  const [group, setGroup] = useState('');
  const [team, setTeam] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => invalidateWorkspace(wid, 'sso');
  const add = async () => {
    setBusy(true);
    try { await ssoApi.addGroupMapping(group.trim(), team); setGroup(''); refresh(); toast('Mapping added.'); } catch (e) { toast(errText(e, 'Could not add it.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>4. Groups to teams</h3><p>Map a group from your identity provider to a team. People join the team when they sign in with that group and leave it when they no longer have it (teams added by hand are never removed). Share documents with the team to give the group access.</p></div></div>
      <div className="card-body">
        {(maps.data?.items ?? []).length === 0 ? <p className="muted">No mappings yet.</p> : (
          <ul className="doc-files">
            {maps.data!.items.map((m) => (
              <li key={m.id}><code>{m.group}</code><Icon name="arrowRight" size={14} /><b>{m.teamName}</b>
                <button className="btn-icon danger" aria-label={`Remove ${m.group}`} onClick={async () => { try { await ssoApi.removeGroupMapping(m.id); refresh(); } catch (e) { toast(errText(e, 'Could not remove it.'), 'error'); } }}><Icon name="close" size={14} /></button></li>
            ))}
          </ul>
        )}
        <div className="form-row" style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <Field label="Group name or id (as your provider sends it)"><input className="input" value={group} maxLength={200} onChange={(e) => setGroup(e.target.value)} placeholder="engineering" disabled={!entitled} /></Field>
          <Field label="Team"><Select value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Choose a team</option>{(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <button className="btn btn-primary" disabled={!entitled || busy || !group.trim() || !team} onClick={add}>{busy && <span className="spinner" />}Add</button>
        </div>
        {!entitled && <p className="muted" style={{ marginTop: 8 }}>Part of the Business plan.</p>}
      </div>
    </div>
  );
}
