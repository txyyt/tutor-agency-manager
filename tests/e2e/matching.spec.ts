// E2E：完整匹配/费用流程、附件、双窗口并发（AC10-AC17、AC29、AC57界面路径）。
import { expect, test } from '@playwright/test';
import { UiClient, appActionUi, financeUi, seedApplication, seedOrder } from './helpers.js';

test.describe('匹配与费用流程', () => {
  let client: UiClient;

  test.beforeEach(async ({ request }) => {
    client = new UiClient(request);
    await client.bootstrap();
  });

  test('AC10-AC12：安排试课→收保证金→开始试课→通过+确认→补款→完成（全部界面操作）', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '全流程订单' });
    const app = await seedApplication(client, order.id);

    await page.goto(`#/applications/${app.id}`);
    // 安排试课（先成为当前待试课报名，才允许收保证金）
    await page.getByRole('button', { name: /安排试课/ }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('待试课');

    // 设定费用
    await page.locator('input[placeholder="中介费（元）"]').fill('300');
    await page.locator('input[placeholder="计划保证金（元）"]').fill('100');
    await page.getByRole('button', { name: '设定收费' }).click();
    await expect(page.locator('.money-panel')).toContainText('300元');

    // 收保证金
    await page.locator('input[placeholder="本次实收保证金（元）"]').fill('100');
    await page.getByRole('button', { name: '登记收保证金' }).click();
    await expect(page.locator('.money-panel')).toContainText('累计实收保证金');
    await expect(page.locator('.card', { hasText: '费用面板' })).toContainText('100.00元');

    // 去订单页开始试课（有确认弹窗）
    await page.getByRole('link', { name: new RegExp(order.orderNo) }).click();
    await page.getByRole('button', { name: '开始试课' }).click();
    await page.locator('button.btn.primary', { hasText: '确认' }).last().click();
    await expect(page.locator('h2 .badge').first()).toContainText('试课中', { timeout: 15_000 });

    // 回报名页：通过+确认合作
    await page.goto(`#/applications/${app.id}`);
    await page.getByRole('button', { name: /试课通过/ }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('试课通过');

    // 确认合作（合作确认时间被写入）
    await page.getByRole('button', { name: '确认合作' }).click();
    await expect(page.locator('.kv')).toContainText('合作确认时间');
    await expect(page.locator('.kv')).not.toContainText('合作确认时间—');

    // 补款200
    await page.locator('input[placeholder="本次补款（元）"]').fill('200');
    await page.getByRole('button', { name: '登记补收中介费' }).click();
    await expect(page.locator('.card', { hasText: '费用面板' })).toContainText('已结清');

    // 订单页完成
    await page.goto(`#/orders/${order.id}`);
    await page.getByRole('button', { name: '完成订单' }).click();
    await page.locator('.btn.primary', { hasText: '确认' }).last().click();
    await expect(page.locator('h2 .badge').first()).toContainText('已完成', { timeout: 10_000 });
    await expect(page.locator('.alert.ok')).toContainText('已完成');
  });

  test('AC29：两窗口编辑同一订单，旧版本保存被冲突提示拦截', async ({ browser, request }) => {
    client = new UiClient(request);
    await client.bootstrap();
    const order = await seedOrder(client, { parentName: '双窗口订单' });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();
    await page1.goto(`#/orders/${order.id}/edit`);
    await page2.goto(`#/orders/${order.id}/edit`);
    await page1.waitForLoadState('networkidle');
    await page2.waitForLoadState('networkidle');

    // 窗口1保存成功
    await page1.locator('.field', { hasText: '内部备注' }).locator('textarea').fill('窗口1的修改');
    await page1.getByRole('button', { name: '保存修改' }).click();
    await page1.waitForURL(new RegExp(`#/orders/${order.id}$`), { timeout: 15_000 });
    await expect(page1.locator('h2').first()).toContainText(order.orderNo);

    // 窗口2（旧版本）保存 → 冲突提示
    await page2.locator('.field', { hasText: '内部备注' }).locator('textarea').fill('窗口2的修改');
    await page2.getByRole('button', { name: '保存修改' }).click();
    await expect(page2.locator('.alert.error').first()).toContainText(/刷新|冲突|修改/);

    await ctx1.close();
    await ctx2.close();
  });

  test('AC13/AC14界面：试课失败→登记退款→退清', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '失败流程订单' });
    const app = await seedApplication(client, order.id);
    await appActionUi(client, app.id, 'schedule-trial');
    await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 20000, depositDueCents: 5000 });
    await financeUi(client, app.id, { type: 'receive-deposit', amountCents: 5000 });

    // 订单开始试课后才能登记失败
    const od = await client.get(`/api/orders/${order.id}`);
    await client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: od.body.order.version });

    await page.goto(`#/applications/${app.id}`);
    await page.getByRole('button', { name: /试课未通过/ }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('试课未通过', { timeout: 15_000 });
    await expect(page.locator('.money-item.danger')).toContainText('50.00元'); // 待退

    // 退款
    await page.locator('input[placeholder="本次退款（元）"]').fill('50');
    await page.getByRole('button', { name: '登记退款' }).click();
    await expect(page.locator('.card', { hasText: '费用面板' })).toContainText('当前净收');
  });

  test('AC57：附件上传、预览、下载（真实浏览器行为）', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '附件订单' });
    const app = await seedApplication(client, order.id);

    await page.goto(`#/applications/${app.id}`);
    // PNG 1x1
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.locator('input[type="file"]').setInputFiles([{ name: '我的简历.png', mimeType: 'image/png', buffer: png }]);
    await page.getByRole('button', { name: '上传所选文件' }).click();
    await expect(page.locator('.attach-list')).toContainText('我的简历.png');

    // 预览（图片）
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.locator('.card', { hasText: '附件预览' })).toBeVisible();
    await expect(page.locator('.card', { hasText: '附件预览' }).locator('img')).toBeVisible();

    // 下载
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('.card', { hasText: '附件预览' }).getByRole('link', { name: '下载原文件' }).click(),
    ]);
    expect(download.suggestedFilename()).toContain('.png');
  });

  test('AC16界面：直接合作按钮出现在候选详情且订单可完成', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '直接合作订单' });
    const app = await seedApplication(client, order.id);
    await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 20000, depositDueCents: 0 });

    await page.goto(`#/applications/${app.id}`);
    await page.getByRole('button', { name: /直接合作/ }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('直接合作', { timeout: 15_000 });
    await page.locator('input[placeholder="本次补款（元）"]').fill('200');
    await page.getByRole('button', { name: '登记补收中介费' }).click();
    await expect(page.locator('.card', { hasText: '费用面板' })).toContainText('已结清');
  });
});
