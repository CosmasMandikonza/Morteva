import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke: builds must exist first (`npm run build` / `npm run test:e2e`).
 * The API runs from compiled dist; the web shell from vite preview — both
 * exercised exactly as a cold checkout would run them.
 *
 * Ports are overridable so parallel checkouts (or another agent session on
 * the same machine) cannot collide: MTV_WEB_PORT / MTV_API_PORT. CI keeps
 * the canonical defaults.
 */
const webPort = Number(process.env.MTV_WEB_PORT ?? 4173);
const apiPort = Number(process.env.MTV_API_PORT ?? 8787);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${String(webPort)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Seeded throwaway ledger + DEMO_AUTH gate so browser tests exercise
      // the real authenticated journey. Requires `npm run build` first.
      command: 'node e2e/scripts/demo-auth-server.mjs',
      url: `http://127.0.0.1:${String(apiPort)}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { ...process.env, PORT: String(apiPort) },
    },
    {
      command: `npm run preview -w @moterva/web -- --port ${String(webPort)} --strictPort`,
      url: `http://127.0.0.1:${String(webPort)}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // The preview server proxies /api to the backend; keep both ports in
      // lockstep when MTV_API_PORT overrides the default.
      env: { ...process.env, MOTERVA_API_URL: `http://127.0.0.1:${String(apiPort)}` },
    },
    {
      // Identity stack (one supervising script: API :8788 + local test IdP
      // :18995 + SPA preview :4174 pointed at THAT API via MOTERVA_API_URL).
      command: 'node e2e/scripts/identity-server.mjs',
      url: 'http://127.0.0.1:4174/',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
