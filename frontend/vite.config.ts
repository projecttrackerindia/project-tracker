import { createHash } from 'node:crypto';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
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
 * The splash in index.html paints from the first bytes of the page: the app's stylesheets are moved from <head> to just after it in
 * <body> (where the build leaves <!--pt:styles-->). A stylesheet in the body holds back only what comes after it, so the splash is on
 * screen at once while the app (#root, and the scripts, which wait for the stylesheets before them) still never shows unstyled.
 */
function stylesAfterSplash(): Plugin {
  let patched = false;
  return {
    name: 'pm-styles-after-splash',
    apply: 'build',
    // Vite's loader adds each page's stylesheet with document.head.appendChild: with the app's own stylesheets now in <body>, a page's
    // stylesheet would land ahead of them and lose to them. It is appended to <body> instead, after them, as before.
    // (renderChunk, so the file's fingerprint reflects the change and a cached copy of the old helper is never reused.)
    renderChunk(code) {
      const end = code.indexOf('Unable to preload CSS');
      if (end < 0) return null;
      const at = code.lastIndexOf('document.head.appendChild(', end);
      if (at < 0 || end - at > 600) this.error('pm-styles-after-splash: Vite\'s CSS preload helper changed; page stylesheets would load ahead of the app\'s.');
      patched = true;
      return { code: `${code.slice(0, at)}document.body.appendChild(${code.slice(at + 'document.head.appendChild('.length)}`, map: null };
    },
    generateBundle() {
      if (!patched) this.error('pm-styles-after-splash: Vite\'s CSS preload helper was not found; page stylesheets would load ahead of the app\'s.');
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!html.includes('<!--pt:styles-->')) return html;
        const links: string[] = [];
        const head = html.slice(0, html.indexOf('</head>')).replace(/[ \t]*<link rel="stylesheet"[^>]*>\n?/g, (m) => { links.push(m.trim()); return ''; });
        return head + html.slice(html.indexOf('</head>')).replace('<!--pt:styles-->', links.join('\n    '));
      },
    },
  };
}

/**
 * Every fingerprinted script and stylesheet is also written pre-compressed at gzip's highest level (file.js.gz), which nginx sends as is
 * (gzip_static in nginx.conf): smaller than compressing on the fly, and no CPU spent on it per request. Caddy in front passes an
 * already-encoded answer through untouched.
 */
function precompress(): Plugin {
  return {
    name: 'pm-precompress',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        for (const [name, file] of Object.entries(bundle)) {
          if (!name.startsWith('assets/') || !/\.(js|css|svg|json)$/.test(name)) continue;
          const body = file.type === 'chunk' ? file.code : file.source;
          const raw = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
          if (raw.length < 1024) continue;
          this.emitFile({ type: 'asset', fileName: `${name}.gz`, source: gzipSync(raw, { level: zlibConstants.Z_BEST_COMPRESSION }) });
        }
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
  plugins: [react(), publicSite(), stylesAfterSplash(), buildVersion(), precompress()],
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
