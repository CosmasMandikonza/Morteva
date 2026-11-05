import { defineConfig, devices } from '@playwright/test';

/**
 * E2E smoke: builds must exist first (`npm run build` / `npm run test:e2e`).
 * The API runs from compiled dist; the web shell from vite preview — both
 * exercised exactly as a cold checkout would run them.
 */
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
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Seeded throwaway ledger + DEMO_AUTH gate so browser tests exercise
      // the real authenticated journey. Requires `npm run build` first.
      command: 'node e2e/scripts/demo-auth-server.mjs',
      url: 'http://127.0.0.1:8787/healthz',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run preview -w @moterva/web -- --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
