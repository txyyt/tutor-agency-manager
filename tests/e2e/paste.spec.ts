// E2E：粘贴家长/老师模板自动录入（AC33-AC40界面路径）+ 订单列表持久化（AC01）。
import { expect, test } from '@playwright/test';
import { UiClient, seedOrder } from './helpers.js';

const FILLED_PARENT = `【家教需求登记】

1. 家长称呼：陈女士
2. 微信：chen_e2e_mom
3. 电话：138 5555 6666

【孩子及辅导需求】
4. 孩子年级：五年级
5. 辅导科目：语文、英语
6. 目前学习情况：作文薄弱
7. 辅导目标：提升写作

【上课安排】
8. 上课方式：线上
9. 上课区域及地点：线上
10. 每周可上课的日期和时间：周三、周五 19:00—20:00
11. 每周上课次数：每周2次
12. 每次上课时长：60分钟
13. 预计开始时间：2026-10-20

【薪资及老师要求】
14. 薪资：120元/小时
    是否可以协商：是
15. 老师性别要求：女
16. 对老师的其他要求：师范专业
17. 其他备注（选填）：

请按一份独立家教需求填写一份表。
如需分别聘请不同老师，请分别填写。`;

test.describe('粘贴录入与基础界面', () => {
  let client: UiClient;

  test.beforeEach(async ({ request }) => {
    client = new UiClient(request);
    await client.bootstrap();
  });

  test('AC01/AC33：粘贴家长模板→自动填好→补正公开区域→保存→列表与详情可查，重启持久化由集成测试覆盖，此处验证详情可查', async ({ page }) => {
    await page.goto('/#/orders/new?paste=1');
    await page.fill('.paste-box textarea', FILLED_PARENT);
    await page.getByRole('button', { name: '解析并填入表单' }).click();

    // 解析结果填好了表单字段
    await expect(page.locator('.paste-result')).toContainText('全部字段识别成功');
    const parentName = page.locator('input').first();
    await expect(parentName).toHaveValue('陈女士');
    // 公开区域要求操作人补正（解析不盲复制详细地址）
    const publicAreaInput = page.locator('.field', { hasText: '公开区域' }).locator('input');
    await expect(publicAreaInput).toHaveValue('');

    await publicAreaInput.fill('线上');
    await page.getByRole('button', { name: '保存并开始招募' }).click();

    // 跳转到订单详情：编号与状态
    await page.waitForURL(/#\/orders\/\d+$/, { timeout: 15_000 });
    await expect(page.locator('h2').first()).toContainText(/JJ-\d{8}-\d{4}/);
    await expect(page.locator('h2 .badge').first()).toContainText('招募中');
    await expect(page.locator('.kv')).toContainText('陈女士');
    await expect(page.locator('.kv')).toContainText('chen_e2e_mom');
    await expect(page.locator('.kv')).toContainText('师范专业');

    // 列表可见
    await page.goto('/#/');
    await expect(page.locator('table.list')).toContainText('陈女士');
  });

  test('AC34：订单详情粘贴老师模板→自动定位本单→保存为已报名', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '老师粘贴订单' });

    await page.goto(`#/orders/${order.id}`);
    await page.getByRole('button', { name: '粘贴老师模板报名' }).click();
    await page.fill('.paste-box textarea', `【大学生家教报名】

1. 报名订单编号：${order.orderNo}
2. 姓名：赵同学
3. 性别：男
4. 微信：zhao_e2e
5. 电话：13799998888

【个人情况】
6. 就读学校：测试师范大学
7. 专业：汉语言文学
8. 当前年级：大四

【针对本订单的教学能力】
9. 可辅导的科目及年级：小学语文
10. 相关成绩或能力说明（选填）：高考语文128分
11. 家教或其他教学经验：
    五年级学生语文，每周1次，共3个月；
    擅长作文批改（年级：五年级班）
12. 针对本订单的优势及辅导思路：先批改后讲解

【时间及薪资】
13. 每周可上课的日期和时间：周三、周五 19:00—20:00
14. 最早可开始时间：2026-10-12
15. 是否接受订单中的薪资：是
16. 是否可以按安排参加试课：是

17. 其他备注（选填）：
18. 简历附件（选填，可附 PDF 或图片）：简历见附件

请针对本订单填写。
如报名多个订单，请分别提交，每份注明订单编号。
请如实填写资料和教学经历。`);
    await page.getByRole('button', { name: '解析并填入' }).click();
    await expect(page.locator('.paste-result')).toContainText('字段识别成功');
    await expect(page.locator('.paste-result')).toContainText(order.orderNo);
    await page.getByRole('button', { name: '保存为已报名' }).click();
    await page.waitForLoadState('networkidle');

    // 候选列表出现
    await expect(page.locator('table.list')).toContainText('赵同学', { timeout: 15_000 });
    await expect(page.locator('table.list')).toContainText('已报名');
  });

  test('AC37界面：老师模板编号与本单不一致时阻止保存', async ({ page }) => {
    const order = await seedOrder(client, { parentName: '阻断订单' });
    const other = await seedOrder(client, { parentName: '另一单' });

    await page.goto(`#/orders/${order.id}`);
    await page.getByRole('button', { name: '粘贴老师模板报名' }).click();
    await page.fill('.paste-box textarea', `【大学生家教报名】\n1. 报名订单编号：${other.orderNo}\n2. 姓名： mism\n3. 性别：女\n4. 微信：mm\n5. 电话：13800000001\n6. 就读学校：u\n7. 专业：p\n8. 当前年级：大二\n9. 可辅导的科目及年级：数学\n10. 相关成绩或能力说明（选填）：\n11. 家教或其他教学经验：暂无\n12. 针对本订单的优势及辅导思路：x\n13. 每周可上课的日期和时间：周六\n14. 最早可开始时间：\n15. 是否接受订单中的薪资：是\n16. 是否可以按安排参加试课：是`);
    await page.getByRole('button', { name: '解析并填入' }).click();
    await expect(page.locator('.paste-result')).toContainText('与本单不一致');
    await expect(page.getByRole('button', { name: '保存为已报名' })).toBeDisabled();
  });

  test('AC02界面：新建订单缺微信不能保存并显示字段错误', async ({ page }) => {
    await page.goto('#/orders/new');
    await page.getByRole('button', { name: '不用粘贴，直接填写' }).click();
    await page.locator('.field', { hasText: '家长称呼' }).locator('input').fill('缺微信家长');
    await page.locator('.field', { hasText: '电话' }).first().locator('input').fill('13800000000');
    await page.locator('.field', { hasText: '孩子年级' }).locator('input').fill('初一');
    await page.locator('.field', { hasText: '辅导科目' }).locator('input').fill('数学');
    await page.getByRole('button', { name: '保存并开始招募' }).click();
    await expect(page.locator('.alert.error')).toBeVisible();
    await expect(page.locator('h2').last()).toContainText('新建订单'); // 未跳转
  });

  test('AC30界面：模板复制入口与招募导出预览可用；空状态显示', async ({ page }) => {
    await page.goto('/#/');
    await page.getByRole('button', { name: '家长模板', exact: true }).click();
    await expect(page.locator('.card', { hasText: '家长需求模板' })).toContainText('【家教需求登记】');
    await page.getByRole('button', { name: '导出全部招募中文字' }).click();
    await expect(page.locator('.card', { hasText: '全部招募中导出预览' })).toBeVisible();
  });
});
