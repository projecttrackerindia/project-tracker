import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';
import './styles/chat.css';
import './styles/auth.css';
import './styles/celebrate.css';
import './styles/dark.css';
import './styles/theme.css';
import App from './App';
import { queryClient } from './stores/auth';
import { useUi } from './stores/ui';

document.documentElement.setAttribute('data-theme', useUi.getState().theme);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
