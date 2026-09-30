// 匹配流程与状态一致性（AC10-AC17、AC50-AC52）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appAction,
  createApplication,
  createOrder,
  doFinance,
  getDetail,
  startTestServer,
  type TestServer,
} from '../helpers/testServer.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(() => {
  ts.close();
});

async function fullTrialSetup() {
  const order = await createOrder(ts.client, { parentName: `试课流程家长-${Date.now()}-${Math.random()}` });
  const a = await createApplication(ts.client, order.id);
  await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
  return { order, a };
}

describe('AC10：安排试课互斥与保证金门槛', () => {
  it('A待试课后不能再安排B', async () => {
    const { order, a } = await fullTrialSetup();
    const b = await createApplication(ts.client, order.id, { teacherName: '候选B' });
    const freshOrderVersion = (await getDetail(ts.client, order.id)).order.version;
    const r = await ts.client.post(`/api/applications/${b.id}/actions`, {
      action: 'schedule-trial',
      version: b.version,
      orderVersion: freshOrderVersion,
    });
    expect(r.status).toBe(409);
    expect((r.body as any).code).toBe('CURRENT_EXISTS');
    // A仍是当前
    const d = await getDetail(ts.client, order.id);
    expect(d.order.currentApplicationId).toBe(a.id);
  });

  it('少收保证金不能开始试课；收齐后开始，订单试课中、报名仍待试课', async () => {
    const { order, a } = await fullTrialSetup();
    // 未设费用就开始 → 拒绝
    const noFees = await orderStartTrial(order.id);
    expect(noFees.status).toBe(409);
    expect((noFees.body as any).code).toBe('FEES_NOT_SET');
    // 设F=300元、保证金100元
    const setFees = await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30000, depositDueCents: 10000 });
    expect(setFees.status).toBe(200);
    // 少收（只收50元）不能开始
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    const insufficient = await orderStartTrial(order.id);
    expect(insufficient.status).toBe(409);
    expect((insufficient.body as any).code).toBe('DEPOSIT_INSUFFICIENT');
    // 收齐100元后可以开始
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    const start = await orderStartTrial(order.id);
    expect(start.status).toBe(200);
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('trialing');
    expect(d.applications.find((x: any) => x.id === a.id).status).toBe('awaiting_trial');
  });

  async function orderStartTrial(orderId: number) {
    const d = await getDetail(ts.client, orderId);
    return ts.client.post(`/api/orders/${orderId}/actions`, { action: 'start-trial', version: d.order.version });
  }
});

describe('AC11/AC12：通过确认补款结清完成；缺条件时给出具体原因', () => {
  it('F300、保证金100 → 通过+确认 → 待补200 → 补齐 → 完成，其他候选结束', async () => {
    const { order, a } = await fullTrialSetup();
    async function orderActionStart() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    async function tryComplete() {
      const d = await getDetail(ts.client, order.id);
      return ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    }
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30000, depositDueCents: 10000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10000 });
    await orderActionStart();
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version });

    // 未确认合作时不能完成
    const beforeConfirm = await tryComplete();
    expect(beforeConfirm.status).toBe(409);
    expect((beforeConfirm.body as any).message).toContain('确认合作');

    await appAction(ts.client, a.id, 'confirm-cooperation', {});
    // 未结清不能完成，提示还差金额
    const blocked = await tryComplete();
    expect(blocked.status).toBe(409);
    expect((blocked.body as any).message).toContain('200');

    // 一次补款超过待补被拒绝
    const over = await doFinance(ts.client, a.id, { type: 'receive-supplement', version: a.version, amountCents: 25000 });
    expect(over.status).toBe(409);
    // 补200后可完成
    await doFinance(ts.client, a.id, { type: 'receive-supplement', version: a.version, amountCents: 20000 });
    const done = await tryComplete();
    expect(done.status).toBe(200);
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('completed');
    expect(d.order.matchedApplicationId).toBe(a.id);
    expect(d.order.currentApplicationId).toBe(a.id);
    const app = d.applications.find((x: any) => x.id === a.id);
    expect(app.status).toBe('trial_passed');
    expect(app.finance.settled).toBe(true);
  });

  it('完成后禁止退出/取消，费用锁定', async () => {
    const { order, a } = await fullTrialSetup();
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 0, depositDueCents: 0 });
    await orderActionStart();
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    const done = await tryComplete();
    expect(done.status).toBe(200);
    const withdraw = await ts.client.post(`/api/applications/${a.id}/actions`, {
      action: 'withdraw',
      version: a.version,
      orderVersion: (await getDetail(ts.client, order.id)).order.version,
    });
    expect(withdraw.status).toBe(409);
    const cancel = await ts.client.post(`/api/orders/${order.id}/actions`, {
      action: 'cancel',
      version: (await getDetail(ts.client, order.id)).order.version,
    });
    expect(cancel.status).toBe(409);
    // 完成后不能再收款
    const finance = await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 100 });
    expect(finance.status).toBe(409);

    async function orderActionStart() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    async function tryComplete() {
      const d = await getDetail(ts.client, order.id);
      return ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    }
  });

  it('AC12：未确认/未结清的完成提示具体报名与缺少条件', async () => {
    const { order, a } = await fullTrialSetup();
    async function orderStartTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    async function tryComplete() {
      const d = await getDetail(ts.client, order.id);
      return ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    }
    const b = await createApplication(ts.client, order.id, { teacherName: '有尾款候选' });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 20000, depositDueCents: 10000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10000 });
    // 给其他报名违规收款？不允许——其他候选不能收保证金（规则11）
    const illegal = await doFinance(ts.client, b.id, { type: 'receive-deposit', version: b.version, amountCents: 5000 });
    expect(illegal.status).toBe(409);
    // 未开始试课直接pass被拒绝（AC52部分）
    const earlyPass = await ts.client.post(`/api/applications/${a.id}/actions`, {
      action: 'pass',
      version: a.version,
      orderVersion: (await getDetail(ts.client, order.id)).order.version,
    });
    expect(earlyPass.status).toBe(409);
    await orderStartTrial();
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    // 未结清（还差100元）时不能完成
    const blocked = await tryComplete();
    expect(blocked.status).toBe(409);
    expect((blocked.body as any).message).toContain('未结清');
    await doFinance(ts.client, a.id, { type: 'receive-supplement', version: a.version, amountCents: 10000 });
    const done = await tryComplete();
    expect(done.status).toBe(200);
  });
});

describe('AC13/AC14：失败与退出退保证金、清引用', () => {
  it('A未通过不填原因，退100清零、清当前引用，可安排B成交', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    const b = await createApplication(ts.client, order.id, { teacherName: '后备老师B' });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30000, depositDueCents: 10000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 10000 });
    await startTrial();
    await appAction(ts.client, a.id, 'fail', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    let d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('reviewing'); // 默认回挑选
    expect(d.order.currentApplicationId).toBeNull();
    const aAfter = d.applications.find((x: any) => x.id === a.id);
    expect(aAfter.status).toBe('trial_failed');
    expect(aAfter.finance.pendingRefundCents).toBe(10000);
    // 未退清时不能安排B（b还没费用，先退款）
    await doFinance(ts.client, a.id, { type: 'refund-deposit', version: a.version, amountCents: 10000 });
    d = await getDetail(ts.client, order.id);
    expect(d.applications.find((x: any) => x.id === a.id).finance.netReceivedCents).toBe(0);
    await appAction(ts.client, b.id, 'schedule-trial', { orderVersion: d.order.version });
    d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('awaiting_trial');
    expect(d.order.currentApplicationId).toBe(b.id);
  });

  it('主动退出：保留退出状态，费用成为待退款（AC14、AC51）', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 20000, depositDueCents: 5000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    await startTrial();
    await appAction(ts.client, a.id, 'withdraw', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('reviewing');
    expect(d.order.currentApplicationId).toBeNull();
    const aAfter = d.applications.find((x: any) => x.id === a.id);
    expect(aAfter.status).toBe('withdrawn');
    expect(aAfter.finance.pendingRefundCents).toBe(5000);
  });

  it('AC51：非当前候选退出不影响正在试课的当前老师', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    const b = await createApplication(ts.client, order.id, { teacherName: '围观候选' });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 0, depositDueCents: 0 });
    await startTrial();
    await appAction(ts.client, b.id, 'withdraw', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('trialing'); // 当前试课不受影响
    expect(d.order.currentApplicationId).toBe(a.id);
    expect(d.applications.find((x: any) => x.id === b.id).status).toBe('withdrawn');
  });
});

describe('AC15/AC17：取消产生待退、未退清不能完成/清理', () => {
  it('取消结束报名并产生待退款，不能假装已退', async () => {
    const { order, a } = await fullTrialSetup();
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 20000, depositDueCents: 5000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    const cancel = await ts.client.post(`/api/orders/${order.id}/actions`, {
      action: 'cancel',
      version: (await getDetail(ts.client, order.id)).order.version,
    });
    expect(cancel.status).toBe(200);
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('cancelled');
    expect(d.order.currentApplicationId).toBeNull();
    const aAfter = d.applications.find((x: any) => x.id === a.id);
    expect(aAfter.status).toBe('order_closed');
    expect(aAfter.finance.pendingRefundCents).toBe(5000);
    // 取消后禁止收款，只能退款
    const receive = await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 100 });
    expect(receive.status).toBe(409);
    // 清理预览受保护：未到期的取消单不进入候选（款项未退清时也绝不可删）
    const preview = await ts.client.get('/api/cleanup/preview');
    const body = preview.body as any;
    expect(body.candidates.some((c: any) => c.type === 'order')).toBe(false);
    expect(body.protectedItems.some((p: any) => p.no.includes('JJ-') && p.reason.includes('已取消'))).toBe(true);
  });

  it('AC17：A待退未处理时不能完成，退清后才可完成', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    async function tryComplete() {
      const d = await getDetail(ts.client, order.id);
      return ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    }
    const b = await createApplication(ts.client, order.id, { teacherName: '成交候选' });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 20000, depositDueCents: 5000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    await startTrial();
    await appAction(ts.client, a.id, 'fail', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    // A待退5000
    await appAction(ts.client, b.id, 'schedule-trial', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    await doFinance(ts.client, b.id, { type: 'set-fees', version: b.version, agencyFeeCents: 20000, depositDueCents: 0 });
    await startTrial();
    await appAction(ts.client, b.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
    // 成交老师b费用未结清（F=200、净收0）→ 也应阻断并提示
    const blockedB = await tryComplete();
    expect(blockedB.status).toBe(409);
    expect((blockedB.body as any).message).toContain('成交报名费用未结清');
    await doFinance(ts.client, b.id, { type: 'receive-supplement', amountCents: 20000 });
    // A待退未退清 → 阻断并提示具体报名
    const blocked = await tryComplete();
    expect(blocked.status).toBe(409);
    expect((blocked.body as any).message).toContain(a.applicationNo);
    await doFinance(ts.client, a.id, { type: 'refund-deposit', version: a.version, amountCents: 5000 });
    const done = await tryComplete();
    expect(done.status).toBe(200);
  });
});

describe('AC16/AC50/AC52：直接合作与状态一致性', () => {
  it('直接合作：无试课，确认合作+结清后可完成', async () => {
    const order = await createOrder(ts.client, { parentName: '直接合作家长' });
    const a = await createApplication(ts.client, order.id);
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 30000, depositDueCents: 10000 });
    // 未安排试课（订单招募中）不能收保证金——保证金只面向当前待试课报名
    const earlyDeposit = await doFinance(ts.client, a.id, { type: 'receive-deposit', amountCents: 10000 });
    expect(earlyDeposit.status).toBe(409);
    // 未开始试课直接pass被拒绝
    const earlyPass = await ts.client.post(`/api/applications/${a.id}/actions`, {
      action: 'pass',
      version: a.version,
      orderVersion: order.version,
    });
    expect(earlyPass.status).toBe(409);
    await appAction(ts.client, a.id, 'direct-cooperation', { orderVersion: order.version });
    let d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('reviewing'); // 不是假造试课中
    expect(d.applications.find((x: any) => x.id === a.id).status).toBe('direct_cooperation');
    expect(d.applications.find((x: any) => x.id === a.id).cooperationConfirmedAt).toBeTruthy();
    // 双方直接确认合作后收取中介费300元（全额补收）
    const sup = await doFinance(ts.client, a.id, { type: 'receive-supplement', amountCents: 30000 });
    expect(sup.status).toBe(200);
    d = await getDetail(ts.client, order.id);
    expect(d.applications[0].finance.netReceivedCents).toBe(30000);
    const done = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
    expect(done.status).toBe(200);
  });

  it('AC50：通过后订单不再试课中，显示待确认/结算；当前引用存在时不能继续招募/暂停/换人', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 10000, depositDueCents: 0 });
    await startTrial();
    await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    const d = await getDetail(ts.client, order.id);
    expect(d.order.status).toBe('reviewing');
    expect(d.order.currentApplicationId).toBe(a.id); // 保留引用等待完成
    const c = await createApplication(ts.client, order.id, { teacherName: '后来候选' });
    const recruit = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'recruit', version: d.order.version });
    expect(recruit.status).toBe(409);
    const pause = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'pause', version: d.order.version });
    expect(pause.status).toBe(409);
    const switchTrial = await ts.client.post(`/api/applications/${c.id}/actions`, {
      action: 'schedule-trial',
      version: c.version,
      orderVersion: d.order.version,
    });
    expect(switchTrial.status).toBe(409);
    const secondDirect = await ts.client.post(`/api/applications/${c.id}/actions`, {
      action: 'direct-cooperation',
      version: c.version,
      orderVersion: d.order.version,
    });
    expect(secondDirect.status).toBe(409);
  });

  it('AC52：非法组合事务拒绝（终止记录不能标推荐；暂停态不能安排试课）', async () => {
    const { order, a } = await fullTrialSetup();
    async function startTrial() {
      const d = await getDetail(ts.client, order.id);
      await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
    }
    const b = await createApplication(ts.client, order.id, { teacherName: '推荐测试' });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 0, depositDueCents: 0 });
    await startTrial();
    await appAction(ts.client, a.id, 'fail', { orderVersion: (await getDetail(ts.client, order.id)).order.version });
    // trial_failed 不能标推荐
    const rec = await ts.client.post(`/api/applications/${a.id}/actions`, {
      action: 'recommend',
      version: a.version,
    });
    expect(rec.status).toBe(409);
    // 暂停后不能安排试课
    const d = await getDetail(ts.client, order.id);
    await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'pause', version: d.order.version });
    const schedule = await ts.client.post(`/api/applications/${b.id}/actions`, {
      action: 'schedule-trial',
      version: b.version,
      orderVersion: (await getDetail(ts.client, order.id)).order.version,
    });
    expect(schedule.status).toBe(409);
  });
});
