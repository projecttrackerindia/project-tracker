/**
 * Telling an open tab that a newer release is live. The decisions are plain functions (tested in appUpdate.test.ts); the listening and the
 * reloading are in updateWatch.ts.
 *
 * Every production build has an id (a hash of its fingerprinted file names, see vite.config.ts). The page carries the id of the build it is
 * running in <meta name="app-build">, and /version.json - never cached - names the build the server has now. When the two differ, the tab
 * is running old code. This works the same with or without a service worker (Android app, desktop app, private windows).
 */

export const BUILD_META = 'app-build';
export const VERSION_URL = '/version.json';
/** How often an open, visible tab asks the server. */
export const POLL_MS = 5 * 60_000;
/** Returning to the tab asks again, but not more often than this (focus and visibilitychange usually arrive together). */
export const MIN_GAP_MS = 30_000;

const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The build this page is running, from its own index.html; null when it has none (development, or a page from before builds had ids). */
export function runningBuild(doc: Pick<Document, 'querySelector'> | undefined): string | null {
  const id = doc?.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute('content')?.trim() ?? '';
  return BUILD_ID.test(id) ? id : null;
}

/** The server's current build from the body of /version.json; null for anything that is not a well-formed answer. */
export function parseVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const build = (payload as { build?: unknown }).build;
  return typeof build === 'string' && BUILD_ID.test(build) ? build : null;
}

/** True only when both builds are known and they differ: an unknown on either side is never a reason to interrupt anyone. */
export function isNewBuild(running: string | null, server: string | null): boolean {
  return !!running && !!server && running !== server;
}

export interface CheckState {
  hidden: boolean;
  online: boolean;
  now: number;
  /** When the last check started (ms), or -Infinity before the first. */
  lastCheck: number;
  inFlight: boolean;
  /** Skip the minimum gap (the regular timer, coming back online, a hint from the service worker). Hidden or offline still wait. */
  force?: boolean;
}

/** Whether to ask the server now: never from a hidden or offline tab, never twice at once, and not again within the minimum gap. */
export function shouldCheck(s: CheckState): boolean {
  if (s.inFlight || s.hidden || !s.online) return false;
  return !!s.force || s.now - s.lastCheck >= MIN_GAP_MS;
}

/** The banner shows for a newer build until "Later" is chosen for that same build; a later release shows it again. */
export function shouldShow(available: string | null, dismissed: string | null): boolean {
  return !!available && available !== dismissed;
}

export interface UpdateCheckerOptions {
  running: string | null;
  /** Fetches /version.json and returns its parsed body (throwing or returning junk is treated as "no answer"). */
  fetchVersion: () => Promise<unknown>;
  env: () => { hidden: boolean; online: boolean };
  now?: () => number;
  /** Called when the newer build the server reports changes: its id, or null when the server is back on the running build. */
  onChange: (build: string | null) => void;
}

/** One tab's checker: asks the server when allowed and reports only changes, so a repeated answer never re-opens a dismissed banner. */
export function createUpdateChecker(o: UpdateCheckerOptions) {
  const now = o.now ?? Date.now;
  let lastCheck = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let newer: string | null = null;
  return {
    /** Resolves to the server's build when a check ran and got an answer, null otherwise. */
    async check(force = false): Promise<string | null> {
      if (!o.running) return null;
      const { hidden, online } = o.env();
      const at = now();
      if (!shouldCheck({ hidden, online, now: at, lastCheck, inFlight, force })) return null;
      inFlight = true;
      lastCheck = at;
      try {
        const server = parseVersion(await o.fetchVersion());
        if (!server) return null;
        const next = isNewBuild(o.running, server) ? server : null;
        if (next !== newer) { newer = next; o.onChange(next); }
        return server;
      } catch {
        return null;
      } finally {
        inFlight = false;
      }
    },
    get newer() { return newer; },
  };
}
