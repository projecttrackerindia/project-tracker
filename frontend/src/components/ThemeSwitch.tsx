import { useRef } from 'react';
import { useUi } from '../stores/ui';

/**
 * Light / dark switch: a small sky that turns from day to night. The knob is the sun or the moon and slides across; stars come out at
 * night, clouds drift by in the day. Pressing it spreads the new theme over the page from the knob (see applyTheme in stores/ui).
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
        <span className="ts-stars"><i /><i /><i /><i /><i /><i /></span>
        <span className="ts-clouds"><i /><i /></span>
      </span>
      <span className="ts-knob" ref={knob} aria-hidden="true">
        <span className="ts-rays" />
        <span className="ts-face"><i /><i /><i /></span>
      </span>
    </button>
  );
}
