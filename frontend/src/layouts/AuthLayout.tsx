import { useEffect, type ReactNode } from 'react';
import { useUi } from '../stores/ui';
import { BrandMark } from '../components/BrandMark';
import { AuthVisual } from '../components/AuthVisual';
import { ToastRoot } from '../components/ui';
import { PlatformBanner } from '../components/PlatformBanner';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { SUPPORT_EMAIL, supportMailto } from '../lib/support';
import './auth-calm.css';

/**
 * Sign-in, sign-up and the other account screens follow the system's light or dark setting until the person picks one with the switch
 * (the choice is then saved and wins, as everywhere else). Nothing is saved here, and leaving these screens returns to the app's default.
 */
function useSystemTheme() {
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem('pm_theme'); } catch { /* storage unavailable */ }
    if (saved === 'light' || saved === 'dark' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      try { if (localStorage.getItem('pm_theme')) return; } catch { /* storage unavailable */ }
      const t = mq.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
      useUi.setState({ theme: t });
    };
    apply();
    mq.addEventListener?.('change', apply);
    return () => {
      mq.removeEventListener?.('change', apply);
      let chosen: string | null = null;
      try { chosen = localStorage.getItem('pm_theme'); } catch { /* storage unavailable */ }
      if (!chosen) { document.documentElement.setAttribute('data-theme', 'light'); useUi.setState({ theme: 'light' }); }
    };
  }, []);
}

/** The calm sign-in panel (shot 31): the brand, one large sentence, and a quiet line. No numbers are shown before sign-in. */
function CalmAuthPanel() {
  return (
    <aside className="auth-calm-panel" aria-hidden="true">
      <div className="acp-brand"><span className="acp-mark"><BrandMark size={22} /></span>ProjectTracker</div>
      <h2>Your work,<em>calmly in one place.</em></h2>
      <p>Projects, desk, meetings and your day, with Aura beside you.</p>
    </aside>
  );
}

export function AuthLayout({ title, second, sub, children, footer, shake, calm }: { title: string; second?: string; sub?: string; children: ReactNode; footer?: ReactNode; shake?: boolean; calm?: boolean }) {
  useSystemTheme();
  return (
    <div className={`auth-shell auth-split${calm ? ' auth-calm' : ''}`}>
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
      {calm ? <CalmAuthPanel /> : <AuthVisual />}
      <div className="auth-wrap">
        <span className="auth-glow" aria-hidden="true" />
        <div className={`auth-card ${shake ? 'shake' : ''}`}>
          <span className="auth-beam" aria-hidden="true" />
          <div className="auth-brand">
            <div className="brand-mark"><BrandMark /></div>
            <div><strong>ProjectTracker</strong><span>Project management</span></div>
          </div>
          <h1 className="auth-title">{title}{second && <em>{second}</em>}</h1>
          {sub && <p className="auth-sub">{sub}</p>}
          {children}
          {footer && <div className="auth-foot">{footer}</div>}
          <p className="auth-help">Need help? <a href={supportMailto('Help with Project Tracker')}>{SUPPORT_EMAIL}</a></p>
        </div>
      </div>
      <ToastRoot />
    </div>
  );
}
