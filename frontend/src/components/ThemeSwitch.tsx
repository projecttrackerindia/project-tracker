import { useRef } from 'react';
import { useUi } from '../stores/ui';

const Sun = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" /></svg>
);
const Moon = ({ className }: { className: string }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 14.6A8.3 8.3 0 0 1 9.4 3.8a8.3 8.3 0 1 0 10.8 10.8Z" /></svg>
);

/**
 * Light / dark switch: a track with the sun at one end and the moon at the other; the knob slides to the open mode and carries its icon
 * (a warm sun by day, a cool moon with a few stars by night). Pressing it spreads the new theme over the page from the knob (see
 * applyTheme in stores/ui).
 */
export function ThemeSwitch({ className = '' }: { className?: string }) {
  const theme = useUi((s) => s.theme);
  const toggle = useUi((s) => s.toggleTheme);
  const knob = useRef<HTMLSpanElement>(null);
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';

  const press = () => {
    const r = knob.current?.getBoundingClientRect();
    toggle(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined);
  };

  return (
    <button type="button" role="switch" aria-checked={dark} aria-label={label} title={label} onClick={press}
      className={`theme-switch ${dark ? 'is-dark' : 'is-light'} ${className}`}>
      <span className="ts-track" aria-hidden="true">
        <Sun className="ts-end ts-end-sun" />
        <Moon className="ts-end ts-end-moon" />
        <span className="ts-stars"><i /><i /><i /></span>
      </span>
      <span className="ts-knob" ref={knob} aria-hidden="true">
        <Sun className="ts-k ts-k-sun" />
        <Moon className="ts-k ts-k-moon" />
      </span>
    </button>
  );
}
