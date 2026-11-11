import { dm } from '../projects/planSheet';
import './extension.css';

interface Slipped { originalDate?: string | null; extensionCount?: number; totalSlipDays?: number; due?: string | null; dueDate?: string | null }

/** "Extended ×N" next to a date that was moved later; the hover says from what to what and by how many days. History with reasons: Activity tab. */
export function ExtendedBadge({ r }: { r: Slipped }) {
  const n = r.extensionCount ?? 0;
  if (n <= 0) return null;
  const now = r.due ?? r.dueDate ?? null;
  const days = r.totalSlipDays ?? 0;
  return (
    <span className="xd-badge" data-testid="extended-badge" title={`Dates extended ${n} time${n === 1 ? '' : 's'}${r.originalDate ? ` · first ${dm(r.originalDate)}` : ''}${now ? ` → now ${dm(now)}` : ''}${days ? ` (+${days} days)` : ''}. See Activity for the reasons.`}>
      Extended ×{n}
    </span>
  );
}

/** The original date struck through before the current one, when it moved. */
export function WasDate({ r }: { r: Slipped }) {
  const now = r.due ?? r.dueDate ?? null;
  if (!r.originalDate || !(r.extensionCount ?? 0) || r.originalDate === now) return null;
  return <s className="xd-was" aria-label={`Originally ${dm(r.originalDate)}`}>{dm(r.originalDate)}</s>;
}
