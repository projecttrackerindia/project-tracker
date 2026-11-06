/**
 * The splash in index.html covers the page from its first byte until the first real screen has painted, so loading never shows a blank
 * page or a string of different spinners. index.html ends it by itself once #root holds something that is not a loading state; this is
 * for a loading state that has something to say ("still connecting", "you are offline"). Only the first call fades it out.
 */
export function firstScreenPainted() {
  if (typeof window === 'undefined') return;
  const done = (window as Window & { __ptSplashDone?: () => void }).__ptSplashDone;
  if (!done) return;
  done();
}
