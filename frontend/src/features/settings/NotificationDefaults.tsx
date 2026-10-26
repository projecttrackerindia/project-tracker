import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, PageHead, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { LastChanged, SectionHistory } from './SettingsCenter';
import { settingsApi, type ChannelSet, type NotificationDefaults } from './settingsApi';

type QuietMode = 'platform' | 'custom' | 'none';
interface Draft { kinds: Record<string, ChannelSet>; quiet: QuietMode; quietStart: string; quietEnd: string; digest: 'platform' | 'daily' | 'off'; digestTime: string }

const fromData = (d: NotificationDefaults): Draft => ({
  kinds: Object.fromEntries(d.kinds.map((k) => [k.type, { ...k.workspace }])),
  quiet: !d.quietCustom ? 'platform' : d.quietStart ? 'custom' : 'none',
  quietStart: d.quietStart ?? '21:00', quietEnd: d.quietEnd ?? '08:00',
  digest: !d.digestCustom ? 'platform' : d.digestTime ? 'daily' : 'off',
  digestTime: d.digestTime ?? '18:00',
});

const COLUMNS: { key: keyof ChannelSet; label: string }[] = [{ key: 'inApp', label: 'In the app' }, { key: 'email', label: 'E-mail' }, { key: 'browser', label: 'Desktop & phone' }];

/**
 * Workspace settings → Notifications → Defaults for members: channels for every kind of notification, quiet hours and the daily digest for
 * people who have not chosen their own. Their own choice always wins; security alerts always arrive.
 */
export function NotificationDefaultsSection() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['settings', 'notification-defaults'], settingsApi.notificationDefaults);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setDraft(fromData(q.data)); }, [q.data]);
  const saved = useMemo(() => (q.data ? JSON.stringify(fromData(q.data)) : ''), [q.data]);
  if (q.isLoading || (q.data && !draft)) return <PageLoader />;
  if (q.isError || !q.data || !draft) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const dirty = JSON.stringify(draft) !== saved;
  const setKind = (type: string, patch: Partial<ChannelSet>) => setDraft({ ...draft, kinds: { ...draft.kinds, [type]: { ...draft.kinds[type], ...patch } } });

  const save = async () => {
    if (draft.quiet === 'custom' && draft.quietStart === draft.quietEnd) { toast('Quiet hours need to end at a different time than they start.', 'error'); return; }
    setBusy(true);
    try {
      await settingsApi.saveNotificationDefaults({
        kinds: d.kinds.filter((k) => !k.locked).map((k) => ({ type: k.type, ...draft.kinds[k.type], browser: draft.kinds[k.type].browser && draft.kinds[k.type].inApp })),
        quietCustom: draft.quiet !== 'platform', quietStart: draft.quiet === 'custom' ? draft.quietStart : null, quietEnd: draft.quiet === 'custom' ? draft.quietEnd : null,
        digestCustom: draft.digest !== 'platform', digestTime: draft.digest === 'daily' ? draft.digestTime : null,
      });
      toast('Defaults saved. Members who have not chosen their own get them from now on.');
      void invalidateWorkspace(wid, 'settings');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the defaults.', 'error'); }
    finally { setBusy(false); }
  };

  const changedCount = d.kinds.filter((k) => !k.locked && COLUMNS.some((c) => draft.kinds[k.type][c.key] !== k.platform[c.key])).length;
  return (
    <>
      <PageHead title="Defaults for members" sub="What members get until they choose for themselves. A person's own choice always wins, and security alerts always arrive." />
      <div className="explainer" role="note">
        <Icon name="info" size={16} />
        <div>{d.members} member{d.members === 1 ? '' : 's'} in this workspace. These defaults reach everyone who has not changed that kind of notification in the
          Notification Center. Your own choices: <Link className="link" to="/settings/notifications">Settings › Notifications</Link>.</div>
      </div>

      <section className="card mb-22" data-setting="notifications.defaults">
        <div className="card-head"><div><h3>Channels</h3><p>{changedCount === 0 ? 'All kinds use the platform\'s channels.' : `${changedCount} kind${changedCount === 1 ? '' : 's'} differ from the platform.`}</p></div></div>
        <div className="card-body nd-wrap">
          <table className="nd-table">
            <thead><tr><th scope="col">Kind of notification</th>{COLUMNS.map((c) => <th scope="col" key={c.key}>{c.label}</th>)}<th scope="col">Uses this default</th></tr></thead>
            <tbody>
              {d.kinds.map((k) => {
                const v = draft.kinds[k.type];
                const differs = !k.locked && COLUMNS.some((c) => v[c.key] !== k.platform[c.key]);
                return (
                  <tr key={k.type} className={differs ? 'changed' : ''}>
                    <th scope="row"><b>{k.label}</b> {k.needsYou && <Badge tone="info">Needs you</Badge>} {differs && <Badge tone="warning">Changed</Badge>}<small>{k.description}</small></th>
                    {COLUMNS.map((c) => (
                      <td key={c.key}>
                        <input type="checkbox" aria-label={`${k.label}: ${c.label}`} disabled={k.locked || (c.key === 'browser' && !v.inApp)}
                          checked={k.locked ? k.platform[c.key] || c.key !== 'browser' : v[c.key]} onChange={(e) => setKind(k.type, { [c.key]: e.target.checked })} />
                      </td>
                    ))}
                    <td className="nd-following">
                      {k.locked ? <span className="muted">Always on</span> : <>{k.following} of {d.members}
                        {differs && <button type="button" className="link-btn" onClick={() => setKind(k.type, { ...k.platform })}>Reset</button>}</>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <LastChanged k="notifications.defaults" section="notifications" />
        </div>
      </section>

      <section className="card mb-22">
        <div className="card-body">
          <div className="setting-row" data-setting="notifications.quiet" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <h4>Quiet hours</h4>
              <p>Nothing automatic is pushed or e-mailed between these, in each person's own time zone. Applies to the {Math.max(0, d.members - d.membersWithOwnSchedule)} members who never set their own schedule.</p>
              <div className="nd-choices" role="radiogroup" aria-label="Quiet hours">
                <label><input type="radio" name="quiet" checked={draft.quiet === 'platform'} onChange={() => setDraft({ ...draft, quiet: 'platform' })} /> The platform's ({d.platformQuiet})</label>
                <label><input type="radio" name="quiet" checked={draft.quiet === 'custom'} onChange={() => setDraft({ ...draft, quiet: 'custom' })} /> Our own:
                  <input className="input nd-time" type="time" aria-label="Quiet from" value={draft.quietStart} disabled={draft.quiet !== 'custom'} onChange={(e) => setDraft({ ...draft, quietStart: e.target.value })} /> to
                  <input className="input nd-time" type="time" aria-label="Quiet until" value={draft.quietEnd} disabled={draft.quiet !== 'custom'} onChange={(e) => setDraft({ ...draft, quietEnd: e.target.value })} /></label>
                <label><input type="radio" name="quiet" checked={draft.quiet === 'none'} onChange={() => setDraft({ ...draft, quiet: 'none' })} /> No quiet hours</label>
              </div>
            </div>
          </div>
          <div className="setting-row" data-setting="notifications.digest" style={{ alignItems: 'flex-start' }}>
            <div className="setting-info" style={{ flex: 1 }}>
              <h4>Daily digest</h4>
              <p>Updates (anything that does not need the person) are not pushed and are e-mailed together once a day. Things that need them still arrive at once.</p>
              <div className="nd-choices" role="radiogroup" aria-label="Daily digest">
                <label><input type="radio" name="digest" checked={draft.digest === 'platform'} onChange={() => setDraft({ ...draft, digest: 'platform' })} /> The platform's (off: updates arrive at once)</label>
                <label><input type="radio" name="digest" checked={draft.digest === 'daily'} onChange={() => setDraft({ ...draft, digest: 'daily' })} /> Once a day at
                  <input className="input nd-time" type="time" aria-label="Digest time" value={draft.digestTime} disabled={draft.digest !== 'daily'} onChange={(e) => setDraft({ ...draft, digestTime: e.target.value })} /></label>
                <label><input type="radio" name="digest" checked={draft.digest === 'off'} onChange={() => setDraft({ ...draft, digest: 'off' })} /> Off</label>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="row mb-22" style={{ gap: 8 }}>
        <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save defaults'}</button>
        {dirty && <button type="button" className="btn btn-ghost" onClick={() => setDraft(fromData(d))}>Discard</button>}
      </div>
      <SectionHistory section="notifications" />
    </>
  );
}
