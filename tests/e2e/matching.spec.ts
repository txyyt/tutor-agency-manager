// E2E：完整匹配/费用流程、附件、双窗口并发（AC10-AC17、AC29、AC57界面路径）。
import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { UiClient, appActionUi, financeUi, seedApplication, seedOrder } from './helpers.js';

test.describe('匹配与费用流程', () => {
  let client: UiClient;

  test.beforeEach(async ({ request }) => {
    client = new UiClient(request);
    await client.bootstrap();
  });

  test('AC10-AC12：老师详情安排、收保证金、开始；订单详情通过并收费后自动完成', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '全流程订单' });
    const app = await seedApplication(client, order.id);
    await page.goto(`#/applications/${app.id}`);
    await expect(page.getByRole('button', { name: '安排试课', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '标记已推荐', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('button', { name: '安排试课', exact: true }).click();
    let modal = page.getByRole('dialog');
    await modal.getByLabel('中介费（元）', { exact: true }).fill('300');
    await modal.getByLabel('保证金（元）', { exact: true }).fill('100');
    await expect(modal.getByRole('checkbox')).toHaveCount(0);
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('待试课');
    await page.getByRole('button', { name: '确认保证金到账并开始试课', exact: true }).click();
    await page.getByRole('dialog').getByRole('checkbox').check();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('button', { name: '试课通过', exact: true })).toBeVisible();
    await page.goto(`#/orders/${order.id}`);
    await page.getByRole('button', { name: '试课通过', exact: true }).click();
    modal = page.getByRole('dialog');
    await expect(modal).toHaveAttribute('aria-label', '确认试课通过');
    await expect(modal.locator('input')).toHaveCount(0);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    expect((await client.get(`/api/applications/${app.id}`)).body.order.status).toBe('trialing');
    await page.getByRole('button', { name: '试课通过', exact: true }).click();
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('h2 .badge').first()).toContainText('待结算');
    const passed = (await client.get(`/api/applications/${app.id}`)).body.application;
    expect(passed.status).toBe('trial_passed');
    expect(passed.feeSupplementReceivedCents).toBe(0);
    await page.getByRole('button', { name: '收取中介费', exact: true }).click();
    modal = page.getByRole('dialog');
    await expect(modal.getByLabel('本次实收中介费（元）')).toHaveValue('200');
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('已完成');
    const detail = await client.get(`/api/applications/${app.id}`);
    expect(detail.body.application.cooperationConfirmedAt).toBeTruthy();
    expect(detail.body.application.feeSupplementReceivedCents).toBe(20000);
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
    await appActionUi(client, app.id, 'recommend');
    await appActionUi(client, app.id, 'schedule-trial');
    await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 20000, depositDueCents: 5000 });
    await financeUi(client, app.id, { type: 'receive-deposit', amountCents: 5000 });

    // 订单开始试课后才能登记失败
    const od = await client.get(`/api/orders/${order.id}`);
    await client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: od.body.order.version });

    await page.goto(`#/applications/${app.id}`);
    await page.getByRole('button', { name: /试课未通过/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('h2 .badge').first()).toContainText('试课未通过', { timeout: 15_000 });
    await expect(page.locator('.money-item.danger')).toContainText('50元'); // 待退

    await page.getByRole('button', { name: '登记退款', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('本次退款（元）').fill('50');
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('.workflow-panel .money-panel')).toContainText('0元');
    expect((await client.get(`/api/applications/${app.id}`)).body.application.finance.pendingRefundCents).toBe(0);
  });

  test('AC57：附件上传、预览、下载（真实浏览器行为）', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '附件订单' });
    const app = await seedApplication(client, order.id);

    await page.goto(`#/applications/${app.id}`);
    // PNG 1x1
    const png = fs.readFileSync('tests/fixtures/acceptance/attachments/image-01.png');
    await page.locator('input[type="file"]').setInputFiles([{ name: '我的简历.png', mimeType: 'image/png', buffer: png }]);
    await page.getByRole('button', { name: '上传所选文件' }).click();
    await expect(page.locator('.attach-list')).toContainText('我的简历.png');

    // 预览（图片）
    await page.getByRole('button', { name: '预览' }).click();
    await expect(page.getByRole('dialog', { name: '附件预览', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '附件预览', exact: true }).locator('img')).toBeVisible();

    // 下载
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('dialog', { name: '附件预览', exact: true }).getByRole('button', { name: '下载原文件' }).click(),
    ]);
    expect(download.suggestedFilename()).toContain('.png');
  });

  test('AC16界面：直接合作按钮出现在候选详情且订单可完成', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '直接合作订单' });
    const app = await seedApplication(client, order.id);
    await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 20000, depositDueCents: 0 });

    await page.goto(`#/applications/${app.id}`);
    await expect(page.getByRole('button', { name: /直接合作/ })).toHaveCount(0);
    await page.getByRole('button', { name: '标记已推荐', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await page.getByRole('button', { name: /直接合作/ }).click();
    const modal = page.getByRole('dialog');
    await expect(modal).toHaveAttribute('aria-label', '确认直接合作');
    await expect(modal.locator('input')).toHaveCount(0);
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    expect((await client.get(`/api/orders/${order.id}`)).body.order.status).toBe('recruiting');
    await page.getByRole('button', { name: /直接合作/ }).click();
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const confirmed = (await client.get(`/api/applications/${app.id}`)).body;
    expect(confirmed.order.status).toBe('reviewing');
    expect(confirmed.application.feeSupplementReceivedCents).toBe(0);
    await page.getByRole('button', { name: '收取中介费', exact: true }).click();
    await expect(modal.getByLabel('本次实收中介费（元）')).toHaveValue('200');
    await modal.getByRole('checkbox').check();
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    expect((await client.get(`/api/orders/${order.id}`)).body.order.status).toBe('completed');
    await expect(page.locator('h2 .badge').first()).toContainText('直接合作');
  });
});

test('直接合作未约定费用：先确认，再单独填写中介费收款；免费明确填0', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  for (const fee of ['200', '0']) {
    const order = await seedOrder(client); const app = await seedApplication(client, order.id);
    await appActionUi(client, app.id, 'recommend');
    await page.goto(`#/applications/${app.id}`);
    await page.getByRole('button', { name: '直接合作（跳过试课）', exact: true }).click();
    await expect(page.getByRole('dialog').locator('input')).toHaveCount(0);
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '收取中介费', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(modal.getByRole('alert')).toBeVisible();
    await modal.getByLabel('中介费（元）', { exact: true }).fill(fee);
    await expect(modal.getByLabel('本次实收中介费（元）')).toHaveValue(fee);
    if (fee !== '0') {
      await modal.getByRole('button', { name: '确认', exact: true }).click();
      await expect(modal.getByRole('alert')).toContainText('实际已收到');
      await modal.getByRole('checkbox').check();
    }
    await modal.getByRole('button', { name: '确认', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const saved = (await client.get(`/api/applications/${app.id}`)).body;
    expect(saved.order.status).toBe('completed');
    expect(saved.application.agencyFeeCents).toBe(Number(fee) * 100);
    expect(saved.application.feeSupplementReceivedCents).toBe(Number(fee) * 100);
  }
});
