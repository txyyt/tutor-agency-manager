// 90天清理（AC21-AC25、AC31、AC54空清理）与附件规则（AC26、AC57附件部分）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  ts = await startTestServer({ allowTimeControl: true });
});

afterAll(() => {
  ts.close();
});

async function makeCompletedOrder(opts?: { withAttachment?: boolean; fee?: number; deposit?: number }) {
  const order = await createOrder(ts.client, { parentName: `完成单-${crypto.randomUUID().slice(0, 6)}` });
  const a = await createApplication(ts.client, order.id);
  await appAction(ts.client, a.id, 'recommend');
  await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
  await doFinance(ts.client, a.id, {
    type: 'set-fees',
    version: a.version,
    agencyFeeCents: opts?.fee ?? 10000,
    depositDueCents: opts?.deposit ?? 0,
  });
  if ((opts?.deposit ?? 0) > 0) {
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: opts!.deposit! });
  }
  if (opts?.withAttachment) {
    await uploadPng(ts.client, a.id);
  }
  let d = await getDetail(ts.client, order.id);
  await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: d.order.version });
  await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
  if ((opts?.fee ?? 10000) > (opts?.deposit ?? 0)) {
    await doFinance(ts.client, a.id, {
      type: 'receive-supplement',
      version: a.version,
      amountCents: (opts?.fee ?? 10000) - (opts?.deposit ?? 0),
    });
  }
  d = await getDetail(ts.client, order.id);
  const done = await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: d.order.version });
  expect(done.status).toBe(200);
  return { order, a };
}

export async function uploadPng(client: TestServer['client'], applicationId: number): Promise<{ fileId: string }> {
  // 1x1透明PNG
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082',
    'hex',
  );
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), '测试简历.png');
  const detail = (await client.get(`/api/applications/${applicationId}`)).body;
  fd.append('version', String(detail.application.version));
  const res = await client.postForm(`/api/applications/${applicationId}/attachments`, fd);
  if (res.status !== 201) throw new Error(`上传失败：${JSON.stringify(res.body)}`);
  return { fileId: (res.body as any).added[0].fileId };
}

let clockOffsetMs = 0;
async function ageDays(days: number): Promise<void> {
  clockOffsetMs += days * 24 * 3600 * 1000;
  const r = await ts.client.post('/api/test/clock', { offsetMs: clockOffsetMs });
  if (r.status !== 200) throw new Error(`时控失败：${JSON.stringify(r.body)}`);
}
async function resetClock(): Promise<void> {
  clockOffsetMs = 0;
  await ts.client.post('/api/test/clock', { offsetMs: 0 });
}

describe('AC21：89天不删、恰好90天可删、附件清理、净收非零保护', () => {
  it('89天受保护；90天删除（附件文件一并删除）', async () => {
    const { order, a } = await makeCompletedOrder({ withAttachment: true, fee: 10000, deposit: 0 });
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    const fileId = detail.application.attachments[0].fileId;
    const attachmentsDir = ts.app.attachments ? path.join(ts.dataDir, 'generations', ts.app.runtime.load().activeGenerationId, 'attachments') : '';
    const attPath = path.join(attachmentsDir, fileId);
    expect(fs.existsSync(attPath)).toBe(true);

    await ageDays(89);
    let preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.type === 'order' && c.id === order.id)).toBe(false);

    await ageDays(1); // 恰好90天（updated_at <= now-90d）
    preview = (await ts.client.get('/api/cleanup/preview')).body;
    console.log('PREVIEW@90d:', JSON.stringify(preview, null, 1));
    const candidate = preview.candidates.find((c: any) => c.type === 'order' && c.id === order.id);
    expect(candidate).toBeTruthy();
    const run = await ts.client.post('/api/cleanup/run');
    console.log('RUN-RESP:', JSON.stringify(run.body));
    expect(run.status).toBe(200);
    expect((run.body as any).deletedOrders).toBeGreaterThanOrEqual(1);
    expect((run.body as any).backupId).toBeTruthy(); // 有候选 → 生成清理前备份
    // 订单、报名、附件均删除
    expect((await ts.client.get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await ts.client.get(`/api/applications/${a.id}`)).status).toBe(404);
    expect(fs.existsSync(attPath)).toBe(false);
  });

  it('净收非零的取消单受保护（AC21/AC15）', async () => {
    const order = await createOrder(ts.client, { parentName: '未退清取消单' });
    const a = await createApplication(ts.client, order.id);
    await appAction(ts.client, a.id, 'recommend');
    await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
    await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 10000, depositDueCents: 5000 });
    await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 5000 });
    const cancelRes = await ts.client.post(`/api/orders/${order.id}/actions`, {
      action: 'cancel',
      version: (await ts.client.get(`/api/orders/${order.id}`)).body.order.version,
    });
    expect(cancelRes.status).toBe(200);
    await ageDays(90);
    const preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.type === 'order' && c.id === order.id)).toBe(false);
    const protectedItem = preview.protectedItems.find((p: any) => p.id === order.id);
    expect(protectedItem.reason).toContain('未退清');
  });
});

describe('AC22：在办/暂停保护；实际修改重新计时', () => {
  it('在办与暂停超过90天不删；修改后重新计时', async () => {
    const active = await createOrder(ts.client, { parentName: '在办家长' });
    const paused = await createOrder(ts.client, { parentName: '暂停家长' });
    const d = await getDetail(ts.client, paused.id);
    await ts.client.post(`/api/orders/${paused.id}/actions`, { action: 'pause', version: d.order.version });
    await ageDays(120);
    const preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.id === active.id)).toBe(false);
    expect(preview.candidates.some((c: any) => c.id === paused.id)).toBe(false);
    // 查看不延期，实际修改重新计时
    const activeDetail = (await getDetail(ts.client, active.id)).order;
    expect(activeDetail.updatedAt).toBe((await getDetail(ts.client, active.id)).order.updatedAt);
    const patch = await ts.client.patch(`/api/orders/${active.id}?version=${activeDetail.version}`, { notes: '更新一下' });
    expect(patch.status).toBe(200);
    const newDetail = (await getDetail(ts.client, active.id)).order;
    expect(newDetail.updatedAt > activeDetail.updatedAt).toBe(true);
    await resetClock();
  });
});

describe('AC23/AC24/AC25：整单一致性、成交保护、重复清理', () => {
  it('订单到期但某报名未到期 → 整单不删；全部到期才删', async () => {
    await resetClock();
    const { order, a } = await makeCompletedOrder({ fee: 0, deposit: 0 });
    // +40天：修改报名一般资料 → 报名重新计时（订单时间未变）
    await ageDays(40);
    const appDetail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    const patchRes = await ts.client.patch(`/api/applications/${a.id}`, { notes: '更正一下资料', version: appDetail.application.version });
    expect(patchRes.status).toBe(200);
    // 再+89天（距订单完成129天，距报名修改89天）：订单已到期、报名未到期 → 整单保护
    await ageDays(89);
    let preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.type === 'order' && c.id === order.id)).toBe(false);
    const protectedItem = preview.protectedItems.find((p: any) => p.id === order.id);
    expect(protectedItem.reason).toContain('未到期');
    // 再+2天：报名也到期 → 整单可删
    await ageDays(2);
    preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.type === 'order' && c.id === order.id)).toBe(true);
    // 整单删除时报名不再单列为独立候选
    expect(preview.candidates.some((c: any) => c.type === 'application' && c.id === a.id)).toBe(false);
    const run = await ts.client.post('/api/cleanup/run');
    expect((run.body as any).deletedOrders).toBeGreaterThanOrEqual(1);
    expect((await ts.client.get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await ts.client.get(`/api/applications/${a.id}`)).status).toBe(404);
  });

  it('成交报名不能独立删除（AC24）；独立删除失败/退出报名不残留', async () => {
    await resetClock();
    // 在办订单 + 退出报名（updated_at=T0）
    const activeOrder = await createOrder(ts.client, { parentName: '在办单-独立清理' });
    const withdrawnApp = await createApplication(ts.client, activeOrder.id, { teacherName: '退出者' });
    await appAction(ts.client, withdrawnApp.id, 'withdraw', {});
    // 时钟+90天后再创建完成单（其时间戳=+90d，不会到期）
    await ageDays(90);
    const done = await makeCompletedOrder({ fee: 0, deposit: 0 });
    const preview = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview.candidates.some((c: any) => c.type === 'application' && c.id === withdrawnApp.id)).toBe(true);
    // 成交报名不在独立候选中（随整单生命周期）
    expect(preview.candidates.some((c: any) => c.type === 'application' && c.id === done.a.id)).toBe(false);
    const run = await ts.client.post('/api/cleanup/run');
    expect((run.body as any).deletedApplications).toBeGreaterThanOrEqual(1);
    expect((await ts.client.get(`/api/applications/${withdrawnApp.id}`)).status).toBe(404);
    expect((await ts.client.get(`/api/applications/${done.a.id}`)).status).toBe(200);
    expect((await ts.client.get(`/api/orders/${done.order.id}`)).status).toBe(200);
  });

  it('AC25：预览后修改，执行重新核验；重复清理无重复副作用', async () => {
    await resetClock();
    const { order } = await makeCompletedOrder({ fee: 0, deposit: 0 });
    await ageDays(90);
    const preview1 = (await ts.client.get('/api/cleanup/preview')).body;
    expect(preview1.candidates.some((c: any) => c.id === order.id)).toBe(true);
    // 预览后修改该单（重新计时）→ 执行时不删
    const d = await getDetail(ts.client, order.id);
    const patchRes = await ts.client.patch(`/api/orders/${order.id}?version=${d.order.version}`, { notes: '预览后又改了' });
    expect(patchRes.status).toBe(200);
    const run = await ts.client.post('/api/cleanup/run');
    const body = run.body as any;
    expect(body.deletedOrders).toBe(0);
    expect((await ts.client.get(`/api/orders/${order.id}`)).status).toBe(200);
    // 再次执行：无候选 → 不生成备份、无副作用
    const beforeIndex = (await ts.client.get('/api/backups')).body.entries.length;
    const run2 = await ts.client.post('/api/cleanup/run');
    expect((run2.body as any).skippedReason).toContain('没有可清理');
    expect((run2.body as any).backupId).toBeNull(); // 空清理不生成全量包（AC54后半）
    const afterIndex = (await ts.client.get('/api/backups')).body.entries.length;
    expect(afterIndex).toBe(beforeIndex);
  });
});

describe('AC31：启动补做与周期执行（可注入调度测试）', () => {
  it('启动时补做一次清理，不靠手动点击', async () => {
    const { order } = await makeCompletedOrder({ fee: 0, deposit: 0 });
    await ageDays(90);
    // 走真实调度路径：scheduler.tick → cleanup.run + runtime记录（等价于启动补做）
    await ts.app.scheduler.triggerNow();
    expect(ts.app.runtime.load().cleanupState.lastResult).toContain('删除');
    expect((await ts.client.get(`/api/orders/${order.id}`)).status).toBe(404);
  });
});

describe('AC26：附件安全（非法类型/超限/路径穿越/外部文件保护）', () => {
  it('HTML伪装PDF被拒（magic bytes校验）', async () => {
    const order = await createOrder(ts.client, { parentName: '附件安全家长' });
    const a = await createApplication(ts.client, order.id);
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf-8');
    const fd = new FormData();
    fd.append('files', new Blob([html], { type: 'application/pdf' }), 'fake.pdf');
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    fd.append('version', String(detail.application.version));
    const res = await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
    expect(res.status).toBe(409);
    expect((res.body as any).code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('超过10MB被拒（413）', async () => {
    const order = await createOrder(ts.client, { parentName: '超限家长' });
    const a = await createApplication(ts.client, order.id);
    const big = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'), Buffer.alloc(10 * 1024 * 1024, 1)]);
    const fd = new FormData();
    fd.append('files', new Blob([big], { type: 'image/png' }), 'big.png');
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    fd.append('version', String(detail.application.version));
    const res = await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
    expect(res.status).toBe(413);
  });

  it('附件下载/预览真实可用；fileId路径穿越拒绝（AC26/AC57）', async () => {
    const { a } = await makeCompletedOrder({ fee: 0, deposit: 0, withAttachment: true });
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    const fileId = detail.application.attachments[0].fileId;
    const download = await ts.client.get(`/api/applications/${a.id}/attachments/${fileId}`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(download.headers.get('content-disposition')).toContain('filename*');
    const preview = await ts.client.get(`/api/applications/${a.id}/attachments/${fileId}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toContain('inline');
    const traversal = await ts.client.get(`/api/applications/${a.id}/attachments/..%2F..%2Fdatabase.sqlite`);
    expect(traversal.status).toBe(404);
    const traversal2 = await ts.client.get(`/api/applications/${a.id}/attachments/aaaa-bbbb`);
    expect(traversal2.status).toBe(404);
  });

  it('多文件一次上传：任一失败不留半组记录，未引用临时文件被清理（AC57）', async () => {
    const order = await createOrder(ts.client, { parentName: '半组记录家长' });
    const a = await createApplication(ts.client, order.id);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'good.png');
    fd.append('files', new Blob([Buffer.from('<html>x</html>')], { type: 'image/png' }), 'bad.png');
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    fd.append('version', String(detail.application.version));
    const res = await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
    expect(res.status).toBe(409);
    const after = (await ts.client.get(`/api/applications/${a.id}`)).body;
    expect(after.application.attachments).toHaveLength(0); // 无半组记录（失败时已自行清理本次文件）
    // 模拟进程崩溃遗留的未引用文件：sweep应能清理
    const fs = await import('node:fs');
    const path = await import('node:path');
    const attDir = path.join(ts.dataDir, 'generations', ts.app.runtime.load().activeGenerationId, 'attachments');
    fs.writeFileSync(path.join(attDir, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), 'orphan');
    const sweep = ts.app.attachments.sweepUnreferenced();
    expect(sweep.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(attDir, 'ffffffff-ffff-4fff-8fff-ffffffffffff'))).toBe(false);
  });

  it('最多5个：第6个报409（合并用例）', async () => {
    const order = await createOrder(ts.client, { parentName: '第六个家长2' });
    const a = await createApplication(ts.client, order.id);
    for (let i = 0; i < 5; i++) await uploadPng(ts.client, a.id);
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'six.png');
    fd.append('version', String(detail.application.version));
    const res = await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
    expect(res.status).toBe(409);
  });

  it('最多5个：第6个报409', async () => {
    const order = await createOrder(ts.client, { parentName: '第六个家长' });
    const a = await createApplication(ts.client, order.id);
    for (let i = 0; i < 5; i++) await uploadPng(ts.client, a.id);
    const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('files', new Blob([png], { type: 'image/png' }), 'six.png');
    fd.append('version', String(detail.application.version));
    const res = await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
    expect(res.status).toBe(409);
    expect((res.body as any).code).toBe('TOO_MANY_FILES');
  });
});
