import { expect, test } from '@playwright/test';
import { formatHkDateTimeCn } from '../../src/shared/datetime.js';
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
  await appActionUi(client, app.id, 'recommend');
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

test('老师详情直接复制家长摘要：模板一致、私密字段过滤、状态不变和剪贴板失败回退', async ({ page, request, context }) => {
  const client = new UiClient(request); await client.bootstrap();
  const order = await seedOrder(client);
  const app = await seedApplication(client, order.id, {
    teacherName: '详情复制老师', wechat: 'secret-copy-wechat', phone: '13988889999', notes: '内部备注不得发送',
  });
  const summary = await client.post(`/api/orders/${order.id}/recommendations`, { mode: 'summary', applicationIds: [app.id] });
  expect(summary.status).toBe(200);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(`/#/applications/${app.id}`);
  await page.getByRole('button', { name: '复制老师信息（发家长）', exact: true }).click();
  await expect(page.getByText('已复制', { exact: true })).toBeVisible();
  const copied = await page.evaluate('navigator.clipboard.readText()');
  expect(String(copied).replaceAll('\r\n', '\n')).toBe(summary.body.text);
  expect(copied).toContain(app.applicationNo);
  expect(copied).toContain('详情复制老师');
  for (const secret of ['secret-copy-wechat', '13988889999', '内部备注不得发送', '中介费', '保证金']) expect(copied).not.toContain(secret);
  expect((await client.get(`/api/applications/${app.id}`)).body.application.status).toBe('submitted');
  await page.evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('clipboard unavailable'); } })");
  await page.getByRole('button', { name: '复制老师信息（发家长）', exact: true }).click();
  await expect(page.getByText('复制失败，请手动选中文本复制')).toBeVisible();
  await page.getByText('查看发给家长的老师信息', { exact: true }).click();
  await expect(page.locator('details pre.plain').first()).toHaveText(summary.body.text);
});

test('订单列表最近修改包含老师资料修改，显示和排序一致', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const marker = `整单最新时间${Date.now()}`;
  const a = await seedOrder(client, { parentName: marker });
  const app = await seedApplication(client, a.id);
  const b = await seedOrder(client, { parentName: marker });
  await page.goto('#/');
  await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(marker);
  await page.getByRole('checkbox', { name: '待办优先', exact: true }).uncheck();
  const rows = page.locator('table.list tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(b.orderNo);
  await page.goto(`#/applications/${app.id}/edit`);
  await page.locator('.field', { hasText: '姓名' }).locator('input').fill('最新变动老师');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForURL(new RegExp(`#/applications/${app.id}$`));
  const saved = (await client.get(`/api/applications/${app.id}`)).body.application;
  await page.goto('#/');
  await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(marker);
  await page.getByRole('checkbox', { name: '待办优先', exact: true }).uncheck();
  await expect(rows.first()).toContainText(a.orderNo);
  await expect(rows.first().locator('td').last()).toHaveText(formatHkDateTimeCn(saved.updatedAt));
  await page.getByLabel('订单排序').selectOption('updated-asc');
  await expect(rows.first()).toContainText(b.orderNo);
});

test('更正入口和字段仅适用于已经设置或登记的金额', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const order = await seedOrder(client); const app = await seedApplication(client, order.id);
  await page.goto(`#/applications/${app.id}`);
  let tools = page.locator('.fee-tools'); await tools.locator('summary').click();
  await expect(tools.getByRole('button', { name: /^更正金额/ })).toBeVisible();
  await expect(tools.getByRole('button', { name: /^更正金额/ })).toBeDisabled();
  await expect(tools.getByRole('button', { name: /^更正金额/ })).toContainText('设置金额后可更正');
  await financeUi(client, app.id, { type: 'set-fees', agencyFeeCents: 30000, depositDueCents: 10000 });
  await page.reload(); tools = page.locator('.fee-tools'); await tools.locator('summary').click();
  await tools.getByRole('button', { name: /^更正金额/ }).click();
  const project = tools.locator('.field', { hasText: '更正项目' }).locator('select');
  const current = tools.locator('.field', { hasText: '当前金额（元）' }).locator('input');
  const amount = tools.locator('.field', { hasText: '正确金额（元）' }).locator('input');
  const reason = tools.locator('.field', { hasText: '更正理由' }).locator('input');
  const submit = tools.getByRole('button', { name: '提交更正', exact: true });
  await expect(project.locator('option')).toHaveText(['约定中介费', '约定保证金']);
  await expect(tools.locator('input')).toHaveCount(3);
  await expect(current).toHaveValue('300'); await expect(current).toHaveAttribute('readonly', '');
  await expect(submit).toBeDisabled();
  await amount.fill('250'); await expect(submit).toBeDisabled();
  await reason.fill('中介费录错'); await expect(submit).toBeEnabled();
  await expect(tools.getByRole('status')).toHaveText('约定中介费：300 元 → 250 元');
  await amount.fill('-1'); await expect(submit).toBeDisabled();
  await amount.fill('300'); await expect(submit).toBeDisabled();
  await amount.fill('250');
  await project.selectOption('depositDueCents');
  await expect(amount).toHaveValue(''); await expect(current).toHaveValue('100');
  await expect(submit).toBeDisabled();
  await project.selectOption('agencyFeeCents'); await amount.fill('250');
  await submit.click();
  await expect.poll(async () => (await client.get(`/api/applications/${app.id}`)).body.application.agencyFeeCents).toBe(25000);
  const after = (await client.get(`/api/applications/${app.id}`)).body.application;
  expect(after.depositDueCents).toBe(10000); expect(after.depositReceivedCents).toBe(0);
  await appActionUi(client, app.id, 'recommend'); await appActionUi(client, app.id, 'schedule-trial');
  await financeUi(client, app.id, { type: 'receive-deposit', amountCents: 10000 });
  await page.reload(); tools = page.locator('.fee-tools'); await tools.locator('summary').click();
  await tools.getByRole('button', { name: /^更正金额/ }).click();
  await expect(project.locator('option')).toHaveText(['约定中介费', '约定保证金', '已收到的保证金总额']);
  await project.selectOption('depositReceivedCents'); await expect(current).toHaveValue('100');
  await amount.fill('80'); await reason.fill('取消不保存');
  await tools.getByRole('button', { name: '取消', exact: true }).click();
  expect((await client.get(`/api/applications/${app.id}`)).body.application.depositReceivedCents).toBe(10000);
});
