import { expect, test } from '@playwright/test';
import { seedApplication, seedOrder, UiClient } from './helpers.js';

test('菜单切换置顶，同页操作保留位置，项目返回恢复异步详情位置', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const order = await seedOrder(client); const app = await seedApplication(client, order.id);
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/#/orders/new');
  await page.waitForLoadState('networkidle');
  for (const label of ['老师报名', '清理与备份', '新建订单']) {
    await page.evaluate("window.scrollTo(0, 450)");
    await expect.poll(() => page.evaluate<number>("window.scrollY")).toBeGreaterThan(100);
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(0);
    await page.waitForLoadState('networkidle');
    await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(0);
  }
  await page.goto(`/#/orders/${order.id}`); await page.waitForLoadState('networkidle');
  await page.evaluate("window.scrollTo(0, 400)");
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(400);
  await page.getByRole('link', { name: app.applicationNo, exact: true }).evaluate((link: { click: () => void }) => link.click());
  await page.waitForURL(new RegExp(`#/applications/${app.id}$`));
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(0);
  // 模拟较慢的订单详情，验证不是只在加载占位出现时恢复一次。
  await page.route(`**/api/orders/${order.id}`, async route => { await new Promise(resolve => setTimeout(resolve, 350)); await route.continue(); });
  await page.getByRole('button', { name: '← 返回上一页' }).click();
  await page.waitForURL(new RegExp(`#/orders/${order.id}$`));
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(400);
  await page.locator('input[type="checkbox"]').first().evaluate((input: { click: () => void }) => input.click());
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(400);
});

test('浏览器返回恢复位置，重新点击菜单进入同一页面仍从顶部开始', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/#/orders/new'); await page.waitForLoadState('networkidle');
  await page.evaluate("window.scrollTo(0, 500)");
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(500);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '老师报名', exact: true }).click();
  await expect(page).toHaveURL(/#\/apply$/);
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(0);
  await page.goBack(); await expect(page).toHaveURL(/#\/orders\/new$/);
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(500);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '老师报名', exact: true }).click();
  await expect(page).toHaveURL(/#\/apply$/);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '新建订单', exact: true }).click();
  await expect(page).toHaveURL(/#\/orders\/new$/);
  await expect.poll(() => page.evaluate<number>("window.scrollY")).toBe(0);
});

test('浏览器与项目返回混用不跳回前进页', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  await page.goto('/#/orders/new');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('link', { name: '老师报名', exact: true }).click();
  await expect(page).toHaveURL(/#\/apply$/);
  await nav.getByRole('link', { name: '清理与备份', exact: true }).click();
  await expect(page).toHaveURL(/#\/maintenance$/);
  await page.goBack(); await expect(page).toHaveURL(/#\/apply$/);
  await page.getByRole('button', { name: '← 返回上一页' }).click();
  await expect(page).toHaveURL(/#\/orders\/new$/);
  await page.goForward(); await expect(page).toHaveURL(/#\/apply$/);
});

test('订单和老师表单切换菜单前确认，取消保留内容，确认后才离开', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const order = await seedOrder(client);
  for (const [route, label] of [['/orders/new', '家长称呼'], [`/orders/${order.id}/apply`, '姓名']]) {
    await page.goto(`/#${route}`); await page.waitForLoadState('networkidle');
    const input = page.locator('.field', { hasText: label }).locator('input');
    await input.fill('未保存测试');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '清理与备份', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '放弃未保存的修改？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(new URL(page.url()).hash).toBe(`#${route}`); await expect(input).toHaveValue('未保存测试');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '清理与备份', exact: true }).click();
    await dialog.getByRole('button', { name: '确认放弃', exact: true }).click();
    await expect(page).toHaveURL(/#\/maintenance$/);
  }
});
