// 截图脚本：启动隔离数据目录的服务，用Playwright截取关键页面。
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const port = 3450;
const base = `http://127.0.0.1:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-shot-'));
const outDir = path.join(process.cwd(), 'docs', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, ['dist/server/main.js'], {
  env: { ...process.env, APP_DATA_DIR: dataDir, APP_PORT: String(port), APP_ALLOW_TIME_CONTROL: '1' },
  stdio: 'ignore',
});

const FILLED_PARENT = `【家教需求登记】

1. 家长称呼：王女士
2. 微信：wang_mom_2026
3. 电话：138 0013 8000

【孩子及辅导需求】
4. 孩子年级：初三
5. 辅导科目：数学、物理
6. 目前学习情况：基础薄弱，几何证明题失分严重
7. 辅导目标：期中考前重点复习函数与几何

【上课安排】
8. 上课方式：线下
9. 上课区域及地点：阳光花园小区附近
10. 每周可上课的日期和时间：周六下午2点到4点，周日上午
11. 每周上课次数：每周2次
12. 每次上课时长：1.5小时
13. 预计开始时间：2026-10-15

【薪资及老师要求】
14. 薪资：150元/小时
    是否可以协商：是
15. 老师性别要求：女
16. 对老师的其他要求：有初三带教经验，最好女研究生
17. 其他备注（选填）：孩子有点内向，希望老师有耐心

请按一份独立家教需求填写一份表。
如需分别聘请不同老师，请分别填写。`;

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server not up');
}

try {
  await waitHealth();
  // 会话
  const sessionRes = await fetch(`${base}/api/session`);
  const cookie = (sessionRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const session = await sessionRes.json();
  const headers = { 'X-CSRF-Token': session.csrfToken, 'X-Data-Epoch': String(session.dataEpoch), Cookie: cookie };
  const h = (extra) => ({ ...headers, ...(extra ?? {}) });

  // ---- 种子数据 ----
  // 订单1：粘贴单（保留原文）
  const parseRes = await fetch(`${base}/api/imports/parse`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ kind: 'parent', text: FILLED_PARENT }) });
  const parse = await parseRes.json();
  const order1Res = await fetch(`${base}/api/orders`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ...buildOrder(parse.form), publicArea: '城东·阳光花园片区', sourceTemplateText: FILLED_PARENT, creationRequestId: crypto.randomUUID() }) });
  const order1 = (await order1Res.json()).order;
  // 订单2、3
  const mk = (over) => fetch(`${base}/api/orders`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(buildOrder(null, over)) });
  const _order2 = (await (await mk({ parentName: '李爸爸', parentWechat: 'li_baba', parentPhone: '13900001111', childGrade: '高一', subjects: '英语', teachingMode: 'online', locationDetail: '线上', publicArea: '线上' })).json()).order;
  // 报名
  const app = async (oid, over) => (await (await fetch(`${base}/api/orders/${oid}/applications`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify(buildApp(over)) })).json()).application;
  const _a1 = await app(order1.id, { teacherName: '陈晓雨', gender: 'female', wechat: 'chen_xy', phone: '13711112222' });
  const a2 = await app(order1.id, { teacherName: '刘思远', gender: 'male', wechat: 'liu_sy', phone: '13733334444' });
  // 候选2安排试课+费用+收保证金+开始试课
  const appGet = async (id) => (await (await fetch(`${base}/api/applications/${id}`, { headers })).json());
  await fetch(`${base}/api/applications/${a2.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'recommend', version: (await appGet(a2.id)).application.version }) });
  await fetch(`${base}/api/applications/${a2.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'schedule-trial', version: (await appGet(a2.id)).application.version, orderVersion: (await (await fetch(`${base}/api/orders/${order1.id}`, { headers })).json()).order.version }) });
  await fetch(`${base}/api/applications/${a2.id}/finance`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'set-fees', operationId: crypto.randomUUID(), version: (await appGet(a2.id)).application.version, agencyFeeCents: 30000, depositDueCents: 10000 }) });
  await fetch(`${base}/api/applications/${a2.id}/finance`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'receive-deposit', operationId: crypto.randomUUID(), version: (await appGet(a2.id)).application.version, amountCents: 10000 }) });
  const od1 = (await (await fetch(`${base}/api/orders/${order1.id}`, { headers })).json()).order;
  await fetch(`${base}/api/orders/${order1.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'start-trial', version: od1.version }) });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  await page.goto(`${base}/#/`);
  await page.waitForLoadState('networkidle');

  // 1. 订单列表
  await page.screenshot({ path: path.join(outDir, '01-orders-list.png'), fullPage: false });

  // 2. 粘贴解析与补正
  await page.goto(`${base}/#/orders/new?paste=1`);
  await page.fill('.paste-box textarea', FILLED_PARENT);
  await page.getByRole('button', { name: '解析并填入表单' }).click();
  await page.waitForTimeout(600);
  await page.locator('.card.paste-box').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '02-paste-parse.png'), fullPage: false });

  // 3. 订单详情/候选
  await page.goto(`${base}/#/orders/${order1.id}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(outDir, '03-order-detail.png'), fullPage: true });

  // 4. 候选摘要（a1/a2均为submitted/recommended才显示勾选框）
  await page.goto(`${base}/#/orders/${order1.id}`);
  await page.waitForLoadState('networkidle');
  const boxes = page.locator('input[type="checkbox"]');
  await boxes.first().waitFor({ state: 'visible', timeout: 10_000 });
  const count = await boxes.count();
  for (let i = 0; i < count; i++) await boxes.nth(i).check();
  await page.getByRole('button', { name: '生成候选摘要（发家长）' }).click();
  await page.locator('.card').filter({ has: page.getByRole('heading', { name: /候选摘要（按报名编号/ }) }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '04-candidate-summary.png'), fullPage: false });

  // 5. 报名详情+费用面板
  await page.goto(`${base}/#/applications/${a2.id}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: path.join(outDir, '05-application-fees.png'), fullPage: false });

  await page.getByRole('button', { name: '试课通过', exact: true }).click();
  await page.screenshot({ path: path.join(outDir, '11-trial-settlement.png'), fullPage: false });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.fee-tools summary').click();
  await page.locator('.fee-tools').screenshot({ path: path.join(outDir, '12-fee-tools.png') });

  // 6. 招募导出预览
  await page.goto(`${base}/#/`);
  await page.getByRole('button', { name: '导出全部招募中文字' }).click();
  await page.waitForTimeout(500);
  await page.locator('.card', { hasText: '全部招募中导出预览' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '06-recruiting-export.png'), fullPage: false });

  // 7. 清理预览（时间+91天制造到期完成单：先直接建一个完成单）
  const oDone = (await (await mk({ parentName: '已完成家长', parentWechat: 'done_wx', parentPhone: '13611112222' })).json()).order;
  const aD = await app(oDone.id, {});
  await fetch(`${base}/api/applications/${aD.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'recommend', version: (await appGet(aD.id)).application.version }) });
  await fetch(`${base}/api/applications/${aD.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'schedule-trial', version: (await appGet(aD.id)).application.version, orderVersion: (await (await fetch(`${base}/api/orders/${oDone.id}`, { headers })).json()).order.version }) });
  await fetch(`${base}/api/applications/${aD.id}/finance`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ type: 'set-fees', operationId: crypto.randomUUID(), version: (await appGet(aD.id)).application.version, agencyFeeCents: 0, depositDueCents: 0 }) });
  const odD = (await (await fetch(`${base}/api/orders/${oDone.id}`, { headers })).json()).order;
  await fetch(`${base}/api/orders/${oDone.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'start-trial', version: odD.version }) });
  await fetch(`${base}/api/applications/${aD.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'pass', version: (await appGet(aD.id)).application.version, orderVersion: (await (await fetch(`${base}/api/orders/${oDone.id}`, { headers })).json()).order.version, confirmCooperation: true }) });
  const odD2 = (await (await fetch(`${base}/api/orders/${oDone.id}`, { headers })).json()).order;
  await fetch(`${base}/api/orders/${oDone.id}/actions`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'complete', version: odD2.version }) });
  // 时钟+91天
  await fetch(`${base}/api/test/clock`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ offsetMs: 91 * 24 * 3600 * 1000 }) });
  await page.goto(`${base}/#/maintenance`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '刷新预览' }).click();
  await page.waitForTimeout(500);
  await page.locator('.card', { hasText: '90天自动清理' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '07-cleanup-preview.png'), fullPage: false });
  // 时钟回0
  await fetch(`${base}/api/test/clock`, { method: 'POST', headers: h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ offsetMs: 0 }) });

  // 8. 备份列表
  await page.getByRole('button', { name: '立即备份' }).click();
  await page.waitForTimeout(1500);
  await page.locator('.card', { hasText: '备份列表' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '08-backup-list.png'), fullPage: false });

  // 9. 恢复预览
  const row = page.locator('.card', { hasText: '备份列表' }).locator('tr', { hasText: '手动' }).first();
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('button', { name: '下载' }).click()]);
  const tmpZip = path.join(dataDir, 'restore-test.zip');
  await download.saveAs(tmpZip);
  await page.locator('input[type="file"]').setInputFiles(tmpZip);
  await page.waitForTimeout(1200);
  await page.locator('.paste-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, '09-restore-preview.png'), fullPage: false });

  await browser.close();
  console.log('SCREENSHOTS-DONE');
} finally {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 1000);
}

function buildOrder(form, overrides) {
  const src = form ?? {};
  const o = {
    parentName: src.parentName ?? '王女士',
    parentWechat: src.parentWechat ?? 'wang_mom_2026',
    parentPhone: src.parentPhone ?? '138 0013 8000',
    childGrade: src.childGrade ?? '初三',
    subjects: src.subjects ?? '数学、物理',
    learningSituation: src.learningSituation ?? '基础薄弱',
    tutoringGoal: src.tutoringGoal ?? '巩固基础',
    teachingMode: src.teachingMode ?? 'offline',
    locationDetail: src.locationDetail ?? '阳光花园小区附近',
    publicArea: '城东·阳光花园片区',
    weeklySchedule: src.weeklySchedule ?? '周六下午、周日上午',
    publicSchedule: src.publicSchedule ?? '周末白天',
    sessionsPerWeek: src.sessionsPerWeek ?? 2,
    sessionMinutes: src.sessionMinutes ?? 90,
    expectedStartDate: src.expectedStartDate ?? '2026-10-15',
    hourlyPayCents: 15000,
    payNegotiable: true,
    genderPreference: src.genderPreference ?? 'female',
    teacherRequirements: src.teacherRequirements ?? '有初三带教经验',
    publicRequirements: '有教学经验、耐心',
    notes: '内部备注：家长急招',
    ...overrides,
  };
  if (o.hourlyPayCents === undefined && src.hourlyPayRaw) o.hourlyPayCents = Math.round(Number(src.hourlyPayRaw) * 100);
  return o;
}

function buildApp(overrides) {
  return {
    teacherName: '陈晓雨',
    gender: 'female',
    wechat: 'chen_xy',
    phone: '13711112222',
    university: '示范大学',
    major: '数学与应用数学',
    studyYear: '研一',
    teachableSubjectsGrades: '初中数学、高中数学',
    achievements: '高考数学142分（2023年，满分150）',
    teachingExperience: '初三学生数学，每周2次，共4个月',
    strengthsAndPlan: '先诊断薄弱章节，再按三步走：梳理→例题→限时训练',
    availableSchedule: '周六下午2点到4点，周日上午',
    earliestStartDate: '2026-10-12',
    acceptsOrderPay: true,
    expectedHourlyPayCents: null,
    canAttendTrial: true,
    trialConstraints: '',
    notes: '',
    ...overrides,
  };
}
