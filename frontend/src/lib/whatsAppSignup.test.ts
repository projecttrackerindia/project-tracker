import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchWhatsAppSignup, parseWhatsAppFinish, whatsappLoginOptions } from './whatsAppSignup';
const start = { state: 'A'.repeat(64), appId: '123456789', configId: '987654321', apiVersion: 'v24.0', signupVersion: 'v4' as const };
const payload = JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: '1234', phone_number_id: '5678' } });
afterEach(() => { vi.unstubAllGlobals(); });
describe('WhatsApp signup boundary', () => {
  it.each(['https://facebook.com.attacker.example', 'https://evilfacebook.com', 'http://www.facebook.com', 'null'])('rejects an untrusted message origin %s', (origin) => {
    expect(parseWhatsAppFinish(origin, payload)).toBeNull();
  });
  it('accepts only exact provider origins with bounded completed asset IDs', () => {
    expect(parseWhatsAppFinish('https://www.facebook.com', payload)).toEqual({ businessAccountId: '1234', phoneNumberId: '5678' });
    expect(parseWhatsAppFinish('https://web.facebook.com', payload)).not.toBeNull();
    expect(parseWhatsAppFinish('https://www.facebook.com', '{')).toBeNull();
    expect(parseWhatsAppFinish('https://www.facebook.com', 'x'.repeat(8193))).toBeNull();
    expect(parseWhatsAppFinish('https://www.facebook.com', payload.replace('FINISH', 'CANCEL'))).toBeNull();
    expect(parseWhatsAppFinish('https://www.facebook.com', payload.replace('1234', '../foreign'))).toBeNull();
  });
  it('requests an authorization code and explicitly configured flow version', () => {
    expect(whatsappLoginOptions(start)).toEqual({ config_id: start.configId, response_type: 'code', override_default_response_type: true,
      extras: { sessionInfoVersion: '3', version: 'v4' } });
    expect(() => whatsappLoginOptions({ ...start, apiVersion: '../evil' })).toThrow();
  });
  it.each(['code-first', 'event-first'])('joins only the current SDK code and trusted completion in %s order', async (order) => {
    const events = new EventTarget(); let callback: (response: { authResponse?: { code?: string } }) => void = () => {};
    vi.stubGlobal('window', { FB: { login: (cb: typeof callback) => { callback = cb; } },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    const message = (origin: string) => events.dispatchEvent(Object.assign(new Event('message'), { origin, data: payload }));
    const promise = launchWhatsAppSignup(start, new AbortController().signal);
    message('https://evilfacebook.com');
    if (order === 'code-first') { callback({ authResponse: { code: 'one-use-code' } }); message('https://www.facebook.com'); }
    else { message('https://www.facebook.com'); callback({ authResponse: { code: 'one-use-code' } }); }
    expect(await promise).toEqual({ code: 'one-use-code', businessAccountId: '1234', phoneNumberId: '5678' });
    message('https://www.facebook.com'); // Settled listener has been removed.
  });
  it.each(['\u0000code', 'code\u001f', 'code\u007f', 'x'.repeat(2001)])('rejects invalid SDK authorization codes', async (code) => {
    const events = new EventTarget(); let callback: (response: { authResponse?: { code?: string } }) => void = () => {};
    vi.stubGlobal('window', { FB: { login: (cb: typeof callback) => { callback = cb; } },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    const result = launchWhatsAppSignup(start, new AbortController().signal);
    const rejection = expect(result).rejects.toThrow('not completed'); callback({ authResponse: { code } }); await rejection;
  });
  it('aborts stale workspace flows without producing an installation result', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', { FB: { login: () => {} }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    const controller = new AbortController(); const result = launchWhatsAppSignup(start, controller.signal);
    const rejection = expect(result).rejects.toThrow('cancelled'); controller.abort(); await rejection;
  });
});