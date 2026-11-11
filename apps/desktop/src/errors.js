'use strict';
// Errors in the desktop app's own (main) process go to the same place as the web app's: POST /api/v1/telemetry/errors on the
// app's server, which relays them to the Sentry-compatible service only when the server has a DSN, and scrubs them again.
// The window's page reports its own errors (frontend/src/lib/telemetry.ts). Nothing personal is sent.

function scrub(text) {
  return String(text || '').slice(0, 4000)
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, '[token]')
    .replace(/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|otp)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1$2[redacted]')
    .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/(?<![\w-])\+?\d[\d -]{8,}\d(?![\w-])/g, '[number]')
    // Local paths carry the person's account name (C:\Users\asha\..., /Users/asha/...).
    .replace(/([A-Za-z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s]+/g, '$1[user]');
}

function errorReport(err, release) {
  const e = err instanceof Error ? err : new Error(String(err));
  return { type: e.name || 'Error', message: scrub(e.message), stack: scrub(e.stack || ''), page: '/desktop-main', app: 'desktop', release: String(release || 'dev'), device: 'desktop' };
}

/** Starts reporting; returns the function that sends one error (at most 10 distinct ones per run). */
function startErrorReporting({ base, release, fetchImpl = globalThis.fetch, on = (ev, fn) => process.on(ev, fn) }) {
  const seen = new Set();
  let enabled = null;
  const ready = fetchImpl(`${base}/api/v1/telemetry/config`).then((r) => (r.ok ? r.json() : null)).then((j) => { enabled = !!(j && j.data && j.data.errors); }).catch(() => { enabled = false; });
  const send = async (err) => {
    await ready;
    const body = errorReport(err, release);
    const key = `${body.type}:${body.message}`;
    if (!enabled || seen.has(key) || seen.size >= 10) return false;
    seen.add(key);
    try { await fetchImpl(`${base}/api/v1/telemetry/errors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return true; }
    catch { return false; }
  };
  on('uncaughtException', (e) => { console.error(e); void send(e); });
  on('unhandledRejection', (e) => { console.error(e); void send(e); });
  return send;
}

module.exports = { scrub, errorReport, startErrorReporting };
