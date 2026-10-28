/**
 * Interactive embeds (an editor's own HTML, CSS and JS) and Lottie animations run in a sandboxed frame that is cut off from the app:
 *
 * - `sandbox="allow-scripts"` and nothing else: NO allow-same-origin (the frame has an opaque origin: no cookies, no storage, no access to
 *   the page around it - window.parent throws), NO allow-top-navigation, NO allow-popups, NO allow-forms, NO allow-modals.
 * - The frame's page (/embed/sandbox.html) is served with its own policy: default-src 'none'; script-src 'unsafe-inline';
 *   style-src 'unsafe-inline'; img-src data: - and the `sandbox` directive, so it stays sandboxed even when opened on its own.
 * - The content arrives by postMessage from the page (never in the address), and the frame has a fixed height with a visible
 *   "Interactive embed" label outside it, so it cannot pass itself off as part of the app.
 */
export const SANDBOX_URL = '/embed/sandbox.html';
/** The only sandbox token: scripts run, but in an opaque origin with no way out. */
export const SANDBOX_TOKENS = 'allow-scripts';
/** Tokens that must never be added (checked by the tests). */
export const FORBIDDEN_TOKENS = ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-forms', 'allow-modals', 'allow-pointer-lock', 'allow-downloads', 'allow-storage-access-by-user-activation'];
/** The policy inside the frame (also sent by the server as a header). */
export const EMBED_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export const LIMITS = { html: 40_000, css: 20_000, js: 40_000, total: 80_000, minHeight: 80, maxHeight: 1200 };

/** The attributes every embed frame gets (one place, so the tests can check them). */
export function frameAttrs(title: string) {
  return {
    src: SANDBOX_URL,
    sandbox: SANDBOX_TOKENS,
    title,
    referrerPolicy: 'no-referrer' as const,
    loading: 'lazy' as const,
    // No camera, microphone, location, fullscreen, payment or clipboard inside an embed.
    allow: "camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'",
  };
}

export interface SandboxSource { html: string; css: string; js: string }

/** Size checks before an embed is saved: a message per problem. */
export function checkSandbox(src: SandboxSource): string[] {
  const out: string[] = [];
  if (src.html.length > LIMITS.html) out.push('The HTML is too long (keep it under 40 KB).');
  if (src.css.length > LIMITS.css) out.push('The CSS is too long (keep it under 20 KB).');
  if (src.js.length > LIMITS.js) out.push('The JavaScript is too long (keep it under 40 KB).');
  if (src.html.length + src.css.length + src.js.length > LIMITS.total) out.push('The embed is too large (keep it under 80 KB in all).');
  return out;
}

/** The message the frame waits for: the content to run (it runs it inside its own sandbox). */
export const sandboxMessage = (src: SandboxSource) => ({ kind: 'pt-embed', mode: 'html', html: src.html, css: src.css, js: src.js });
/** A Lottie animation: the player's code and the animation data, run inside the frame too (the animation file is never trusted). */
export const lottieMessage = (player: string, data: unknown, loop: boolean, autoplay: boolean) => ({ kind: 'pt-embed', mode: 'lottie', player, data, loop, autoplay });

export const clampHeight = (h: unknown) => Math.min(LIMITS.maxHeight, Math.max(LIMITS.minHeight, Math.round(Number(h) || 320)));
