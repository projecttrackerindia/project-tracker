import './lib/trustedTypesInit';
import { loadLateStylesSoon, whenSettled } from './lib/lateStyles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installStableTabs } from './lib/stableTabs';
import { installCapture } from './features/feedback/capture';
import { installKeyboardViewport } from './lib/keyboardViewport';
import { QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion } from 'framer-motion';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/account.css';
import './styles/advanced.css';
import './styles/auth.css';
import './styles/dark.css';
import './styles/ai.css';
import './styles/theme.css';
import './styles/alerts.css';
import './styles/mobile.css';
import './styles/phone.css';
import './styles/desktop.css';
import './styles/phone-keyboard.css';
import './styles/professional.css';
import './styles/futuristic.css';
import './styles/theme-pro.css';
import './styles/design-system.css';
import './styles/brand-fonts.css';
import './styles/calm.css';
import App from './App';
import { queryClient } from './stores/auth';
import { useUi } from './stores/ui';
import { ApiError } from './api/client';
import './lib/pwa';
import { InstallBanner } from './components/install/InstallBanner';
import { startResponsiveTables } from './lib/responsiveTables';
import { startNativeApp } from './lib/native';
import { startDesktopApp } from './lib/desktop';
import { startTelemetry } from './lib/telemetry';
import { startUpdateWatch, watchServiceWorker } from './lib/updateWatch';

startNativeApp();
startDesktopApp();
startTelemetry();

document.documentElement.setAttribute('data-theme', useUi.getState().theme);

// The installable app: the service worker lets it start offline and receive push notifications (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').then(watchServiceWorker).catch(() => undefined); });
}
// A tab left open across a release is told that a newer version is live (see lib/updateWatch.ts).
startUpdateWatch();

// A failed request nobody awaited would otherwise vanish silently: say so once (not once per retry).
let lastUnhandled = 0;
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { name?: string; message?: string; status?: number } | undefined;
  if (!reason || reason.name === 'AbortError' || reason.status === 401) return;
  console.error('Unhandled promise rejection', reason);
  if (reason instanceof ApiError && Date.now() - lastUnhandled > 10_000) {
    lastUnhandled = Date.now();
    useUi.getState().pushToast(reason.message || 'Something did not work. Try again.', 'error');
  }
});

// The public landing page ships inside index.html; in the signed-in app it is never shown, so take it out of the page altogether
// (no second <main>/<h1> for screen readers, nothing hidden to lay out).
if (document.documentElement.classList.contains('app')) document.getElementById('site')?.remove();

installStableTabs();
installCapture();
installKeyboardViewport();
// The animation engine follows the first screen (see whenSettled), so on a slow phone its bytes never queue ahead of the page's own.
// Until then elements show in their resting state.
const loadMotion = () => new Promise<void>((resolve) => whenSettled(resolve)).then(() => import('./lib/motionFeatures')).then((m) => m.default);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LazyMotion features={loadMotion}>
      <QueryClientProvider client={queryClient}>
        <App />
        <InstallBanner />
      </QueryClientProvider>
    </LazyMotion>
  </StrictMode>,
);

loadLateStylesSoon();
startResponsiveTables();
