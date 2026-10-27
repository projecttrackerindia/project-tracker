/** Settings › Notifications › Live banners: on unless switched off on this device. */
const LIVE_BANNERS_KEY = 'pm_live_banners';
export function liveBannersOn(): boolean { try { return localStorage.getItem(LIVE_BANNERS_KEY) !== 'off'; } catch { return true; } }
export function setLiveBanners(on: boolean) { try { localStorage.setItem(LIVE_BANNERS_KEY, on ? 'on' : 'off'); } catch { /* private window */ } }

