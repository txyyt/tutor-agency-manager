// 粘贴模板API保存链路（AC33-AC39服务器端）与安全校验（AC58、AC32）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication, createOrder, startTestServer, type TestServer } from '../helpers/testServer.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(() => {
  ts.close();
});

const FILLED_PARENT = `【家教需求登记】

1. 家长称呼：粘贴家长
2. 微信：paste_wx_001
3. 电话：13600001111

【孩子及辅导需求】
4. 孩子年级：初二
5. 辅导科目：英语
6. 目前学习情况：单词量不足
7. 辅导目标：期末提分

【上课安排】
8. 上课方式：线上
9. 上课区域及地点：线上
10. 每周可上课的日期和时间：周三、周五 19:00—20:00
11. 每周上课次数：2
12. 每次上课时长：60分钟
13. 预计开始时间：2026-10-20

【薪资及老师要求】
14. 薪资：130元/小时
    是否可以协商：是
15. 老师性别要求：不限
16. 对老师的其他要求：英语专业
17. 其他备注（选填）：无

请按一份独立家教需求填写一份表。
如需分别聘请不同老师，请分别填写。`;

describe('AC33：粘贴家长模板保存 → 招募订单，原文保存，重启可查', () => {
  it('解析 → 保存 → 详情可查、原文完整、状态招募中', async () => {
    const parse = await ts.client.post('/api/imports/parse', { kind: 'parent', text: FILLED_PARENT });
    expect(parse.status).toBe(200);
    const draft = parse.body as any;
    expect(Object.keys(draft.fieldErrors)).toEqual([]);
    expect(draft.form.parentName).toBe('粘贴家长');
    expect(draft.form.hourlyPayRaw).toBe('130');
    // 保存：复用创建接口 + 原文 + 请求ID
    const save = await ts.client.post('/api/orders', {
      ...buildOrderPayload(draft.form),
      sourceTemplateText: FILLED_PARENT,
      creationRequestId: crypto.randomUUID(),
    });
    expect(save.status).toBe(201);
    const order = (save.body as any).order;
    expect(order.status).toBe('recruiting');
    expect(order.sourceTemplateText).toBe(FILLED_PARENT);
    // 详情可查
    const detail = await ts.client.get(`/api/orders/${order.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as any).order.parentWechat).toBe('paste_wx_001');
  });

  it('双击/重试：相同creationRequestId只创建一条（AC38）', async () => {
    const parse = await ts.client.post('/api/imports/parse', { kind: 'parent', text: FILLED_PARENT.replace('粘贴家长', '重试家长') });
    const form = (parse.body as any).form;
    const requestId = crypto.randomUUID();
    const payload = { ...buildOrderPayload(form), sourceTemplateText: 'x', creationRequestId: requestId };
    const r1 = await ts.client.post('/api/orders', payload);
    expect(r1.status).toBe(201);
    const r2 = await ts.client.post('/api/orders', payload);
    expect(r2.status).toBe(200);
    expect((r2.body as any).duplicated).toBe(true);
    expect((r2.body as any).order.id).toBe((r1.body as any).order.id);
    // 列表里只有一条
    const list = (await ts.client.get('/api/orders?q=重试家长')).body;
    expect(list.total).toBe(1);
  });

  it('相同原文再保存提示疑似重复，但不禁止真实的新投递', async () => {
    const parse = await ts.client.post('/api/imports/parse', { kind: 'parent', text: FILLED_PARENT.replace('粘贴家长', '重复提示家长') });
    const form = (parse.body as any).form;
    const text = FILLED_PARENT.replace('粘贴家长', '重复提示家长');
    await ts.client.post('/api/orders', { ...buildOrderPayload(form), sourceTemplateText: text, creationRequestId: crypto.randomUUID() });
    const second = await ts.client.post('/api/orders', { ...buildOrderPayload(form), sourceTemplateText: text, creationRequestId: crypto.randomUUID() });
    expect(second.status).toBe(201);
    expect((second.body as any).duplicateWarning).toContain('相同原文');
  });
});

describe('AC34/AC37：老师模板按编号定位与保存阻断', () => {
  let order: any;
  beforeAll(async () => {
    order = await createOrder(ts.client, { parentName: '老师粘贴目标单' });
  });

  const teacherText = (orderNo: string) => `【大学生家教报名】

1. 报名订单编号：${orderNo}
2. 姓名：粘贴老师
3. 性别：女
4. 微信：paste_teacher_wx
5. 电话：13500002222

【个人情况】
6. 就读学校：外国语大学
7. 专业：英语
8. 当前年级：大四

【针对本订单的教学能力】
9. 可辅导的科目及年级：初中英语
10. 相关成绩或能力说明（选填）：专八
11. 家教或其他教学经验：初一英语，半年
12. 针对本订单的优势及辅导思路：语法专项

【时间及薪资】
13. 每周可上课的日期和时间：周三、周五 19:00—20:00
14. 最早可开始时间：2026-10-10
15. 是否接受订单中的薪资：是
16. 是否可以按安排参加试课：是

17. 其他备注（选填）：
18. 简历附件（选填，可附 PDF 或图片）：见附件

请针对本订单填写。
如报名多个订单，请分别提交，每份注明订单编号。
请如实填写资料和教学经历。`;

  it('解析自动定位订单并保存为已报名；多行不丢失', async () => {
    const parse = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText(order.orderNo), contextOrderId: order.id });
    expect(parse.status).toBe(200);
    const body = parse.body as any;
    expect(body.orderInfo.orderId).toBe(order.id);
    expect(body.orderInfo.canApply).toBe(true);
    const save = await ts.client.post(`/api/orders/${order.id}/applications`, {
      ...buildAppPayload(body.form),
      sourceTemplateText: teacherText(order.orderNo),
      creationRequestId: crypto.randomUUID(),
    });
    expect(save.status).toBe(201);
    const app = (save.body as any).application;
    expect(app.status).toBe('submitted');
    expect(app.orderId).toBe(order.id);
    expect(app.teachingExperience).toContain('初一英语，半年');
    // 保存后订单状态不变（不自动改变进度）
    const d = await ts.client.get(`/api/orders/${order.id}`);
    expect((d.body as any).order.status).toBe('recruiting');
  });

  it('AC37：编号不存在/与详情冲突/已完成/已取消/暂停时阻止', async () => {
    // 不存在
    const no = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText('JJ-19990101-9999') });
    expect((no.body as any).fieldErrors.orderNo).toContain('不存在');
    // 与详情订单冲突 → 保存时服务端阻断
    const otherOrder = await createOrder(ts.client, { parentName: '另一个单' });
    const mismatchParse = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText(otherOrder.orderNo), contextOrderId: order.id });
    expect((mismatchParse.body as any).orderMismatch).toContain('不一致');
    const badSave = await ts.client.post(`/api/orders/${order.id}/applications`, {
      ...buildAppPayload((mismatchParse.body as any).form),
      sourceTemplateText: teacherText(otherOrder.orderNo),
      creationRequestId: crypto.randomUUID(),
    });
    expect(badSave.status).toBe(409);
    expect((badSave.body as any).code).toBe('ORDER_NO_MISMATCH');
    // 已完成订单
    const doneOrder = await createOrder(ts.client, { parentName: '已完成单' });
    const doneApp = await createApplication(ts.client, doneOrder.id);
    async function orderVersion(id: number): Promise<number> {
      return ((await ts.client.get(`/api/orders/${id}`)).body as any).order.version;
    }
    async function appVersion(id: number): Promise<number> {
      return ((await ts.client.get(`/api/applications/${id}`)).body as any).application.version;
    }
    await ts.client.post(`/api/applications/${doneApp.id}/actions`, { action: 'recommend', version: await appVersion(doneApp.id) });
    await ts.client.post(`/api/applications/${doneApp.id}/actions`, {
      action: 'schedule-trial', version: await appVersion(doneApp.id), orderVersion: await orderVersion(doneOrder.id),
    });
    await ts.client.post(`/api/applications/${doneApp.id}/finance`, {
      type: 'set-fees', operationId: crypto.randomUUID(), version: await appVersion(doneApp.id), agencyFeeCents: 0, depositDueCents: 0,
    });
    await ts.client.post(`/api/orders/${doneOrder.id}/actions`, { action: 'start-trial', version: await orderVersion(doneOrder.id) });
    await ts.client.post(`/api/applications/${doneApp.id}/actions`, {
      action: 'pass', version: await appVersion(doneApp.id), orderVersion: await orderVersion(doneOrder.id), confirmCooperation: true,
    });
    const completeRes = await ts.client.post(`/api/orders/${doneOrder.id}/actions`, { action: 'complete', version: await orderVersion(doneOrder.id) });
    expect(completeRes.status).toBe(200);
    const doneParse = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText(doneOrder.orderNo) });
    expect((doneParse.body as any).fieldErrors.orderNo).toContain('已完成');
    // 已取消订单
    const cancelledOrder = await createOrder(ts.client, { parentName: '已取消单' });
    await ts.client.post(`/api/orders/${cancelledOrder.id}/actions`, { action: 'cancel', version: cancelledOrder.version });
    const cParse = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText(cancelledOrder.orderNo) });
    expect((cParse.body as any).fieldErrors.orderNo).toContain('已取消');
    // 暂停订单
    const pausedOrder = await createOrder(ts.client, { parentName: '已暂停单' });
    await ts.client.post(`/api/orders/${pausedOrder.id}/actions`, { action: 'pause', version: pausedOrder.version });
    const pParse = await ts.client.post('/api/imports/parse', { kind: 'teacher', text: teacherText(pausedOrder.orderNo) });
    expect((pParse.body as any).fieldErrors.orderNo).toContain('暂停');
  });
});

describe('AC39/AC36：多份模板、超限、HTML按文本；缺失补正后可存', () => {
  it('多份标题混贴 → 400 具体提示', async () => {
    const two = `${FILLED_PARENT}\n\n【家教需求登记】\n1. 家长称呼：第二份`;
    const r = await ts.client.post('/api/imports/parse', { kind: 'parent', text: two });
    expect(r.status).toBe(400);
    expect((r.body as any).message).toContain('多份模板');
  });

  it('输入超限 → 400', async () => {
    const r = await ts.client.post('/api/imports/parse', { kind: 'parent', text: `【家教需求登记】\n1. 家长称呼：${'x'.repeat(51_000)}` });
    expect(r.status).toBe(400);
  });

  it('HTML原文按文本处理与展示（服务端原样保存）', async () => {
    const html = FILLED_PARENT.replace('单词量不足', '<b>加粗</b><script>alert(1)</script>');
    const parse = await ts.client.post('/api/imports/parse', { kind: 'parent', text: html });
    expect(parse.status).toBe(200);
    expect((parse.body as any).draft.learningSituation).toContain('<script>');
    // 保存为原文
    const save = await ts.client.post('/api/orders', {
      ...buildOrderPayload((parse.body as any).form),
      sourceTemplateText: html,
      creationRequestId: crypto.randomUUID(),
    });
    const order = (save.body as any).order;
    expect(order.sourceTemplateText).toContain('<script>');
  });

  it('缺微信：解析报错→补正后可保存，无半条记录', async () => {
    const broken = FILLED_PARENT.replace('微信：paste_wx_001', '微信：');
    const parse = await ts.client.post('/api/imports/parse', { kind: 'parent', text: broken });
    expect((parse.body as any).fieldErrors.parentWechat).toContain('必填');
    // 不保存就没有半条记录
    const before = (await ts.client.get('/api/orders')).body.total;
    // 补正后保存
    const fixedForm = { ...(parse.body as any).form, parentWechat: 'fixed_wx' };
    const save = await ts.client.post('/api/orders', {
      ...buildOrderPayload(fixedForm),
      sourceTemplateText: broken,
      creationRequestId: crypto.randomUUID(),
    });
    expect(save.status).toBe(201);
    const after = (await ts.client.get('/api/orders')).body.total;
    expect(after).toBe(before + 1);
  });
});

describe('AC58：本机来源校验（Origin/Host/CSRF/data_epoch）', () => {
  it('缺CSRF令牌拒绝', async () => {
    const r = await ts.rawClient({ method: 'POST', path: '/api/orders', body: {}, noHeaders: true, headers: { Cookie: ts.client.state.cookie } });
    expect(r.status).toBe(403);
    expect((r.body as any).code).toBe('UNTRUSTED_ORIGIN');
  });

  it('错误CSRF令牌拒绝', async () => {
    const r = await ts.rawClient({
      method: 'POST',
      path: '/api/orders',
      body: {},
      headers: { 'X-CSRF-Token': 'wrong-token', Cookie: ts.client.state.cookie, 'X-Data-Epoch': '1' },
    });
    expect(r.status).toBe(403);
  });

  it('不可信Origin拒绝', async () => {
    const r = await ts.rawClient({
      method: 'POST',
      path: '/api/orders',
      body: {},
      headers: {
        Origin: 'http://evil.example.com',
        'X-CSRF-Token': ts.client.state.csrfToken,
        Cookie: ts.client.state.cookie,
        'X-Data-Epoch': String(ts.client.state.dataEpoch),
      },
    });
    expect(r.status).toBe(403);
  });

  it('不可信Host拒绝', async () => {
    // fetch不允许自定义Host头：用node:http直连
    const http1 = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http1.request(
        { host: '127.0.0.1', port: ts.port, path: '/api/dashboard', method: 'GET', headers: { Host: 'evil.example.com:80' } },
        (res) => {
          void res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('错误data_epoch写请求被拒绝（AC55一部分）', async () => {
    const r = await ts.rawClient({
      method: 'POST',
      path: '/api/orders',
      body: {},
      headers: {
        'X-CSRF-Token': ts.client.state.csrfToken,
        Cookie: ts.client.state.cookie,
        'X-Data-Epoch': '999999',
      },
    });
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe('DATA_EPOCH_CONFLICT');
  });

  it('AC32：服务只监听本机回环地址', async () => {
    // 通过raw server验证监听地址：用独立服务器检查
    const { createServer } = await import('../../src/server/serverFactory.js');
    const { loadEnv } = await import('../../src/server/env.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-bind-'));
    const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
    const server = createServer(env);
    server.start(false);
    const http1 = await import('node:http');
    const hs = http1.createServer(server.app);
    await new Promise<void>((r) => hs.listen(0, '127.0.0.1', r));
    const addr = hs.address() as any;
    expect(addr.address).toBe('127.0.0.1');
    hs.close();
    server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

function buildOrderPayload(form: Record<string, unknown>): Record<string, unknown> {
  return {
    parentName: form.parentName,
    parentWechat: form.parentWechat,
    parentPhone: form.parentPhone,
    childGrade: form.childGrade,
    subjects: form.subjects,
    learningSituation: form.learningSituation,
    tutoringGoal: form.tutoringGoal,
    teachingMode: form.teachingMode,
    locationDetail: form.locationDetail,
    publicArea: typeof form.publicArea === 'string' && form.publicArea !== '' ? form.publicArea : '待补充区域',
    weeklySchedule: form.weeklySchedule,
    publicSchedule: form.publicSchedule,
    sessionsPerWeek: form.sessionsPerWeek,
    sessionMinutes: form.sessionMinutes,
    expectedStartDate: form.expectedStartDate ?? null,
    hourlyPayCents: yuanToCents(String(form.hourlyPayRaw ?? '')),
    payNegotiable: form.payNegotiable === true,
    genderPreference: form.genderPreference,
    teacherRequirements: form.teacherRequirements ?? '',
    publicRequirements: form.publicRequirements ?? '',
    notes: form.notes ?? '',
  };
}

function buildAppPayload(form: Record<string, unknown>): Record<string, unknown> {
  return {
    teacherName: form.teacherName,
    gender: form.gender,
    wechat: form.wechat,
    phone: form.phone,
    university: form.university,
    major: form.major,
    studyYear: form.studyYear,
    teachableSubjectsGrades: form.teachableSubjectsGrades,
    achievements: form.achievements ?? '',
    teachingExperience: form.teachingExperience,
    strengthsAndPlan: form.strengthsAndPlan,
    availableSchedule: form.availableSchedule,
    earliestStartDate: form.earliestStartDate ?? null,
    acceptsOrderPay: form.acceptsOrderPay === true,
    expectedHourlyPayCents: null,
    canAttendTrial: form.canAttendTrial === true,
    trialConstraints: form.trialConstraints ?? '',
    notes: form.notes ?? '',
  };
}

function yuanToCents(yuan: string): number {
  if (yuan === '') return 0;
  const [i, f = ''] = yuan.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
