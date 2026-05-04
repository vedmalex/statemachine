import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: '**/browser-smoke.spec.ts',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    // Required for file:// URL ESM module loading; without these flags Chromium
    // blocks `<script type="module" src="../dist/index.js">` over file://.
    launchOptions: {
      args: ['--allow-file-access-from-files', '--allow-file-access', '--disable-web-security'],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
