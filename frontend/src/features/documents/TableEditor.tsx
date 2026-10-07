import { useMemo } from 'react';
import { Icon } from '../../components/Icon';
import type { SectionTemplate } from '../../api/types';

interface Col { key: string; label: string }
interface Grid { columns: Col[]; rows: Record<string, string>[] }

const keyOf = (label: string, i: number) => label.replace(/[^A-Za-z0-9]/g, '') || `c${i}`;

function parse(value: string, tpl?: SectionTemplate | null): Grid {
  let g: Grid = { columns: [], rows: [] };
  try { const v = JSON.parse(value); if (v && Array.isArray(v.columns)) g = { columns: v.columns, rows: Array.isArray(v.rows) ? v.rows : [] }; } catch { /* empty */ }
  if (g.columns.length === 0 && tpl?.columns) g.columns = tpl.columns.map((label, i) => ({ key: keyOf(label, i), label }));
  return g;
}

/** A small grid of plain-text cells (risks, stakeholders, systems ...). Stored as data; the server limits columns, rows and cell length. */
export function TableEditor({ value, onChange, readOnly, template, label }: { value: string; onChange?: (json: string) => void; readOnly?: boolean; template?: SectionTemplate | null; label: string }) {
  const grid = useMemo(() => parse(value, template), [value, template]);
  const emit = (g: Grid) => onChange?.(JSON.stringify(g));
  const set = (r: number, key: string, v: string) => emit({ ...grid, rows: grid.rows.map((row, i) => (i === r ? { ...row, [key]: v } : row)) });
  const add = () => emit({ ...grid, rows: [...grid.rows, Object.fromEntries(grid.columns.map((c) => [c.key, '']))] });
  const remove = (r: number) => emit({ ...grid, rows: grid.rows.filter((_, i) => i !== r) });

  if (grid.columns.length === 0) return <p className="muted">This table has no columns.</p>;
  if (readOnly && grid.rows.length === 0) return <p className="muted">Nothing added yet.</p>;
  return (
    <div className="te" role="group" aria-label={label}>
      <div className="te-scroll">
        <table className="te-table">
          <thead><tr>{grid.columns.map((c) => <th key={c.key}>{c.label}</th>)}{!readOnly && <th className="te-act" aria-label="Row actions" />}</tr></thead>
          <tbody>
            {grid.rows.map((row, r) => (
              <tr key={r}>
                {grid.columns.map((c) => (
                  <td key={c.key} data-label={c.label}>
                    {readOnly ? <span>{row[c.key]}</span>
                      : <textarea rows={1} value={row[c.key] ?? ''} maxLength={2000} aria-label={`${c.label}, row ${r + 1}`} onChange={(e) => set(r, c.key, e.target.value)}
                          onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; }} />}
                  </td>
                ))}
                {!readOnly && <td className="te-act"><button type="button" className="btn-icon danger" aria-label={`Remove row ${r + 1}`} onClick={() => remove(r)}><Icon name="trash" size={15} /></button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={grid.rows.length >= 500}><Icon name="plus" size={15} /> Add a row</button>}
    </div>
  );
}
