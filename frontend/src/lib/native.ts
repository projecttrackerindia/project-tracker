/**
 * The Android app (a native shell around this same web app, downloaded from the website). Inside it the page can reach the phone:
 * push notifications through Firebase, the Back button, links that open the app, the status bar, and saving files. In a browser every
 * function here does nothing special, so the rest of the app calls them without checking where it runs.
 */
type Plugin = Record<string, (...args: never[]) => Promise<unknown>> & { addListener: (event: string, cb: (e: never) => void) => Promise<{ remove: () => Promise<void> }> };
type Capacitor = { isNativePlatform?: () => boolean; getPlatform?: () => string; Plugins?: Record<string, unknown> };
const capacitor = () => (window as unknown as { Capacitor?: Capacitor }).Capacitor;

export const isNativeApp = () => { const c = capacitor(); return !!c?.isNativePlatform?.() && c.getPlatform?.() === 'android'; };
const plugin = (name: string) => capacitor()?.Plugins?.[name] as Plugin | undefined;
const call = <T,>(p: Plugin | undefined, method: string, args?: unknown): Promise<T> =>
  p ? (p[method] as unknown as (a?: unknown) => Promise<T>)(args) : Promise.reject(new Error('Not available'));

// ------------------------------------------------------------------ files

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Saves a file the person asked for. In a browser: a download. In the Android app (which cannot download from a page): the share sheet, where they pick Files, Drive, WhatsApp and so on. */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  if (isNativeApp() && plugin('Filesystem') && plugin('Share')) {
    try {
      const safe = filename.replace(/[^\w.-]+/g, '_');
      const written = await call<{ uri: string }>(plugin('Filesystem'), 'writeFile', { path: `exports/${Date.now()}-${safe}`, data: await toBase64(blob), directory: 'CACHE', recursive: true });
      await call(plugin('Share'), 'share', { title: filename, files: [written.uri], dialogTitle: filename });
      return;
    } catch (e) {
      if (e instanceof Error && /cancel/i.test(e.message)) return;   // the person closed the share sheet
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------ push

const TOKEN_KEY = 'pm_fcm_token';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (t: string | null) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

/** What the server calls this phone: "fcm:" + the Firebase token. Null until push has been turned on. */
export const nativeEndpoint = () => { const t = readToken(); return isNativeApp() && t ? `fcm:${t}` : null; };

export type NativePermission = 'granted' | 'denied' | 'prompt';
export async function nativePermission(): Promise<NativePermission> {
  try { return (await call<{ receive: NativePermission }>(plugin('PushNotifications'), 'checkPermissions')).receive; } catch { return 'denied'; }
}

/** Asks Firebase for this phone's token (it can change, so this is repeated on every start). */
function fetchToken(): Promise<string> {
  const p = plugin('PushNotifications');
  return new Promise((resolve, reject) => {
    if (!p) { reject(new Error('Not available')); return; }
    const handles: { remove: () => Promise<void> }[] = [];
    const done = (fn: () => void) => { clearTimeout(timer); handles.forEach((h) => void h.remove()); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error('Push is not set up in this build of the app.'))), 15_000);
    void p.addListener('registration', ((t: { value: string }) => done(() => resolve(t.value))) as never).then((h) => handles.push(h));
    void p.addListener('registrationError', (() => done(() => reject(new Error('Push is not set up in this build of the app.')))) as never).then((h) => handles.push(h));
    call(p, 'createChannel', { id: 'alerts', name: 'Alerts', description: 'Reminders, mentions, assignments and sign-in requests', importance: 4, visibility: 1, vibration: true })
      .catch(() => undefined).then(() => call(p, 'register')).catch((e) => done(() => reject(e)));
  });
}

/** Turns push on for this phone: asks permission, gets the token and tells the server. Returns the endpoint the server knows it by. */
export async function enableNativePush(register: (token: string) => Promise<unknown>): Promise<'on' | 'blocked' | 'unavailable'> {
  const p = plugin('PushNotifications');
  let perm = await nativePermission();
  if (perm !== 'granted') perm = (await call<{ receive: NativePermission }>(p, 'requestPermissions').catch(() => ({ receive: 'denied' as const }))).receive;
  if (perm !== 'granted') return 'blocked';
  try { const token = await fetchToken(); await register(token); writeToken(token); return 'on'; } catch { return 'unavailable'; }
}

/** Forgets this phone's token (turning alerts off). */
export async function disableNativePush(unregister: (endpoint: string) => Promise<unknown>) {
  const endpoint = nativeEndpoint();
  if (endpoint) await unregister(endpoint).catch(() => undefined);
  writeToken(null);
  await call(plugin('PushNotifications'), 'unregister').catch(() => undefined);
}

/** On every start after sign-in: when alerts are on, refresh the token with the server. */
export async function syncNativePush(register: (token: string) => Promise<unknown>) {
  if (!isNativeApp() || !readToken() || (await nativePermission()) !== 'granted') return;
  try {
    const token = await fetchToken();
    if (!readToken()) return;   // signed out while waiting: this phone must not be registered again
    await register(token); writeToken(token);
  } catch { /* try again next start */ }
}

// ------------------------------------------------------------------ the shell

/** Opens a path inside the app without reloading it. Only paths of this site are accepted. */
export function openInApp(link: string | undefined | null) {
  if (!link) return;
  let path: string;
  try { const u = new URL(link, location.origin); if (u.origin !== location.origin && u.protocol !== 'projecttracker:') return; path = u.protocol === 'projecttracker:' ? `/${u.host}${u.pathname}${u.search}` : `${u.pathname}${u.search}${u.hash}`; } catch { return; }
  if (!path.startsWith('/') || path.startsWith('//')) return;
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const isDark = (rgb: string) => {
  const m = rgb.match(/\d+/g)?.map(Number);
  return m && m.length >= 3 ? (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 140 : false;
};
const hex = (rgb: string) => '#' + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

function matchStatusBar() {
  const bar = plugin('StatusBar');
  if (!bar) return;
  const bg = getComputedStyle(document.body).backgroundColor;
  if (!bg || bg === 'rgba(0, 0, 0, 0)') return;
  void call(bar, 'setBackgroundColor', { color: hex(bg) }).catch(() => undefined);
  void call(bar, 'setStyle', { style: isDark(bg) ? 'DARK' : 'LIGHT' }).catch(() => undefined);
}

let started = false;
/** Called once at start. Back goes back through the app and leaves it from the first screen; links to the site open here; a tapped notification opens its page; the status bar follows the theme. */
export function startNativeApp() {
  if (started || !isNativeApp()) return;
  started = true;
  document.documentElement.classList.add('native-app');
  const app = plugin('App');
  void app?.addListener('backButton', ((e: { canGoBack: boolean }) => { if (e.canGoBack) history.back(); else void call(app, 'exitApp').catch(() => undefined); }) as never);
  void app?.addListener('appUrlOpen', ((e: { url: string }) => openInApp(e.url)) as never);
  void plugin('PushNotifications')?.addListener('pushNotificationActionPerformed', ((e: { notification?: { data?: { link?: string } } }) => openInApp(e.notification?.data?.link)) as never);
  void call(plugin('SplashScreen'), 'hide').catch(() => undefined);
  matchStatusBar();
  window.addEventListener('load', () => { matchStatusBar(); setTimeout(matchStatusBar, 600); });   // the page's colors are there a moment after start
  new MutationObserver(matchStatusBar).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', matchStatusBar);
}
