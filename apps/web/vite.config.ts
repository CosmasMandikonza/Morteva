import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev and preview the browser talks same-origin; the dev/preview server
// proxies API paths to the Fastify backend, so no provider or API URL is
// exposed to the client bundle.
const apiTarget = process.env.MOTERVA_API_URL ?? 'http://127.0.0.1:8787';
const proxy = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/healthz': { target: apiTarget, changeOrigin: true },
} as const;

// MTV-08 design lab (issue #10): the experimental founder-preview entry is
// included in build output ONLY when VITE_DESIGN_LAB=1 (research/CI runs).
// Default production builds exclude it entirely; the shipped shell is
// untouched.
const designLab = process.env.VITE_DESIGN_LAB === '1';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: designLab ? { main: 'index.html', lab: 'design-lab.html' } : { main: 'index.html' },
    },
  },
  // Bind IPv4 explicitly: 'localhost' may resolve to ::1 on some hosts, which
  // breaks 127.0.0.1 health checks (Playwright webServer, CI).
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
