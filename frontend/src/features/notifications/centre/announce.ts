/**
 * A new notification arrived while the app is open: one sound (its own cue, if this category may sound here and nothing is muted), a buzz
 * and a flashing title when the person is elsewhere. The same notification can arrive by push, the live connection and the check: it is
 * announced once.
 */
import { firstTime, getAttention, kindForType } from '../../../lib/attention';
import type { AppNotification } from '../../../api/types';
import { categoryOf, cueOf } from './model';
import { flashAura } from '../../../components/aura/mood';
import { isMuted, getAlertPrefs, maySound } from './prefs';

type Arrival = Pick<AppNotification, 'type' | 'link'> & { id?: string | null; category?: AppNotification['category'] };

/** Returns whether a sound was played (the service worker then keeps the system notification silent). */
export function announce(n: Arrival, opts: { silent?: boolean } = {}): boolean {
  if (n.id && !firstTime(`n-${n.id}`, 120_000)) return false;
  if (/mention|approv/i.test(n.type)) flashAura('alert', 5000);   // Aura: heads up
  const p = getAlertPrefs();
  const cat = categoryOf({ type: n.type, link: n.link ?? null, category: n.category });
  const silent = !!opts.silent || !maySound(cat, p);
  if (isMuted(p) || p.dnd) return false;   // muted: not even a buzz or a flashing title
  return getAttention({ kind: kindForType(n.type), cue: cueOf({ type: n.type, link: n.link ?? null, category: n.category }), silent });
}
