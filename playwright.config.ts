import { defineConfig } from '@playwright/test';

// E2E使用构建后的真实服务（隔离临时数据目录），串行执行保证状态确定。
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3300',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/e2e/launch-server.mjs',
    url: 'http://127.0.0.1:3300/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
