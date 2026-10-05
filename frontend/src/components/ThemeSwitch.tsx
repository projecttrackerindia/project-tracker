import { useRef } from 'react';
import { useUi } from '../stores/ui';

/**
 * Light / dark switch: a compact two-position control with a sun and a moon; a thumb slides under the one in use. Pressing it spreads the new
 * theme over the page from the thumb (see applyTheme in stores/ui). It is a real switch for assistive technology: one control, its state
 * and its action spelled out.
 */
export function ThemeSwitch({ className = '' }: { className?: string }) {
  const theme = useUi((s) => s.theme);
  const toggle = useUi((s) => s.toggleTheme);
  const thumb = useRef<HTMLSpanElement>(null);
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';

  const press = () => {
    const r = thumb.current?.getBoundingClientRect();
    toggle(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
  };

  return (
    <button type="button" role="switch" aria-checked={dark} aria-label={label} title={label} onClick={press}
      className={`theme-switch ${dark ? 'is-dark' : 'is-light'} ${className}`}>
      <span className="ts-thumb" ref={thumb} aria-hidden="true" />
      <svg className="ts-icon ts-sun" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <svg className="ts-icon ts-moon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  );
}
