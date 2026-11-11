import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/ui',
  timeout: 120000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
