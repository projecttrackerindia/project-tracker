import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/account.css';
import './styles/enterprise.css';
import './styles/advanced.css';
import './styles/chat.css';
import './styles/auth.css';
import './styles/celebrate.css';
import './styles/dark.css';
import './styles/ai.css';
import './styles/theme.css';
import './styles/org.css';
import './styles/documents.css';
import './styles/reminders.css';
import './styles/mobile.css';
import './styles/phone.css';
import './styles/desktop.css';
import App from './App';
import { queryClient } from './stores/auth';
import { useUi } from './stores/ui';
import './lib/pwa';
import { startResponsiveTables } from './lib/responsiveTables';
import { startNativeApp } from './lib/native';
import { startDesktopApp } from './lib/desktop';

startNativeApp();
startDesktopApp();

document.documentElement.setAttribute('data-theme', useUi.getState().theme);

// The installable app: the service worker lets it start offline and receive push notifications (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => undefined); });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

startResponsiveTables();
