import { useEffect, useRef } from 'react';
import { meApi } from '../api/endpoints';
import { setContextStaleHandler } from '../api/client';
import { queryClient, useAuth } from '../stores/auth';
import { toast } from '../stores/ui';

const EVERY_MS = 30_000;

/**
 * Keeps menus and buttons in step with what the person may currently do. Every half minute (and whenever the tab comes back into view)
 * it asks the server for a short fingerprint of the person's access; when it differs from the one the app loaded with, the context is
 * reloaded, so a changed role, permission, job-role access or plan shows up without a page reload.
 */
export function AccessWatcher() {
  const reload = useAuth((s) => s.reloadContext);
  const busy = useRef(false);

  useEffect(() => {
    const check = async () => {
      if (busy.current || document.hidden) return;
      const known = useAuth.getState().ctx?.fingerprint;
      if (!known) return;
      busy.current = true;
      try {
        const { fingerprint } = await meApi.fingerprint();
        if (fingerprint !== known) {
          await reload();
          void queryClient.invalidateQueries(); // what the person may see can have changed too
          toast('Your access was updated.', 'info');
        }
      } catch { /* offline or signed out: the next tick tries again */ }
      finally { busy.current = false; }
    };
    const timer = window.setInterval(() => void check(), EVERY_MS);
    const onVisible = () => { if (!document.hidden) void check(); };
    setContextStaleHandler(() => void check());   // a refused request (403) re-checks straight away instead of waiting for the timer
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { setContextStaleHandler(null); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [reload]);

  return null;
}
