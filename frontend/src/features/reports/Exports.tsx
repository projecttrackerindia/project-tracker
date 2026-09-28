import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, download } from '../../api/client';
import { exportApi, projectApi } from '../../api/endpoints';
import type { ReportExport, ReportFormat, ReportKind } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, SubmitButton } from '../../components/ui';
import { formatBytes, timeAgo } from '../../lib/format';
import { usePersonPicker, useWsQuery } from '../../lib/hooks';
import { useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

export const KIND_INFO: Record<ReportKind, { label: string; hint: string }> = {
  Project: { label: 'Project report', hint: 'Task list, status breakdown and progress — for one project or everything you can see.' },
  Workload: { label: 'Team workload', hint: 'Open, overdue and completed work per person.' },
  Timesheet: { label: 'Timesheet', hint: 'Logged time by person, date and task.' },
};
const FORMATS: { id: ReportFormat; label: string }[] = [{ id: 'Csv', label: 'CSV' }, { id: 'Xlsx', label: 'Excel (.xlsx)' }, { id: 'Pdf', label: 'PDF' }];

const tone = (s: ReportExport['status']) => (s === 'Ready' ? 'success' : s === 'Failed' ? 'danger' : 'info');

/** The filters that make sense for one report type, then "Generate" queues it — the file itself is built in the
 *  background (see ExportList below), so asking for a large report never holds this page waiting. */
export function ReportGenerator({ kind, onRequested }: { kind: ReportKind; onRequested: () => void }) {
  const advanced = useEntitlement('ADVANCED_REPORTS') > 0;
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }), { enabled: kind !== 'Workload' });
  const { canPick, choices } = usePersonPicker();
  const [format, setFormat] = useState<ReportFormat>('Xlsx');
  const [projectId, setProjectId] = useState('');
  const [targetUserId, setTargetUserId] = useState('');
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = advanced ? format : 'Csv';

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await exportApi.request({
        kind, format: chosen,
        projectId: kind !== 'Workload' ? (projectId || null) : null,
        targetUserId: kind !== 'Project' ? (targetUserId || null) : null,
        days,
      });
      toast('Your report is being prepared. It will appear below.');
      onRequested();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not request the report.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>{KIND_INFO[kind].label}</h3><p>{KIND_INFO[kind].hint}</p></div></div>
      <form className="card-body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="grid-2" style={{ gap: 14 }}>
          <Field label="Format" hint={advanced ? undefined : 'Excel and PDF are part of the Pro plan and above.'}>
            <Select className="select" value={chosen} onChange={(e) => setFormat(e.target.value as ReportFormat)}>
              {FORMATS.map((f) => <option key={f.id} value={f.id} disabled={!advanced && f.id !== 'Csv'}>{f.label}</option>)}
            </Select>
          </Field>
          {kind !== 'Workload' && (
            <Field label="Project">
              <Select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects I can see</option>{projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          {kind !== 'Project' && canPick && (
            <Field label="Person">
              <Select className="select" value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
                <option value="">Everyone I can see</option>{choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
          {kind !== 'Workload' && (
            <Field label="Period">
              <Select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 14, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
              </Select>
            </Field>
          )}
        </div>
        {!advanced && <div className="notice" style={{ marginTop: 14 }}>Want Excel and PDF? <Link className="link" to="/billing">See plans</Link></div>}
        <div style={{ marginTop: 16 }}><SubmitButton busy={busy}><Icon name="download" size={14} /> Generate report</SubmitButton></div>
      </form>
    </div>
  );
}

export function ExportList({ refreshKey }: { refreshKey: number }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const q = useWsQuery(['report-exports', refreshKey], () => exportApi.list(), {
    // Poll while something is still being prepared.
    refetchInterval: (query) => ((query.state.data as ReportExport[] | undefined)?.some((e) => e.status === 'Queued' || e.status === 'Running') ? 2500 : false),
  });
  const items = q.data ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'report-exports'] });

  const get = async (e: ReportExport) => {
    try { await download(`/reports/exports/${e.id}/file`, e.fileName ?? 'report'); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Could not download the report.', 'error'); refresh(); }
  };
  const remove = async (e: ReportExport) => {
    if (!(await confirmDialog({ title: 'Delete report?', message: 'The file will be removed. You can always request it again.', confirmText: 'Delete' }))) return;
    try { await exportApi.remove(e.id); refresh(); } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not delete the report.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head"><div><h3>Your reports</h3><p>Files are kept for 7 days.</p></div></div>
      <div className="card-body">
        {items.length === 0 ? <EmptyState icon="download" title="No reports yet" text="Generate a project, workload or timesheet report above." /> : (
          <div className="export-list">
            {items.map((e) => (
              <div className="export-row" key={e.id}>
                <div className="export-main">
                  <b>{KIND_INFO[e.kind].label}</b> <span className="muted">· {e.format === 'Xlsx' ? 'Excel' : e.format.toUpperCase()}</span>{' '}
                  <Badge tone={tone(e.status)}>{e.status === 'Queued' ? 'Waiting' : e.status === 'Running' ? 'Preparing…' : e.status === 'Ready' ? 'Ready' : 'Failed'}</Badge>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Asked {timeAgo(e.createdAt)}{e.status === 'Ready' && e.fileName ? ` · ${e.fileName} · ${formatBytes(e.sizeBytes)}` : ''}{e.status === 'Failed' && e.error ? ` · ${e.error}` : ''}
                  </div>
                </div>
                <div className="td-actions">
                  {e.status === 'Ready' && <button className="btn btn-primary btn-sm" onClick={() => void get(e)}><Icon name="download" size={14} /> Download</button>}
                  {(e.status === 'Ready' || e.status === 'Failed') && <button type="button" className="btn-icon danger" title="Delete" aria-label="Delete report" onClick={() => void remove(e)}><Icon name="trash" /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
