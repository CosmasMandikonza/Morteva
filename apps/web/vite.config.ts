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

export default defineConfig({
  plugins: [react()],
  // Bind IPv4 explicitly: 'localhost' may resolve to ::1 on some hosts, which
  // breaks 127.0.0.1 health checks (Playwright webServer, CI).
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
