export interface WhatsAppSignupStart { state: string; appId: string; configId: string; apiVersion: string; signupVersion: 'v3' | 'v4' }
export interface WhatsAppSignupResult { code: string; businessAccountId: string; phoneNumberId: string }
interface MetaSdk {
  init(options: { appId: string; version: string; xfbml: boolean; autoLogAppEvents: boolean }): void;
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: unknown): void;
}
declare global { interface Window { FB?: MetaSdk } }
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
export function parseWhatsAppFinish(origin: string, raw: unknown): { businessAccountId: string; phoneNumberId: string } | null {
  if (!['https://www.facebook.com', 'https://web.facebook.com'].includes(origin) || typeof raw !== 'string' || raw.length > 8192) return null;
  try {
    const event = JSON.parse(raw);
    if (event?.type !== 'WA_EMBEDDED_SIGNUP' || event?.event !== 'FINISH'
      || !id(event?.data?.waba_id) || !id(event?.data?.phone_number_id)) return null;
    return { businessAccountId: event.data.waba_id, phoneNumberId: event.data.phone_number_id };
  } catch { return null; }
}
export function whatsappLoginOptions(start: WhatsAppSignupStart) {
  if (!id(start.appId) || !id(start.configId) || !/^v[0-9]{1,3}\.[0-9]{1,2}$/.test(start.apiVersion)
    || !['v3', 'v4'].includes(start.signupVersion) || !/^[A-F0-9]{64}$/.test(start.state)) throw new Error('Invalid WhatsApp setup configuration.');
  return { config_id: start.configId, response_type: 'code', override_default_response_type: true,
    extras: { sessionInfoVersion: '3', version: start.signupVersion } };
}
let sdkLoad: Promise<void> | null = null;
let sdkKey = '';
export function loadWhatsAppSdk(start: WhatsAppSignupStart): Promise<void> {
  whatsappLoginOptions(start);
  if (location.protocol !== 'https:') return Promise.reject(new Error('WhatsApp installation requires HTTPS.'));
  const key = start.appId + ':' + start.apiVersion;
  if (sdkLoad) return key === sdkKey ? sdkLoad : Promise.reject(new Error('Provider configuration changed. Reload this page.'));
  sdkKey = key;
  sdkLoad = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true; script.referrerPolicy = 'no-referrer';
    const timer = window.setTimeout(() => { script.remove(); sdkLoad = null; reject(new Error('Meta did not load. Try again.')); }, 15000);
    script.onload = () => {
      window.clearTimeout(timer);
      if (!window.FB) { sdkLoad = null; reject(new Error('Meta did not initialize. Try again.')); return; }
      window.FB.init({ appId: start.appId, version: start.apiVersion, xfbml: false, autoLogAppEvents: false }); resolve();
    };
    script.onerror = () => { window.clearTimeout(timer); script.remove(); sdkLoad = null; reject(new Error('Meta could not load. Check your browser settings.')); };
    document.head.append(script);
  });
  return sdkLoad;
}
/** Called synchronously from a user click after SDK preparation, preserving popup activation. */
export function launchWhatsAppSignup(start: WhatsAppSignupStart, signal: AbortSignal): Promise<WhatsAppSignupResult> {
  const options = whatsappLoginOptions(start);
  if (!window.FB) return Promise.reject(new Error('Prepare the Meta connection first.'));
  return new Promise((resolve, reject) => {
    let code: string | null = null;
    let asset: { businessAccountId: string; phoneNumberId: string } | null = null;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); signal.removeEventListener('abort', onAbort); };
    const fail = (message: string) => { if (settled) return; settled = true; cleanup(); reject(new Error(message)); };
    const finish = () => { if (settled || !code || !asset) return; settled = true; cleanup(); resolve({ code, ...asset }); };
    const onAbort = () => fail('WhatsApp installation cancelled.');
    const onMessage = (event: MessageEvent) => {
      if (settled || !['https://www.facebook.com', 'https://web.facebook.com'].includes(event.origin)) return;
      asset = parseWhatsAppFinish(event.origin, event.data) ?? asset;
      if (asset) { finish(); return; }
      try {
        if (typeof event.data !== 'string' || event.data.length > 8192) return;
        const data = JSON.parse(event.data);
        if (data?.type === 'WA_EMBEDDED_SIGNUP' && ['CANCEL', 'ERROR'].includes(data?.event)) fail('WhatsApp installation was not completed.');
      } catch { /* Ignore unrelated provider events. */ }
    };
    const timer = setTimeout(() => fail('WhatsApp installation timed out. Start again.'), 120000);
    window.addEventListener('message', onMessage); signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    try {
      window.FB!.login((response) => {
        const value = response.authResponse?.code;
        if (typeof value !== 'string' || !value.length || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) {
          fail('WhatsApp installation was not completed.'); return;
        }
        code = value; finish();
      }, options);
    } catch { fail('Meta could not open the installation window. Allow popups and try again.'); }
  });
}