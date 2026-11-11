import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { get } from '../../api/client';
import { useAuth } from '../../stores/auth';
import { OPEN_TOUR, shouldAutoOpen, type TourState } from './open';

const WelcomeTour = lazy(() => import('./WelcomeTour'));
const doneKey = (uid: string) => `pt_tour_seen:${uid}`;
const rememberSeen = (uid: string | undefined) => { if (uid) try { localStorage.setItem(doneKey(uid), '1'); } catch { /* storage unavailable */ } };
const seenHere = (uid: string) => { try { return localStorage.getItem(doneKey(uid)) === '1'; } catch { return false; } };

/**
 * Mounted once in the shell. Its own code is tiny: the tour itself is fetched only when it opens. It opens by itself once, on Home, in a
 * brand-new workspace (see shouldAutoOpen), and whenever someone asks for it (account menu, ⌘K, Settings).
 */
export function TourGate() {
  const uid = useAuth((s) => s.ctx?.user.id);
  const wid = useAuth((s) => s.ctx?.current?.id);
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  const home = loc.pathname === '/' || loc.pathname === '';
  useEffect(() => {
    const go = () => setOpen(true);
    window.addEventListener(OPEN_TOUR, go);
    return () => window.removeEventListener(OPEN_TOUR, go);
  }, []);
  useEffect(() => {
    if (!uid || !wid || !home || seenHere(uid)) return;
    let live = true;
    void (async () => {
      try {
        const pref = (await get<{ value: TourState | null }>('/me/ui/onboarding'))?.value;
        if (pref !== null) { if (pref?.done) rememberSeen(uid); return; }
        const [sample, projects] = await Promise.all([
          get<{ exists?: unknown }>('/onboarding/sample-project'),
          get<{ totalItems?: unknown }>('/projects', { pageSize: 1 }),
        ]);
        if (live && shouldAutoOpen(pref, sample?.exists, projects?.totalItems)) window.setTimeout(() => { if (live) setOpen(true); }, 700);
      } catch { /* the tour stays closed; it is always one click away */ }
    })();
    return () => { live = false; };
  }, [uid, wid, home]);
  if (!open) return null;
  return <Suspense fallback={null}><WelcomeTour onClose={() => { setOpen(false); rememberSeen(uid); }} /></Suspense>;
}
