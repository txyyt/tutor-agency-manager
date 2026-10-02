import { expect, test } from '@playwright/test';
import { seedApplication, seedOrder, UiClient } from './helpers.js';

test('窄桌面窗口的附件弹窗按钮不被侧栏遮挡', async ({ page, request }) => {
  const client = new UiClient(request);
  await client.bootstrap();
  const order = await seedOrder(client);
  const application = await seedApplication(client, order.id);
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.goto(`/#/applications/${application.id}`);
  await page.locator('input[type="file"]').setInputFiles('tests/fixtures/acceptance/attachments/acceptance-resume.pdf');
  await page.getByRole('button', { name: '上传所选文件' }).click();
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '附件预览', exact: true });
  const link = modal.getByRole('link', { name: '打开原文件', exact: true });
  await expect(link).toBeVisible();
  await expect.poll(() => link.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('a') === element;
  })).toBe(true);
  await link.click();
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(modal).toHaveCount(0);
});

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
