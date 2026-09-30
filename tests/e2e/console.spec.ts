// E2E全局：页面无未处理控制台异常（AC32）；重建数据状态在每个spec独立seed。
import { test, expect } from '@playwright/test';

test('AC32：主要页面遍历无未处理控制台错误/页面异常', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  for (const route of ['/#/', '/#/orders/new', '/#/apply', '/#/maintenance']) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
  }
  // 允许favicon等资源缺失？严格：不允许任何console.error
  expect(errors, errors.join('\n')).toEqual([]);
});
