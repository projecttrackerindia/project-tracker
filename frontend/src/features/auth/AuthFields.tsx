import { forwardRef, useCallback, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';

/** Shakes the card briefly — for a failed client-side validation or a rejected submit. */
export function useShake() {
  const [shaking, setShaking] = useState(false);
  const shake = useCallback(() => {
    setShaking(true);
    window.setTimeout(() => setShaking(false), 520);
  }, []);
  return [shaking, shake] as const;
}

interface FloatingFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  icon: IconName;
  label: string;
  error?: string;
  /** Extra content inside the field, after the input (e.g. the password reveal button). */
  right?: ReactNode;
  /** Extra content below the field, above the error message (e.g. a Caps Lock hint). */
  note?: ReactNode;
}

/** A single floating-label field: icon, input, label that rises once there is a value, and an animated error line. */
export const FloatingField = forwardRef<HTMLInputElement, FloatingFieldProps>(function FloatingField(
  { icon, label, error, right, note, id, ...rest },
  ref,
) {
  return (
    <div className="auth-group">
      <div className={`auth-field ${error ? 'invalid' : ''}`}>
        <span className="auth-icon" aria-hidden="true"><Icon name={icon} size={19} /></span>
        <input ref={ref} id={id} placeholder=" " aria-invalid={error ? true : undefined} {...rest} />
        <label htmlFor={id}>{label}</label>
        {right}
      </div>
      {note}
      <p className={`auth-error ${error ? 'show' : ''}`} role="alert"><span>{error}</span></p>
    </div>
  );
});

/** A password field: everything FloatingField has, plus a show/hide toggle and a Caps Lock warning. */
export const PasswordField = forwardRef<HTMLInputElement, Omit<FloatingFieldProps, 'icon' | 'type' | 'right' | 'note'>>(
  function PasswordField({ id, onKeyDown, onKeyUp, onBlur, ...rest }, ref) {
    const [revealed, setRevealed] = useState(false);
    const [caps, setCaps] = useState(false);
    const refocus = useRef(false);
    const inputId = id ?? 'password';

    // Toggling `type` on an already-focused input can reset the browser's cursor position; restore it synchronously,
    // right after the DOM commits the new type, so nothing can be typed in the wrong place in between.
    useLayoutEffect(() => {
      if (!refocus.current) return;
      refocus.current = false;
      const el = document.getElementById(inputId) as HTMLInputElement | null;
      if (!el) return;
      el.focus();
      const pos = el.value.length;
      try { el.setSelectionRange(pos, pos); } catch { /* some input types do not support range selection */ }
    }, [revealed, inputId]);

    const trackCaps = (e: KeyboardEvent<HTMLInputElement>) => {
      if (typeof e.getModifierState === 'function') setCaps(e.getModifierState('CapsLock'));
    };

    return (
      <FloatingField
        {...rest}
        ref={ref}
        id={inputId}
        icon="lock"
        type={revealed ? 'text' : 'password'}
        onKeyDown={(e) => { onKeyDown?.(e); trackCaps(e); }}
        onKeyUp={(e) => { onKeyUp?.(e); trackCaps(e); }}
        onBlur={(e) => { onBlur?.(e); setCaps(false); }}
        note={
          <p className={`auth-caps ${caps ? 'show' : ''}`} aria-hidden={!caps}>
            <span><Icon name="alert" size={14} />Caps Lock is on</span>
          </p>
        }
        right={
          <button type="button" className="auth-toggle" tabIndex={-1} aria-pressed={revealed}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            onClick={() => { refocus.current = true; setRevealed((v) => !v); }}>
            <Icon name={revealed ? 'eyeOff' : 'eye'} size={18} />
          </button>
        }
      />
    );
  },
);

/** The primary submit button: a loading spinner in place of the label, and a ripple from wherever it was pressed. */
export function AuthSubmitButton({ busy, children }: { busy?: boolean; children: ReactNode }) {
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (busy) return;
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2.2;
    const ripple = document.createElement('span');
    ripple.className = 'auth-ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 640);
  };
  return (
    <button type="submit" className={`auth-submit ${busy ? 'loading' : ''}`} disabled={busy} onPointerDown={onPointerDown}>
      <span className="label">{children}</span>
      <span className="auth-spinner" aria-hidden="true" />
    </button>
  );
}

/** Replaces the whole card for a moment after a successful sign-in, so leaving the page reads as a deliberate
 * handoff rather than an abrupt jump-cut into the app. */
export function AuthSuccessOverlay({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="auth-success-overlay" role="status">
      <div className="auth-success-badge">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 12l5 5L20 6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="auth-success-title">{title}</div>
      {sub && <div className="auth-success-sub">{sub}</div>}
    </div>
  );
}
