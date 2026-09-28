import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { customFieldApi } from '../../api/endpoints';
import type { CustomField } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Select } from '../../components/Select';

/** The workspace's custom fields (empty list while loading or when none are defined). */
export function useCustomFields() {
  return useWsQuery(['custom-fields'], customFieldApi.list, { staleTime: 60_000 });
}

/**
 * The custom fields of a task. On an existing task each change is saved as soon as it is made (text, numbers and dates when the box
 * loses focus); on a task that is still being created the values are collected in `pending` and saved right after it is created.
 */
export function CustomFieldsSection({ taskId, canEdit, pending, onPending }: {
  taskId?: string; canEdit: boolean; pending?: Record<string, string>; onPending?: (v: Record<string, string>) => void;
}) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const defs = useCustomFields();
  const stored = useWsQuery(['task', taskId, 'custom-fields'], () => customFieldApi.values(taskId!), { enabled: !!taskId });
  const [local, setLocal] = useState<Record<string, string>>({});

  // Start (and restart after a reload) from what the server holds.
  useEffect(() => {
    if (taskId && stored.data) setLocal(Object.fromEntries(stored.data.map((v) => [v.fieldId, v.value])));
  }, [taskId, stored.data]);

  const fields = defs.data ?? [];
  if (fields.length === 0) return null;
  const values = taskId ? local : pending ?? {};

  const save = async (f: CustomField, raw: string) => {
    if (!taskId) return;
    if ((stored.data?.find((v) => v.fieldId === f.id)?.value ?? '') === raw) return;
    try {
      await customFieldApi.setValues(taskId, { [f.id]: raw === '' ? null : raw });
      void qc.invalidateQueries({ queryKey: [wid, 'task', taskId] });
    } catch (e) {
      toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save that field.', 'error');
      setLocal(Object.fromEntries((stored.data ?? []).map((v) => [v.fieldId, v.value])));
    }
  };
  const change = (f: CustomField, raw: string, saveNow: boolean) => {
    if (taskId) setLocal((l) => ({ ...l, [f.id]: raw })); else onPending?.({ ...(pending ?? {}), [f.id]: raw });
    if (saveNow) void save(f, raw);
  };

  return (
    <div className="cf-box">
      <div className="cf-head"><h4><Icon name="list" size={15} /> Custom fields</h4></div>
      <div className="cf-grid">
        {fields.map((f) => {
          const v = values[f.id] ?? '';
          const id = `cf-${f.id}`;
          return (
            <div className="field" key={f.id}>
              <label htmlFor={id}>{f.name}</label>
              {f.type === 'Checkbox' ? (
                <label className="check"><input id={id} type="checkbox" disabled={!canEdit} checked={v === 'true'} onChange={(e) => change(f, e.target.checked ? 'true' : 'false', true)} /> Yes</label>
              ) : f.type === 'Dropdown' ? (
                <Select id={id} className="select" disabled={!canEdit} value={v} onChange={(e) => change(f, e.target.value, true)}>
                  <option value="">—</option>
                  {v !== '' && !f.options.includes(v) && <option value={v}>{v} (removed)</option>}
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              ) : (
                <input id={id} className="input" disabled={!canEdit} maxLength={500}
                  type={f.type === 'Number' ? 'number' : f.type === 'Date' ? 'date' : 'text'} step={f.type === 'Number' ? 'any' : undefined}
                  value={v} onChange={(e) => change(f, e.target.value, false)} onBlur={(e) => void save(f, e.target.value.trim())} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
