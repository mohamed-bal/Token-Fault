import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env['TOKENFAULT_URL'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
  // Served by the TokenFault proxy under this prefix.
  base: '/__tokenfault/studio/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // The CSP forbids inline scripts; keep every asset as a file.
    assetsInlineLimit: 0,
  },
  server: {
    // Development only: forward the control API to a running `tokenfault proxy`.
    // The browser Origin is removed because the control API only accepts
    // same-origin writes (the Vite dev server is a different origin).
    proxy: {
      '/__tokenfault/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.removeHeader('origin'));
        },
      },
    },
  },
});
