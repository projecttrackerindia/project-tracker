import type { DtDocument, DtDrift } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { timeAgo } from '../../../lib/format';

/** A page untouched this long, never verified, may be stale (the same 90 days Library's "out of date" list uses). */
export const STALE_DAYS = 90;
const DAY = 86_400_000;

export interface FreshInput { verifiedAt?: string | null; staleSince?: string | null; updatedAt?: string | null }
export type FreshState = { stale: true; since: string | null } | { stale: false; days: number; verified: boolean } | null;

/** Verified N days ago (the last verify, or else the last edit, which is when someone last stood behind it), or May be stale. */
export function freshOf(f: FreshInput, now = Date.now()): FreshState {
  if (f.staleSince) return { stale: true, since: f.staleSince };
  const at = f.verifiedAt ?? f.updatedAt;
  if (!at) return null;
  const days = Math.max(0, Math.floor((now - Date.parse(at)) / DAY));
  if (!f.verifiedAt && days > STALE_DAYS) return { stale: true, since: null };
  return { stale: false, days, verified: !!f.verifiedAt };
}

/** Several pages as one: stale when any is, otherwise as old as the least recently confirmed one. */
export function freshOfMany(docs: FreshInput[], now = Date.now()): FreshState {
  const states = docs.map((d) => freshOf(d, now)).filter((x): x is NonNullable<FreshState> => !!x);
  if (!states.length) return null;
  const stale = states.find((s) => s.stale);
  if (stale) return stale;
  return states.reduce((a, b) => (!a.stale && !b.stale && b.days > a.days ? b : a));
}

export const freshLabel = (s: NonNullable<FreshState>) => (s.stale ? 'May be stale' : s.days === 0 ? 'Verified today' : `Verified ${s.days} day${s.days === 1 ? '' : 's'} ago`);

/** The pill every Library page shows by its breadcrumb: green "Verified 3 days ago", or amber "May be stale". */
export function FreshPill({ state }: { state: FreshState }) {
  if (!state) return null;
  const title = state.stale ? (state.since ? `Its linked work changed ${timeAgo(state.since)}.` : `Not edited or verified in over ${STALE_DAYS} days.`)
    : state.verified ? 'Confirmed still right by its owner.' : 'Last edited then; no one has marked it verified since.';
  return <span className={`dx-fresh${state.stale ? ' stale' : ''}`} data-testid="fresh-pill" title={title}><Icon name={state.stale ? 'clock' : 'tick'} size={11} />{freshLabel(state)}</span>;
}

/** "Docs differ from live API" when the last live check found differences. */
export function DriftPill({ drift }: { drift: Pick<DtDrift, 'differs' | 'missing' | 'extra' | 'changed' | 'env' | 'checkedAt'> | null | undefined }) {
  if (!drift?.differs) return null;
  const n = drift.missing + drift.extra + drift.changed;
  return <span className="dx-fresh drift" data-testid="drift-pill" title={`${n} field${n === 1 ? '' : 's'} differ on ${drift.env}, checked ${timeAgo(drift.checkedAt)}`}><Icon name="alert" size={11} />Docs differ from live API</span>;
}

export const docFresh = (d: Pick<DtDocument, 'verifiedAt' | 'staleSince' | 'updatedAt'> | undefined) => (d ? freshOf(d) : null);
