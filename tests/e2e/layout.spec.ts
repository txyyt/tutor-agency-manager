import { expect, test } from '@playwright/test';
import { seedApplication, seedOrder, UiClient } from './helpers.js';

test('现代工作台：不同窗口宽度下主要页面不溢出，导航与操作仍可访问', async ({ page, request }) => {
  const client = new UiClient(request);
  await client.bootstrap();
  const order = await seedOrder(client);
  const application = await seedApplication(client, order.id);
  const routes = ['/', '/orders/new', '/apply', `/orders/${order.id}`, `/applications/${application.id}`, `/applications/${application.id}/edit`, '/maintenance'];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of routes) {
      await page.goto(`/#${route}`);
      await page.waitForLoadState('networkidle');
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
      const dimensions = await page.evaluate('({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth })') as { viewport: number; page: number };
      expect(dimensions.page, `${route} 在 ${width}px 不应产生整个页面的横向滚动`).toBeLessThanOrEqual(dimensions.viewport + 1);
    }
  }
  await page.goto('/#/');
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: test.info().outputPath('10-dashboard-mobile.png'), fullPage: true });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '老师报名' }).click();
  await expect(page).toHaveURL(/#\/apply$/);
  await expect(page.getByRole('button', { name: '查询订单' })).toBeVisible();
});
