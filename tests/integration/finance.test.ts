// 财务收退幂等与更正（AC18、AC19、AC20、AC53、AC59）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appAction,
  createApplication,
  createOrder,
  doFinance,
  getDetail,
  startTestServer,
  TestClient,
  type TestServer,
} from '../helpers/testServer.js';
import { createServer } from '../../src/server/serverFactory.js';
import { loadEnv } from '../../src/server/env.js';
import crypto from 'node:crypto';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(() => {
  ts.close();
});

async function setupWithDeposit() {
  const order = await createOrder(ts.client, { parentName: `财务-${crypto.randomUUID().slice(0, 6)}` });
  const a = await createApplication(ts.client, order.id);
  await appAction(ts.client, a.id, 'recommend');
  await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
  await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30000, depositDueCents: 10000 });
  return { order, a };
}

describe('AC18：非法金额拒绝、重复请求不重复加钱', () => {
  it('负数金额拒绝', async () => {
    const { a } = await setupWithDeposit();
    const r = await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: -100 });
    expect(r.status).toBe(400);
    expect((r.body as any).code).toBe('INVALID_AMOUNT');
  });

  it('三位小数（非法分值）在表单层拒绝：非整数分拒绝', async () => {
    const { a } = await setupWithDeposit();
    const r = await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10.5 });
    expect(r.status).toBe(400);
  });

  it('超过计划保证金拒绝', async () => {
    const { a } = await setupWithDeposit();
    const r = await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10001 });
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe('AMOUNT_EXCEEDS_PLAN');
  });

  it('相同operationId相同载荷重放不重复加钱；不同载荷拒绝（AC53前半）', async () => {
    const { a } = await setupWithDeposit();
    const opId = crypto.randomUUID();
    const freshVersion = (await (await ts.client.get(`/api/applications/${a.id}`)).body).application.version;
    const first = await ts.client.post(`/api/applications/${a.id}/finance`, {
      type: 'receive-deposit',
      operationId: opId,
      version: freshVersion,
      amountCents: 10000,
    });
    expect(first.status).toBe(200);
    expect((first.body as any).applied).toBe(true);
    // 重放（带旧version也必须安全重放）
    const replay = await ts.client.post(`/api/applications/${a.id}/finance`, {
      type: 'receive-deposit',
      operationId: opId,
      version: a.version,
      amountCents: 10000,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as any).applied).toBe(false);
    // 相同ID不同载荷
    const conflict = await ts.client.post(`/api/applications/${a.id}/finance`, {
      type: 'receive-deposit',
      operationId: opId,
      version: a.version,
      amountCents: 5000,
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body as any).code).toBe('OPERATION_ID_CONFLICT');
    // 净收仍为100元
    const d = await getDetail(ts.client, a.orderId);
    expect(d.applications.find((x: any) => x.id === a.id).finance.depositReceivedCents).toBe(10000);
  });
});

describe('AC19：小额精确与免费个案', () => {
  it('0.10/0.20分次收齐可完成', async () => {
    const order = await createOrder(ts.client, { parentName: '小额家长' });
    const a = await createApplication(ts.client, order.id);
    await appAction(ts.client, a.id, 'recommend');
    await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30, depositDueCents: 10 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10 });
    const d1 = await getDetail(ts.client, order.id);
    await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d1.order.version });
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    await doFinance(ts.client, a.id, { type: 'receive-supplement', version: a.version, amountCents: 20 });
    const d = await getDetail(ts.client, order.id);
    const done = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    expect(done.status).toBe(200);
  });

  it('收费空值不能完成；明确免费（F=0）且确认可完成', async () => {
    const order = await createOrder(ts.client, { parentName: '免费个案家长' });
    const a = await createApplication(ts.client, order.id);
    await appAction(ts.client, a.id, 'recommend');
    await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
    // 未设费用：开始试课就拒绝
    let d = await getDetail(ts.client, order.id);
    const startBlock = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    expect(startBlock.status).toBe(409);
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 0, depositDueCents: 0 });
    d = await getDetail(ts.client, order.id);
    await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    const done = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: (await getDetail(ts.client, order.id)).order.version });
    expect(done.status).toBe(200);
  });
});

describe('AC20/AC59：下调收费产生合法待退；计划保证金相容性', () => {
  it('收款后下调费用显示待退；补款退款后净收正确', async () => {
    const { order, a } = await setupWithDeposit();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10000 });
    // 下调F到50元（保证金计划也调整为50元相容）
    const adjust = await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 5000, depositDueCents: 5000 });
    expect(adjust.status).toBe(200);
    let d = await getDetail(ts.client, order.id);
    // 确认后超收50元 → 待退
    await startTrial();
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    d = await getDetail(ts.client, order.id);
    const after = d.applications.find((x: any) => x.id === a.id);
    expect(after.finance.pendingRefundCents).toBe(5000); // N=100 > F=50
    // 退补款路径：退保证金50元
    await doFinance(ts.client, a.id, { type: 'refund-deposit', version: a.version, amountCents: 5000 });
    d = await getDetail(ts.client, order.id);
    const settled = d.applications.find((x: any) => x.id === a.id);
    expect(settled.finance.netReceivedCents).toBe(5000);
    expect(settled.finance.settled).toBe(true);
    const done = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: (await getDetail(ts.client, order.id)).order.version });
    expect(done.status).toBe(200);
  });

  it('计划保证金不能超过中介费（AC59）', async () => {
    const { a } = await setupWithDeposit();
    const r = await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 10000, depositDueCents: 20000 });
    expect(r.status).toBe(409);
  });

  it('F/计划保证金缺失不能开始试课（AC59）', async () => {
    const order2 = await createOrder(ts.client, { parentName: '未设费家长' });
    const a2 = await createApplication(ts.client, order2.id);
    await appAction(ts.client, a2.id, 'recommend');
    await appAction(ts.client, a2.id, 'schedule-trial', { orderVersion: order2.version });
    const d = await getDetail(ts.client, order2.id);
    const r = await ts.client.post(`/api/orders/${order2.id}/actions`, { action: 'start-trial', version: d.order.version });
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe('FEES_NOT_SET');
  });
});

describe('AC53：财务幂等跨进程重启仍有效；更正登记带理由', () => {
  it('重启后相同operationId重放不重复加钱', async () => {
    // 独立数据目录+可重启服务
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-restart-'));
    delete process.env.APP_ALLOW_TIME_CONTROL;

    const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
    const server1 = createServer(env);
    server1.start(false);
    const http1 = await import('node:http');
    const s1 = http1.createServer(server1.app);
    await new Promise<void>((r) => s1.listen(0, '127.0.0.1', r));
    const port = (s1.address() as any).port;
    const c1 = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c1.bootstrap();

    const orderRes = await c1.post('/api/orders', {
      parentName: '重启家长', parentWechat: 'rw', parentPhone: '13800000001',
      childGrade: '高一', subjects: '化学', learningSituation: '一般', tutoringGoal: '提高',
      teachingMode: 'online', locationDetail: '线上', publicArea: '线上',
      weeklySchedule: '周末', publicSchedule: '周末', sessionsPerWeek: 1, sessionMinutes: 60,
      hourlyPayCents: 10000, payNegotiable: false, genderPreference: 'any',
    });
    const order = (orderRes.body as any).order;
    const appRes = await c1.post(`/api/orders/${order.id}/applications`, {
      teacherName: '重启老师', gender: 'male', wechat: 'rt', phone: '13900000001',
      university: '某大学', major: '化学', studyYear: '研二',
      teachableSubjectsGrades: '高中化学', teachingExperience: '暂无', strengthsAndPlan: '按计划',
      availableSchedule: '周末', acceptsOrderPay: true, canAttendTrial: true,
    });
    const a = (appRes.body as any).application;
    async function appVersion(client: TestClient, id: number): Promise<number> {
      return (await (await client.get(`/api/applications/${id}`)).body).application.version;
    }
    await c1.post(`/api/applications/${a.id}/actions`, { action: 'recommend', version: a.version });
    await c1.post(`/api/applications/${a.id}/actions`, { action: 'schedule-trial', version: await appVersion(c1, a.id), orderVersion: order.version });
    await c1.post(`/api/applications/${a.id}/finance`, {
      type: 'set-fees', operationId: crypto.randomUUID(), version: await appVersion(c1, a.id), agencyFeeCents: 10000, depositDueCents: 5000,
    });
    const opId = crypto.randomUUID();
    await c1.post(`/api/applications/${a.id}/finance`, { type: 'receive-deposit', operationId: opId, version: await appVersion(c1, a.id), amountCents: 5000 });

    // 重启
    s1.close();
    server1.stop();
    const server2 = createServer(env);
    server2.start(false);
    const s2 = http1.createServer(server2.app);
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const port2 = (s2.address() as any).port;
    const c2 = new TestClient(port2, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c2.bootstrap();

    const detail = (await c2.get(`/api/orders/${order.id}`)).body;
    const app2 = detail.applications[0];
    expect(app2.finance.depositReceivedCents).toBe(5000);
    expect(app2.version).toBe(a.version + 4); // 推荐、安排试课、设费、收款各+1，重启后版本保留
    const replay = await c2.post(`/api/applications/${a.id}/finance`, {
      type: 'receive-deposit', operationId: opId, version: app2.version, amountCents: 5000,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as any).applied).toBe(false);
    const after = (await c2.get(`/api/orders/${order.id}`)).body;
    expect(after.applications[0].finance.depositReceivedCents).toBe(5000);

    s2.close();
    server2.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('更正登记：带理由、记录前后值；真实退款不能被伪造退款替代', async () => {
    const { order, a } = await setupWithDeposit();
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10000 });
    const freshV = async (): Promise<number> =>
      (await (await ts.client.get(`/api/applications/${a.id}`)).body).application.version;
    // 无理由拒绝
    const noReason = await ts.client.post(`/api/applications/${a.id}/finance/corrections`, {
      operationId: crypto.randomUUID(),
      version: await freshV(),
      reason: '  ',
      corrected: { depositReceivedCents: 5000 },
    });
    expect(noReason.status).toBe(400);
    // 带理由更正：把误登的100元改为50元
    const r = await ts.client.post(`/api/applications/${a.id}/finance/corrections`, {
      operationId: crypto.randomUUID(),
      version: await freshV(),
      reason: '登记时多按一个0',
      corrected: { depositReceivedCents: 5000 },
    });
    expect(r.status).toBe(200);
    expect((r.body as any).applied).toBe(true);
    const d = await getDetail(ts.client, order.id);
    const app = d.applications.find((x: any) => x.id === a.id);
    expect(app.finance.depositReceivedCents).toBe(5000);
    expect(app.financeOperations.some((o: any) => o.type === 'correction' && (o.reason ?? '').includes('多按一个0'))).toBe(true);
    // 退款不能为负、不能超收款
    const bad = await doFinance(ts.client, a.id, { type: 'refund-deposit', version: app.version, amountCents: 99999 });
    expect(bad.status).toBe(409);
    // 更正后累计退款不能超过累计收款
    const badCorr = await ts.client.post(`/api/applications/${a.id}/finance/corrections`, {
      operationId: crypto.randomUUID(),
      version: await freshV(),
      reason: '试图把退款改得比收款还多',
      corrected: { depositRefundedCents: 99999 },
    });
    expect(badCorr.status).toBe(409);
  });
});
