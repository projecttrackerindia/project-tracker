import type { ReactNode } from 'react';
import { BrandMark } from '../components/BrandMark';
import { AuthVisual } from '../components/AuthVisual';
import { ToastRoot } from '../components/ui';
import { PlatformBanner } from '../components/PlatformBanner';
import { ThemeSwitch } from '../components/ThemeSwitch';

export function AuthLayout({ title, sub, children, footer, shake }: { title: string; sub?: string; children: ReactNode; footer?: ReactNode; shake?: boolean }) {
  return (
    <div className="auth-shell auth-split">
      <div className="auth-bg" aria-hidden="true">
        <span className="auth-blob b1" />
        <span className="auth-blob b2" />
        <span className="auth-blob b3" />
        <span className="auth-blob b4" />
        <span className="auth-grid" />
        <span className="auth-grain" />
      </div>
      <PlatformBanner />
      <ThemeSwitch className="auth-theme-btn" />
      <AuthVisual />
      <div className="auth-wrap">
        <span className="auth-glow" aria-hidden="true" />
        <div className={`auth-card ${shake ? 'shake' : ''}`}>
          <span className="auth-beam" aria-hidden="true" />
          <div className="auth-brand">
            <div className="brand-mark"><BrandMark /></div>
            <div><strong>Projects</strong><span>Project management</span></div>
          </div>
          <h1 className="auth-title">{title}</h1>
          {sub && <p className="auth-sub">{sub}</p>}
          {children}
          {footer && <div className="auth-foot">{footer}</div>}
        </div>
      </div>
      <ToastRoot />
    </div>
  );
}
