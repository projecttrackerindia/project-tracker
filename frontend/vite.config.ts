import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:5080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in development, so the HttpOnly refresh cookie works exactly as it does behind the production reverse proxy.
    proxy: { '/api': { target: api, changeOrigin: false }, '/hubs': { target: api, changeOrigin: false, ws: true } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
