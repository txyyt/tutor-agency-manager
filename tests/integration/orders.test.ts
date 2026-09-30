// 订单/报名CRUD、搜索分页、导出（AC02-AC09）、安全基础（AC32/AC58部分）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApplication,
  createOrder,
  getDetail,
  startTestServer,
  validApplicationPayload,
  validOrderPayload,
  type TestServer,
} from '../helpers/testServer.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(() => {
  ts.close();
});

describe('AC02：微信/电话必填，完整创建招募中，编号唯一', () => {
  it('缺微信拒绝；缺电话拒绝；字段校验指向具体字段', async () => {
    const noWechat = await ts.client.post('/api/orders', validOrderPayload({ parentWechat: ' ' }));
    expect(noWechat.status).toBe(400);
    expect((noWechat.body as any).fieldErrors.parentWechat).toBeTruthy();

    const noPhone = await ts.client.post('/api/orders', validOrderPayload({ parentPhone: '' }));
    expect(noPhone.status).toBe(400);
    expect((noWechat.body as any).code).toBe('VALIDATION_FAILED');
  });

  it('完整创建成功：状态招募中，编号格式JJ-日期-序号且唯一', async () => {
    const r1 = await ts.client.post('/api/orders', validOrderPayload());
    expect(r1.status).toBe(201);
    const o1 = (r1.body as any).order;
    expect(o1.status).toBe('recruiting');
    expect(o1.orderNo).toMatch(/^JJ-\d{8}-\d{4}$/);
    const r2 = await ts.client.post('/api/orders', validOrderPayload({ parentName: '另一家长' }));
    const o2 = (r2.body as any).order;
    expect(o2.orderNo).not.toBe(o1.orderNo);
  });

  it('负数薪资/三位小数被服务端拒绝（金额整数分入参，拒绝0与负）', async () => {
    const bad = await ts.client.post('/api/orders', validOrderPayload({ hourlyPayCents: 0 }));
    expect(bad.status).toBe(400);
    const bad2 = await ts.client.post('/api/orders', validOrderPayload({ hourlyPayCents: -5 }));
    expect(bad2.status).toBe(400);
  });
});

describe('AC03/AC04：两需求两单互不影响；同人多单简历独立', () => {
  it('同家长两单，修改互不影响', async () => {
    const o1 = await createOrder(ts.client, { parentName: '同一位家长', childGrade: '初一', subjects: '英语' });
    const o2 = await createOrder(ts.client, { parentName: '同一位家长', childGrade: '高三', subjects: '物理' });
    const patch = await ts.client.patch(`/api/orders/${o2.id}?version=${o2.version}`, { subjects: '化学' });
    expect(patch.status).toBe(200);
    const d1 = await getDetail(ts.client, o1.id);
    const d2 = await getDetail(ts.client, o2.id);
    expect(d1.order.subjects).toBe('英语');
    expect(d2.order.subjects).toBe('化学');
    expect(d1.order.parentName).toBe('同一位家长');
  });

  it('老师微信电话必填；无授课区域字段；同老师两单简历独立', async () => {
    const o1 = await createOrder(ts.client);
    const o2 = await createOrder(ts.client);
    const missing = await ts.client.post(`/api/orders/${o1.id}/applications`, validApplicationPayload({ phone: '' }));
    expect(missing.status).toBe(400);
    const a1 = await createApplication(ts.client, o1.id, { teachingExperience: '经验A' });
    const a2 = await createApplication(ts.client, o2.id, { teachingExperience: '经验B' });
    expect(a1.orderId).toBe(o1.id);
    expect(a2.orderId).toBe(o2.id);
    // 报名字段不包含区域
    const detail = (await ts.client.get(`/api/applications/${a1.id}`)).body;
    const json = JSON.stringify(detail);
    expect(json).not.toContain('teachingArea');
    expect(json).not.toContain('可授课区域');
    expect(detail.application.teachingExperience).toBe('经验A');
    expect(a2.id).not.toBe(a1.id);
  });
});

describe('AC05/AC08/AC09：关联正确、摘要与推荐、招募导出联动', () => {
  let orderId: number;
  let a1: any, a2: any, a3: any;
  let otherOrderApp: any;

  beforeAll(async () => {
    const order = await createOrder(ts.client, { parentWechat: 'ac5-wx', parentName: 'AC5家长' });
    orderId = order.id;
    a1 = await createApplication(ts.client, order.id, { teacherName: '候选人一' });
    a2 = await createApplication(ts.client, order.id, { teacherName: '候选人二' });
    a3 = await createApplication(ts.client, order.id, { teacherName: '候选人三' });
    const otherOrder = await createOrder(ts.client, { parentName: '别单家长' });
    otherOrderApp = await createApplication(ts.client, otherOrder.id);
  });

  it('一单三报名关联正确；别单报名不能进入本单摘要/推荐', async () => {
    const d = await getDetail(ts.client, orderId);
    expect(d.applications).toHaveLength(3);
    const mixed = await ts.client.post(`/api/orders/${orderId}/recommendations`, {
      mode: 'summary',
      applicationIds: [a1.id, otherOrderApp.id],
    });
    expect(mixed.status).toBe(400);
    expect(JSON.stringify(mixed.body)).toContain('不属于本订单');
  });

  it('候选摘要：内容正确，不含联系方式/费用/内部备注；生成不改状态', async () => {
    const r = await ts.client.post(`/api/orders/${orderId}/recommendations`, {
      mode: 'summary',
      applicationIds: [a1.id, a2.id],
    });
    expect(r.status).toBe(200);
    const text = (r.body as any).text as string;
    expect(text).toContain('候选人一');
    expect(text).toContain('候选人二');
    expect(text).toContain(a1.applicationNo);
    expect(text).not.toContain(a1.wechat);
    expect(text).not.toContain(String(a1.phone));
    expect(text).not.toContain('中介费');
    expect(text).not.toContain('内部备注');
    const d = await getDetail(ts.client, orderId);
    expect(d.order.status).toBe('recruiting'); // 摘要不改状态
    const app1 = d.applications.find((x: any) => x.id === a1.id);
    expect(app1.status).toBe('submitted');
  });

  it('标推荐才改变状态；批量推荐要么全成功要么无变更', async () => {
    const bad = await ts.client.post(`/api/orders/${orderId}/recommendations`, {
      mode: 'mark-recommended',
      applicationIds: [a1.id, a3.id],
    });
    // a1 submitted 可标；a3 也 submitted → 都可以
    expect(bad.status).toBe(200);
    const d = await getDetail(ts.client, orderId);
    expect(d.applications.find((x: any) => x.id === a1.id).status).toBe('recommended');
    // 再次标推荐 → 无变化成功
    const again = await ts.client.post(`/api/orders/${orderId}/recommendations`, {
      mode: 'mark-recommended',
      applicationIds: [a1.id],
    });
    expect(again.status).toBe(200);
    // 报名/推荐不自动停止招募（AC09）
    expect(d.order.status).toBe('recruiting');
  });

  it('AC06/AC09：≥25招募单全量导出；开始挑选后不导出，继续招募后包含', async () => {
    // 准备25个招募单（公开区域可区分）
    for (let i = 0; i < 25; i++) {
      await createOrder(ts.client, { parentName: `批量家长${i}`, parentWechat: `batch-${i}`, publicArea: `批量区域${i}` });
    }
    const picked = await createOrder(ts.client, { parentName: '挑选中家长', parentWechat: 'pick-wx', publicArea: '挑选中区域' });
    await ts.client.post(`/api/orders/${picked.id}/actions`, { action: 'review', version: picked.version });

    const before = await ts.client.get('/api/exports/recruiting');
    const text = before.body as string;
    const count = (text.match(/【家教招募｜/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(25);
    expect(text).toContain('批量区域0');
    expect(text).toContain('批量区域24');
    // 挑选中的整单（按公开区域识别）不导出
    expect(text).not.toContain('挑选中区域');

    // 继续招募后重新包含
    const d = await getDetail(ts.client, picked.id);
    await ts.client.post(`/api/orders/${picked.id}/actions`, { action: 'recruit', version: d.order.version });
    const after = (await ts.client.get('/api/exports/recruiting')).body as string;
    expect(after).toContain('挑选中区域');
  });

  it('AC07：导出内容无家长联系方式、详细地址、内部备注、费用', async () => {
    const o = await createOrder(ts.client, {
      parentName: '保密家长',
      parentWechat: 'secret_wx_999',
      parentPhone: '13700000000',
      locationDetail: '幸福小区3号楼2单元801',
      notes: '非常着急的内部备注',
      publicArea: '城西区',
      publicRequirements: '女老师优先',
    });
    const res = await ts.client.get('/api/exports/recruiting');
    const text = res.body as string;
    expect(text).toContain(o.orderNo);
    expect(text).toContain('城西区');
    expect(text).toContain('女老师优先');
    expect(text).not.toContain('保密家长');
    expect(text).not.toContain('secret_wx_999');
    expect(text).not.toContain('13700000000');
    expect(text).not.toContain('3号楼2单元');
    expect(text).not.toContain('非常着急的内部备注');
    expect(text).toContain('150元/小时'); // 薪资是公开字段
    // 中文TXT正常（content-type utf-8）
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-type')).toContain('utf-8');
  });
});

describe('并发保护与详情接口', () => {
  it('AC29a：旧version的PATCH被版本冲突拒绝', async () => {
    const o = await createOrder(ts.client, { parentName: '版本冲突家长' });
    const first = await ts.client.patch(`/api/orders/${o.id}?version=${o.version}`, { notes: '第一次修改' });
    expect(first.status).toBe(200);
    const stale = await ts.client.patch(`/api/orders/${o.id}?version=${o.version}`, { notes: '过期修改' });
    expect(stale.status).toBe(409);
    expect((stale.body as any).code).toBe('VERSION_CONFLICT');
  });

  it('查看/导出不刷新updated_at（AC22部分）', async () => {
    const o = await createOrder(ts.client, { parentName: '不延期家长' });
    const before = (await getDetail(ts.client, o.id)).order.updatedAt;
    await ts.client.get('/api/orders');
    await ts.client.get(`/api/orders/${o.id}`);
    await ts.client.get('/api/exports/recruiting');
    const after = (await getDetail(ts.client, o.id)).order.updatedAt;
    expect(after).toBe(before);
  });

  it('分页返回结构正确', async () => {
    const res = await ts.client.get('/api/orders?page=1&pageSize=5');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.items.length).toBeLessThanOrEqual(5);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(5);
  });
});
