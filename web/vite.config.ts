// UI build. In dev: a proxy to the server on 7460; Origin is rewritten to the server's
// address because the server checks the Origin of mutating requests against BRAIN_ORIGIN (CSRF).
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const target = process.env.BRAIN_ORIGIN ?? 'http://127.0.0.1:7460';

/**
 * The CSP (`default-src 'self'`, no 'unsafe-inline') blocks <style> elements. style-mod
 * (CodeMirror's styles) uses adoptedStyleSheets in a shadow root but <style> in the document, so the editor
 * ends up without its base theme. CSP does not restrict constructable stylesheets: the plugin enables
 * them for the document too. If a new style-mod version lacks the pattern, the build fails rather than quietly breaking
 * the editor (the smoke also checks that there are no CSP violations and that the theme applied).
 */
function styleModAdoptedSheets(): Plugin {
  const from = 'if (!root.head && root.adoptedStyleSheets && win.CSSStyleSheet) {';
  const to = 'if (root.adoptedStyleSheets && win.CSSStyleSheet) {';
  return {
    name: 'brain-style-mod-adopted-sheets',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]style-mod[\\/]src[\\/]style-mod\.js$/.test(id)) return null;
      if (!code.includes(from)) this.error('style-mod changed: the adoptedStyleSheets patch for CSP no longer applies (vite.config.ts)');
      return { code: code.replace(from, to), map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), styleModAdoptedSheets()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // No inline scripts or data: modules: the server's CSP is `default-src 'self'`.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // CodeMirror (~210 KB gzip) is a separate lazy editor chunk; reading doesn't load it.
    chunkSizeWarningLimit: 700,
  },
  server: {
    proxy: {
      '/api': {
        target,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            if (req.getHeader('origin') !== undefined) req.setHeader('origin', target);
          });
        },
      },
    },
  },
});
