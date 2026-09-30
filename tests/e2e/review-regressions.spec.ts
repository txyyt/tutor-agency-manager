import { expect, test } from '@playwright/test';
import { appActionUi, financeUi, UiClient, seedApplication, seedOrder } from './helpers.js';

test('手动输入公开订单编号可以查询报名订单', async ({ page, request }) => {
  const client = new UiClient(request);
  await client.bootstrap();
  const order = await seedOrder(client);
  await page.goto('/#/apply');
  await page.getByPlaceholder('订单编号，如 JJ-20260930-0001').fill(order.orderNo);
  await page.getByRole('button', { name: '查询订单' }).click();
  await expect(page.locator('.alert.info').last()).toContainText(`报名订单：${order.orderNo}`);
  await expect(page.getByRole('button', { name: '保存报名（状态：已报名）' })).toBeEnabled();
});

test('老师详情可编辑：预填资料、保存后保留订单、费用和附件', async ({ page, request }) => {
  const client = new UiClient(request);
  await client.bootstrap();
  const order = await seedOrder(client);
  const app = await seedApplication(client, order.id, {
    achievements: '原成绩说明', notes: '原备注', earliestStartDate: '2026-11-01',
    acceptsOrderPay: false, expectedHourlyPayCents: 18050,
  });
  await appActionUi(client, app.id, 'schedule-trial');
  await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 30000, depositDueCents: 10000 });
  await financeUi(client, app.id, { type: 'receive-deposit', amountCents: 10000 });
  const session = await (await request.get('/api/session')).json();
  const current = (await client.get(`/api/applications/${app.id}`)).body.application;
  const uploaded = await request.post(`/api/applications/${app.id}/attachments`, {
    headers: { 'X-CSRF-Token': session.csrfToken, 'X-Data-Epoch': String(session.dataEpoch) },
    multipart: {
      version: String(current.version),
      files: { name: '简历.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex') },
    },
  });
  expect(uploaded.status()).toBe(201);
  const before = (await client.get(`/api/applications/${app.id}`)).body.application;
  await page.goto(`/#/applications/${app.id}`);
  await page.getByRole('link', { name: '编辑老师资料' }).click();
  await expect(page.locator('.field', { hasText: '姓名' }).locator('input')).toHaveValue(app.teacherName);
  await expect(page.locator('.field', { hasText: '期望薪资' }).locator('input')).toHaveValue('180.5');
  await expect(page.locator('.field', { hasText: '最早可开始时间' }).locator('input')).toHaveValue('2026-11-01');
  await page.locator('.field', { hasText: '姓名' }).locator('input').fill('修改后的老师');
  await page.locator('.field', { hasText: '内部备注' }).locator('textarea').fill('补充资料');
  await page.getByRole('button', { name: '保存修改' }).click();
  await page.waitForURL(new RegExp(`#/applications/${app.id}$`));
  await expect(page.locator('.kv').first()).toContainText('修改后的老师');
  await expect(page.locator('.kv').first()).toContainText('补充资料');
  const after = (await client.get(`/api/applications/${app.id}`)).body.application;
  expect(after.orderId).toBe(order.id);
  expect(after.status).toBe(before.status);
  expect(after.achievements).toBe('原成绩说明');
  expect(after.expectedHourlyPayCents).toBe(18050);
  expect(after.attachments).toEqual(before.attachments);
  expect(after.financeOperations).toEqual(before.financeOperations);
  expect(after.depositReceivedCents).toBe(10000);
  expect(after.agencyFeeCents).toBe(30000);
});
