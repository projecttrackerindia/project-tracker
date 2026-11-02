/** One in-flight refresh and one coalesced follow-up: event bursts cannot starve reads by restarting them. */
export interface RefreshQueue { request: () => void; dispose: () => void }
export function createRefreshQueue(refresh: () => Promise<unknown>, delay = 150): RefreshQueue {
  let dirty = false, running = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = () => {
    if (stopped) return;
    dirty = true;
    if (!running && timer === undefined) timer = setTimeout(() => { void flush(); }, delay);
  };
  const flush = async () => {
    timer = undefined;
    if (stopped || !dirty) return;
    dirty = false; running = true;
    try { await refresh(); } catch { /* Failed reads retain the query's normal error/reconnect behavior. */ }
    finally { running = false; if (dirty && !stopped) request(); }
  };
  return { request, dispose: () => { stopped = true; dirty = false; clearTimeout(timer); } };
}
