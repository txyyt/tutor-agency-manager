import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { UiClient, appActionUi, seedOrder, seedApplication } from './helpers.js';
test.beforeEach(async ({ page }) => { page.on('pageerror', e => { throw e; }); });

function parentText() { return fs.readFileSync('tests/fixtures/acceptance/parents/A.txt', 'utf8').replace(/公开授课区域：[^\n]*\n/u, ''); }
function teacherText(no: string) { return fs.readFileSync('tests/fixtures/acceptance/teachers/A1.txt', 'utf8').replaceAll('{{订单A编号}}', no); }

test('订单列表单一建单入口、排序切换与默认待办优先', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const marker = `排序验收${Date.now()}`;
  const a = await seedOrder(client, { parentName: marker });
  const b = await seedOrder(client, { parentName: marker });
  const c = await seedOrder(client, { parentName: marker });
  await seedApplication(client, b.id);
  await page.goto('#/');
  await expect(page.getByRole('button', { name: '粘贴家长模板建单', exact: true })).toHaveCount(0);
  await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(marker);
  const rows = page.locator('table.list tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText(b.orderNo);
  await expect(page.getByRole('checkbox', { name: '待办优先', exact: true })).toBeChecked();
  await page.getByLabel('订单排序').selectOption('number-asc');
  await expect(rows.nth(1)).toContainText(a.orderNo);
  await page.getByRole('checkbox', { name: '待办优先', exact: true }).uncheck();
  await expect(rows.first()).toContainText(a.orderNo);
  await expect(rows.last()).toContainText(c.orderNo);
  await page.getByLabel('订单排序').selectOption('number-desc');
  await expect(rows.first()).toContainText(c.orderNo);
  await page.getByRole('checkbox', { name: '待办优先', exact: true }).check();
  await expect(rows.first()).toContainText(b.orderNo);
  await page.getByRole('button', { name: '新建订单', exact: true }).click();
  await expect(page.locator('.paste-box textarea')).toBeVisible();
});

test('内部地点选填：空地址显示试课时问家长，编辑可补填和再次清空', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  await page.goto('#/orders/new');
  const text = fs.readFileSync('tests/fixtures/acceptance/parents/A.txt', 'utf8').replace(/9\. 上课区域及地点：[^\n]*/u, '9. 上课区域及地点：\n   （选填，内部地点不会用于群内发布；暂不想提供可先留空，试课时再询问）');
  await page.locator('.paste-box textarea').fill(text);
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await expect(page.getByPlaceholder('试课时问家长')).toHaveValue('');
  await page.getByRole('button', { name: '保存并开始招募', exact: true }).click();
  await page.waitForURL(/#\/orders\/\d+$/);
  const detailUrl = page.url();
  await expect(page.locator('dt', { hasText: '内部地点' }).locator('xpath=following-sibling::dd[1]')).toHaveText('试课时问家长');
  await page.goto(`${detailUrl}/edit`);
  await page.getByPlaceholder('试课时问家长').fill('内部小区502室');
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.waitForURL(detailUrl);
  await expect(page.locator('dt', { hasText: '内部地点' }).locator('xpath=following-sibling::dd[1]')).toHaveText('内部小区502室');
  await page.goto(`${detailUrl}/edit`);
  await page.getByPlaceholder('试课时问家长').fill('');
  await page.getByRole('button', { name: '保存修改', exact: true }).click(); await page.waitForURL(detailUrl);
  await expect(page.locator('dt', { hasText: '内部地点' }).locator('xpath=following-sibling::dd[1]')).toHaveText('试课时问家长');
});

test('反馈01/02：公开区域解析，线上隐藏地址；长表单保存错误浮层可见并定位', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const order = await seedOrder(client);
  await page.goto(`#/orders/${order.id}/edit`);
  const area = page.locator('.field', { hasText: '公开区域' }).locator('input');
  await area.fill(''); await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('公开授课区域');
  await expect(area).toBeFocused();
  const mode = page.locator('.field', { hasText: '上课方式' }).locator('select');
  await mode.selectOption('online');
  await expect(page.locator('.field', { hasText: '公开区域' })).toHaveCount(0);
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.waitForURL(new RegExp(`#/orders/${order.id}$`));
  expect((await client.get(`/api/orders/${order.id}`)).body.order.publicArea).toBe('线上');
  await page.goto('#/orders/new');
  await page.locator('.paste-box textarea').fill(parentText().replace('10. 每周', '公开区域：城东验收区\n10. 每周'));
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await expect(page.locator('.field', { hasText: '公开区域' }).locator('input')).toHaveValue('城东验收区');
});

test('反馈03：老师填写时上传PDF和图片，保存后弹窗真实预览及下载', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap(); const order = await seedOrder(client);
  await page.goto(`#/orders/${order.id}/apply`);
  await page.locator('.paste-box textarea').fill(teacherText(order.orderNo));
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await page.getByLabel('报名简历附件').setInputFiles(['tests/fixtures/acceptance/attachments/acceptance-resume.pdf', 'tests/fixtures/acceptance/attachments/image-01.png']);
  await page.getByRole('button', { name: '保存报名（状态：已报名）' }).click();
  await page.waitForURL(/#\/applications\/\d+$/);
  await expect(page.locator('.attach-list li')).toHaveCount(2);
  await page.locator('.attach-list li').filter({ hasText: 'image-01.png' }).getByRole('button', { name: '预览', exact: true }).click();
  let modal = page.getByRole('dialog', { name: '附件预览', exact: true });
  await expect(modal.locator('img')).toBeVisible();
  await expect.poll(() => modal.locator('img').evaluate(img => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(128);
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.attach-list li').filter({ hasText: 'acceptance-resume.pdf' }).getByRole('button', { name: '预览', exact: true }).click();
  modal = page.getByRole('dialog', { name: '附件预览', exact: true });
  await expect(modal.locator('iframe')).toHaveAttribute('src', /^blob:/);
  const pdf = await modal.locator('iframe').evaluate(async el => { const response = await fetch((el as unknown as { src: string }).src); return (await response.text()).slice(0, 5); });
  expect(pdf).toBe('%PDF-');
  const [download] = await Promise.all([page.waitForEvent('download'), modal.getByRole('button', { name: '下载原文件' }).click()]);
  expect(download.suggestedFilename()).toBe('acceptance-resume.pdf');
});

test('反馈04/05/06：全选仅有效候选、半选与筛选，待办高亮，无展开模板', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap(); const order = await seedOrder(client, { parentName: '全选反馈订单' });
  await seedApplication(client, order.id, { teacherName: '候选甲' });
  await seedApplication(client, order.id, { teacherName: '候选乙' });
  const withdrawn = await seedApplication(client, order.id, { teacherName: '退出丙' }); await appActionUi(client, withdrawn.id, 'withdraw');
  await page.goto(`#/orders/${order.id}`);
  await expect(page.getByRole('button', { name: '展开粘贴老师模板' })).toHaveCount(0);
  await expect(page.locator('.paste-box')).toHaveCount(0);
  await expect(page.locator('table.list').getByRole('button', { name: /安排试课|直接合作|主动退出/ })).toHaveCount(0);
  await expect(page.locator('table.list th').last()).toHaveText('操作');
  await expect(page.locator('table.list td.table-action').first()).toHaveCSS('text-align', 'left');
  await expect(page.locator('table.list td.candidate-finance').first()).toHaveCSS('white-space', 'nowrap');
  const all = page.getByLabel('全选当前候选'); await all.check();
  await expect(page.getByText('已选 2 位：', { exact: true })).toBeVisible();
  await page.getByLabel('选择候选甲').uncheck();
  expect(await all.evaluate(el => (el as unknown as { indeterminate: boolean }).indeterminate)).toBe(true);
  await all.check();
  await page.getByRole('button', { name: '标记已推荐', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.locator('table.list tbody')).toContainText('已推荐');
  await page.goto('#/'); await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(order.orderNo);
  await expect(page.locator('table.list tbody tr')).not.toHaveClass(/needs-action/);
  const extra = await seedApplication(client, order.id, { teacherName: '新候选丁' });
  await page.reload(); await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(order.orderNo);
  await expect(page.locator('table.list tbody tr')).toHaveClass(/needs-action/);
  await expect(page.locator('table.list tbody tr')).toContainText('待推荐 · 1人');
  await expect(page.locator('td.table-action')).not.toContainText('待推荐');
  await expect(page.locator('td.table-action')).toContainText('查看/报名');
  expect(extra.status).toBe('submitted');
  await page.getByText('只看需要处理', { exact: true }).getByRole('checkbox').check();
  await expect(page.locator('table.list tbody tr')).toHaveCount(1);
});

test('反馈07：删除误录报名与整单级联，删除前备份可见', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap(); const order = await seedOrder(client); const a = await seedApplication(client, order.id);
  await page.goto(`#/applications/${a.id}`);
  await page.getByRole('button', { name: '删除报名', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForURL(new RegExp(`#/orders/${order.id}$`));
  expect((await client.get(`/api/applications/${a.id}`)).status).toBe(404);
  const b = await seedApplication(client, order.id); await page.reload();
  await page.getByRole('button', { name: '删除订单', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1份报名');
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForURL(/#\/$/); expect((await client.get(`/api/applications/${b.id}`)).status).toBe(404);
  await page.goto('#/maintenance'); await expect(page.getByRole('cell', { name: '删除前安全备份', exact: true })).toHaveCount(2);
});

test('反馈08/11/14：详情高亮订单列表，返回上一页，未保存资料返回前提醒', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap(); const order = await seedOrder(client); const a = await seedApplication(client, order.id);
  await page.goto(`#/orders/${order.id}`); await page.getByRole('link', { name: a.applicationNo, exact: true }).click();
  await expect(page.locator('nav a.active')).toHaveText('订单列表');
  await expect(page.getByRole('link', { name: '老师报名', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← 返回上一页' }).click(); await page.waitForURL(new RegExp(`#/orders/${order.id}$`));
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await page.locator('.field', { hasText: '内部备注' }).locator('textarea').fill('未保存的修改');
  await page.getByRole('button', { name: '← 返回上一页' }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/orders/${order.id}/edit$`));
  await page.getByRole('button', { name: '← 返回上一页' }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？' }).getByRole('button', { name: '确认放弃', exact: true }).click();
  await page.waitForURL(new RegExp(`#/orders/${order.id}$`));
  expect((await client.get(`/api/orders/${order.id}`)).body.order.notes).not.toBe('未保存的修改');
});

test('反馈12/13：未收保证金保持待试课；通过只确认结果保持待结算，单独补款后完成', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap(); const order = await seedOrder(client); const a = await seedApplication(client, order.id);
  await page.goto(`#/applications/${a.id}`);
  await appActionUi(client, a.id, 'recommend');
  await page.reload();
  await page.getByRole('button', { name: '安排试课', exact: true }).click();
  let modal = page.getByRole('dialog'); await modal.getByLabel('中介费（元）', { exact: true }).fill('300'); await modal.getByLabel('保证金（元）', { exact: true }).fill('100');
  await modal.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/applications/${a.id}$`));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收取中介费', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始试课', exact: true })).toHaveCount(0);
  expect((await client.get(`/api/applications/${a.id}`)).body.application.depositReceivedCents).toBe(0);
  await page.getByRole('button', { name: '确认保证金到账并开始试课', exact: true }).click(); modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '确认', exact: true }).click(); await expect(modal.getByRole('alert')).toContainText('实际已收到');
  await modal.getByRole('checkbox').check(); await modal.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '试课通过', exact: true })).toBeVisible();
  const tools = page.locator('.fee-tools');
  await tools.locator('summary').click();
  await expect(tools.getByRole('button', { name: '更正金额' })).toBeVisible();
  await tools.getByRole('button', { name: '费用告知' }).click();
  await expect(tools.locator('pre')).toBeVisible();
  await page.getByRole('button', { name: '试课通过', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-label', '确认试课通过');
  await expect(page.getByRole('dialog').locator('input')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await client.get(`/api/applications/${a.id}`)).body.application.feeSupplementReceivedCents).toBe(0);
  await expect(page.getByRole('button', { name: '确认合作', exact: true })).toHaveCount(0);
  let d = (await client.get(`/api/applications/${a.id}`)).body; expect(d.order.status).toBe('reviewing'); expect(d.application.cooperationConfirmedAt).toBeTruthy();
  await page.getByRole('button', { name: '收取中介费', exact: true }).click(); modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: '确认', exact: true }).click(); await expect(modal.getByRole('alert')).toContainText('实际已收到');
  await modal.getByRole('checkbox').check(); await modal.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('button', { name: '收取中介费', exact: true })).toHaveCount(0);
  d = (await client.get(`/api/applications/${a.id}`)).body; expect(d.order.status).toBe('completed');
  await page.goto('#/'); await expect(page.getByText('家长挑选中', { exact: true })).toHaveCount(0);
});

test('订单分页：页码按钮、输入和回车跳转，越界校验及筛选重置', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const marker = `跳页验收${Date.now()}`;
  const orders = [];
  for (let i = 0; i < 41; i++) orders.push(await seedOrder(client, { parentName: marker }));
  await page.goto('#/');
  await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(marker);
  const rows = page.locator('table.list tbody tr');
  const pagination = page.getByRole('navigation', { name: '订单分页' });
  await expect(pagination).toContainText('共 41 条');
  await expect(rows).toHaveCount(20);
  await page.getByLabel('订单排序').selectOption('number-asc');
  await page.getByRole('checkbox', { name: '待办优先', exact: true }).uncheck();
  await expect(rows.first()).toContainText(orders[0].orderNo);
  await pagination.getByRole('button', { name: '第 3 页', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(orders[40].orderNo);
  await expect(pagination.getByRole('button', { name: '下一页' })).toBeDisabled();
  await pagination.getByLabel('跳转页码').fill('2');
  await pagination.getByLabel('跳转页码').press('Enter');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText(orders[20].orderNo);
  for (const value of ['0', '4', '1.5', '']) {
    await pagination.getByLabel('跳转页码').fill(value);
    await pagination.getByRole('button', { name: '跳转', exact: true }).click();
    await expect(pagination.getByRole('alert')).toContainText('1—3');
    await expect(pagination.getByRole('button', { name: '第 2 页', exact: true })).toHaveAttribute('aria-current', 'page');
  }
  await pagination.getByLabel('跳转页码').fill('1');
  await pagination.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(rows.first()).toContainText(orders[0].orderNo);
  await expect(pagination.getByRole('button', { name: '上一页' })).toBeDisabled();
  await pagination.getByRole('button', { name: '下一页' }).click();
  await expect(rows.first()).toContainText(orders[20].orderNo);
  await page.getByPlaceholder('搜索编号/称呼/微信/电话').fill(orders[0].orderNo);
  await expect(rows).toHaveCount(1);
  await expect(pagination).toContainText('第 1 / 1 页，共 1 条');
});

test('中文次数时长粘贴录入，模糊值提示补正、上课时间保持原文', async ({ page, request }) => {
  const client = new UiClient(request); await client.bootstrap();
  const text = fs.readFileSync('tests/fixtures/acceptance/parents/A.txt', 'utf8')
    .replace(/10\. 每周可上课的日期和时间：[^\n]*/u, '10. 每周可上课的日期和时间：周三下午两点')
    .replace(/11\. 每周上课次数：[^\n]*/u, '11. 每周上课次数：每周两次')
    .replace(/12\. 每次上课时长：[^\n]*/u, '12. 每次上课时长：一小时半');
  await page.goto('#/orders/new');
  await page.locator('.paste-box textarea').fill(text.replace('每周两次', '每周两到三次').replace('一小时半', '一两个小时'));
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await expect(page.locator('.paste-result')).toContainText('每周两到三次');
  await expect(page.locator('.paste-result')).toContainText('一两个小时');
  await expect(page.locator('.field', { hasText: '每周上课次数' }).locator('input')).toHaveValue('');
  await expect(page.locator('.field', { hasText: '每次时长（分钟）' }).locator('input')).toHaveValue('');
  await page.locator('.paste-box textarea').fill(text);
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await expect(page.locator('.field', { hasText: '每周上课次数' }).locator('input')).toHaveValue('2');
  await expect(page.locator('.field', { hasText: '每次时长（分钟）' }).locator('input')).toHaveValue('90');
  await page.getByRole('button', { name: '保存并开始招募', exact: true }).click();
  await page.waitForURL(/#\/orders\/\d+$/);
  const id = page.url().split('/').pop();
  const saved = (await client.get(`/api/orders/${id}`)).body.order;
  expect(saved.sessionsPerWeek).toBe(2);
  expect(saved.sessionMinutes).toBe(90);
  expect(saved.weeklySchedule).toBe('周三下午两点');
});
