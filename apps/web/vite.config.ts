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
// MTV-09/12 mission viewer (issue #11/#14): the standalone harness entry uses
// the same isolation pattern, gated behind VITE_MISSION_VIEWER=1, so the
// default production build stays byte-identical to main's and the three.js
// dependency never enters the shipped shell bundle.
const missionViewer = process.env.VITE_MISSION_VIEWER === '1';

export default defineConfig({
  plugins: [react()],
  // With the lab disabled, rollupOptions is omitted entirely so the default
  // build's entry naming and hashes are indistinguishable from main's
  // (verified: byte-identical JS/CSS/HTML against an origin/main build).
  ...(designLab || missionViewer
    ? {
        build: {
          rollupOptions: {
            input: {
              main: 'index.html',
              ...(designLab ? { lab: 'design-lab.html' } : {}),
              ...(missionViewer ? { missionViewer: 'mission-viewer.html' } : {}),
            },
          },
        },
      }
    : {}),
  // Bind IPv4 explicitly: 'localhost' may resolve to ::1 on some hosts, which
  // breaks 127.0.0.1 health checks (Playwright webServer, CI).
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
});
