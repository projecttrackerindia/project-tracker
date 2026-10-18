import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { publicSite } from './site/plugin';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:5080';

/**
 * Which build this is, so a tab that has been open since an earlier release can tell that a newer one is live (see src/lib/appUpdate.ts).
 * The id is a hash of the fingerprinted script and style file names, so it changes exactly when the app's code or styles do: rebuilding
 * the same code gives the same id (no needless "new version" prompt), and nothing is added to the scripts themselves (their cached copies
 * stay valid). It is written into index.html as <meta name="app-build"> - the build the page is running - and into /version.json, the
 * build the server has now (served with no-store, see nginx.conf).
 */
function buildVersion(): Plugin {
  return {
    name: 'pm-build-version',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const files = Object.keys(bundle).filter((f) => f.startsWith('assets/') && /\.(js|css)$/.test(f)).sort();
        const build = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
        const html = bundle['index.html'];
        if (html?.type === 'asset') {
          const source = typeof html.source === 'string' ? html.source : new TextDecoder().decode(html.source);
          html.source = source.replace(/<head>/i, `<head>\n    <meta name="app-build" content="${build}" />`);
        }
        this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ build })}\n` });
      },
    },
  };
}

/**
 * The libraries every page needs, each in a file of its own: they change far less often than the app, so a release does not make every
 * visitor download React, the router and the query cache again.
 */
const vendorGroups = [
  // zustand too: every store uses it, and on its own it is a leaf, so no app chunk ever waits on another one just to create a store.
  { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler|zustand|use-sync-external-store)[\\/]/, priority: 30 },
  { name: 'vendor-router', test: /[\\/]node_modules[\\/](react-router|react-router-dom|cookie|set-cookie-parser)[\\/]/, priority: 20 },
  { name: 'vendor-query', test: /[\\/]node_modules[\\/]@tanstack[\\/]/, priority: 20 },
];

export default defineConfig({
  plugins: [react(), publicSite(), buildVersion()],
  server: {
    port: 5173,
    // Same-origin in development, so the HttpOnly refresh cookie works exactly as it does behind the production reverse proxy.
    proxy: { '/api': { target: api, changeOrigin: false }, '/hubs': { target: api, changeOrigin: false, ws: true } },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // Strict execution order: the app's modules import each other in a circle (the API client, the stores and the shared UI), and once
    // they are split over several files a file could otherwise run before one it depends on has finished ("x is not a function" at start).
    rolldownOptions: { output: { codeSplitting: { groups: vendorGroups }, strictExecutionOrder: true } },
  },
});
