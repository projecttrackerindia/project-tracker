import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { allZones, canonicalZone, deviceZone, formatInZone, zoneCity, zoneOffsetLabel, zoneOffsetMinutes } from '../lib/zone';

interface ZoneRow { id: string; city: string; region: string; offset: number; label: string }

let cache: ZoneRow[] | null = null;
function zoneRows(): ZoneRow[] {
  if (cache) return cache;
  const now = new Date();
  cache = allZones().map((id) => {
    const parts = id.split('/');
    return { id, city: zoneCity(id), region: parts.length > 1 ? parts[0].replace(/_/g, ' ') : 'Other', offset: zoneOffsetMinutes(id, now), label: zoneOffsetLabel(id, now) };
  }).sort((a, b) => a.offset - b.offset || a.city.localeCompare(b.city));
  return cache;
}

/**
 * Searchable picker for an IANA time zone: type a city, a region or an offset ("+5:30", "GMT-5"). Each row shows the zone's offset and
 * its local time right now, so the choice is obvious. The device's own zone is offered first.
 */
export function TimeZonePicker({ value, onChange, label = 'Time zone', disabled, allowEmpty, emptyLabel = 'Platform default' }: {
  value: string | null; onChange: (zone: string | null) => void; label?: string; disabled?: boolean; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const device = deviceZone();
  const rows = useMemo(zoneRows, []);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^(utc|gmt)/, 'gmt');
    const base = !t ? rows : rows.filter((r) => r.id.toLowerCase().includes(t) || r.city.toLowerCase().includes(t) || r.region.toLowerCase().includes(t)
      || r.label.toLowerCase().replace('gmt', 'gmt').includes(t) || r.label.toLowerCase().replace('gmt', '').includes(t.replace('gmt', '')));
    const pinned = !t ? rows.filter((r) => r.id === device) : [];
    return [...pinned, ...base.filter((r) => !pinned.includes(r))].slice(0, 400);
  }, [q, rows, device]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); }, [open]);

  const pick = (zone: string | null) => { onChange(zone ? canonicalZone(zone) : null); setOpen(false); setQ(''); };
  const current = value ? rows.find((r) => r.id === canonicalZone(value)) : null;

  return (
    <div className={`tzp ${open ? 'open' : ''}`} ref={box}>
      <button type="button" className="tzp-trigger input" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <Icon name="clock" size={15} />
        {value ? (
          <span className="tzp-value"><b>{current?.city ?? zoneCity(value)}</b><span>{current?.label ?? zoneOffsetLabel(value)} · {value}</span></span>
        ) : <span className="tzp-value"><b>{emptyLabel}</b></span>}
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <div className="tzp-pop" role="dialog" aria-label={`Choose ${label.toLowerCase()}`}>
          <div className="tzp-search">
            <Icon name="search" size={14} />
            <input ref={input} className="input" placeholder="Search a city, region or offset (e.g. Kolkata, +5:30)" value={q} onChange={(e) => setQ(e.target.value)}
              role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active].id); }
                else if (e.key === 'Escape') setOpen(false);
              }} />
          </div>
          <ul className="tzp-list" role="listbox" id={listId} aria-label="Time zones">
            {allowEmpty && !q && (
              <li role="option" aria-selected={!value} className={`tzp-row ${!value ? 'selected' : ''}`} onClick={() => pick(null)}>
                <span className="tzp-city">{emptyLabel}</span><span className="tzp-meta">Uses the default</span>
              </li>
            )}
            {filtered.map((r, i) => (
              <li key={r.id} id={`${listId}-${i}`} role="option" aria-selected={value === r.id}
                className={`tzp-row ${i === active ? 'active' : ''} ${value === r.id ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)} onClick={() => pick(r.id)}>
                <span className="tzp-city">{r.city}{r.id === device && <em>This device</em>}</span>
                <span className="tzp-meta">{r.id}</span>
                <span className="tzp-offset">{r.label}</span>
                <span className="tzp-now">{formatInZone(new Date(), { hour: '2-digit', minute: '2-digit' }, r.id)}</span>
              </li>
            ))}
            {!filtered.length && <li className="tzp-empty">No time zone matches “{q}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
