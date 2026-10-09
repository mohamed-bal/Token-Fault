import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['TOKENFAULT_E2E_PORT'] ?? 8790);

/**
 * End-to-end tests drive the real Studio against a real `tokenfault proxy --mock`
 * (built CLI). Run `pnpm build` first. No external network access is needed.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  timeout: 60_000,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node packages/cli/dist/bin.js proxy --mock --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__tokenfault/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
