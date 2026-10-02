// 本轮验收反馈回归：区域、复合业务、附件原子保存、删除和旧数据兼容。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, defaultMigrationDir } from '../../src/server/db.js';
import { ORDER_STATUS_LABELS } from '../../src/shared/types.js';
import { startTestServer, createOrder, createApplication, getDetail, appAction, validApplicationPayload, validOrderPayload, type TestServer } from '../helpers/testServer.js';
let ts: TestServer;
beforeEach(async () => { ts = await startTestServer(); });
afterEach(() => { vi.restoreAllMocks(); ts.close(); });
async function workflow(id: number, action: string, extra: Record<string, unknown> = {}) {
  const d = (await ts.client.get(`/api/applications/${id}`)).body;
  const body = { action, operationId: crypto.randomUUID(), version: d.application.version, orderVersion: d.order.version, ...extra };
  return { response: await ts.client.post(`/api/applications/${id}/workflow`, body), body };
}
async function trial() {
  const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
  await appAction(ts.client, app.id, 'recommend');
  const result = await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000, amountCents: 10000 });
  expect(result.response.status).toBe(200);
  expect((await workflow(app.id, 'start')).response.status).toBe(200);
  return { order, app };
}
function registration(files: Array<{ name: string; mime: string; bytes: Uint8Array }>, payload = validApplicationPayload({ creationRequestId: crypto.randomUUID() })) {
  const fd = new FormData(); fd.append('payload', JSON.stringify(payload));
  for (const f of files) fd.append('files', new Blob([Buffer.from(f.bytes)], { type: f.mime }), f.name);
  return fd;
}
const png = () => new Uint8Array(fs.readFileSync('tests/fixtures/acceptance/attachments/image-01.png'));
describe('区域与状态', () => {
  it('待办优先和各排序在分页前执行，可关闭优先且保持筛选与稳定顺序', async () => {
    const a = await createOrder(ts.client); const b = await createOrder(ts.client); const c = await createOrder(ts.client);
    await createApplication(ts.client, b.id);
    const db = ts.app.active.current();
    db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run('2026-09-30T03:00:00.000Z', a.id);
    db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run('2026-09-30T01:00:00.000Z', b.id);
    db.prepare('UPDATE applications SET updated_at = ? WHERE order_id = ?').run('2026-09-30T01:00:00.000Z', b.id);
    db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run('2026-09-30T02:00:00.000Z', c.id);
    const ids = async (query = '') => (await ts.client.get(`/api/orders?${query}`)).body.items.map((o: {id: number}) => o.id);
    expect(await ids()).toEqual([b.id, a.id, c.id]);
    expect(await ids('pageSize=1')).toEqual([b.id]);
    expect(await ids('pageSize=1&page=2')).toEqual([a.id]);
    expect(await ids('sort=number-asc')).toEqual([b.id, a.id, c.id]);
    expect(await ids('sort=number-desc')).toEqual([b.id, c.id, a.id]);
    expect(await ids('tasksFirst=0&sort=number-asc')).toEqual([a.id, b.id, c.id]);
    expect(await ids('tasksFirst=0&sort=number-desc')).toEqual([c.id, b.id, a.id]);
    expect(await ids('tasksFirst=0&sort=updated-desc')).toEqual([a.id, c.id, b.id]);
    expect(await ids('tasksFirst=0&sort=updated-asc')).toEqual([b.id, c.id, a.id]);
    expect(await ids('needsAction=1&tasksFirst=0&sort=number-asc')).toEqual([b.id]);
    expect((await ts.client.get('/api/orders?sort=invalid')).status).toBe(400);
  });
  it('线下模板内部地点留空或缺失可保存，编辑可清空或补填，公开区域仍必填', async () => {
    const source = fs.readFileSync('tests/fixtures/acceptance/parents/A.txt', 'utf8');
    for (const text of [source.replace(/9\. 上课区域及地点：[^\n]*/u, '9. 上课区域及地点：\n   （选填，内部地点不会用于群内发布；暂不想提供可先留空，试课时再询问）'), source.replace(/9\. 上课区域及地点：[^\n]*\n/u, '')]) {
      const parsed = await ts.client.post('/api/imports/parse', { kind: 'parent', text });
      expect(parsed.body.fieldErrors.locationDetail).toBeUndefined(); expect(parsed.body.form.locationDetail).toBe('');
      const saved = await createOrder(ts.client, parsed.body.form);
      expect(saved.locationDetail).toBe('');
    }
    const o = await createOrder(ts.client, { locationDetail: undefined }); expect(o.locationDetail).toBe('');
    const filled = await ts.client.patch(`/api/orders/${o.id}?version=${o.version}`, { locationDetail: '内部小区502室' });
    expect(filled.status).toBe(200);
    const cleared = await ts.client.patch(`/api/orders/${o.id}?version=${filled.body.order.version}`, { locationDetail: '   ' });
    expect(cleared.status).toBe(200); expect(cleared.body.order.locationDetail).toBe('');
    const missing = await ts.client.post('/api/orders', validOrderPayload({ locationDetail: '', publicArea: '' }));
    expect(missing.status).toBe(400); expect(missing.body.fieldErrors.locationDetail).toBeUndefined(); expect(missing.body.fieldErrors.publicArea).toBeTruthy();
    const exported = (await ts.client.get('/api/exports/recruiting')).body;
    expect(exported).not.toContain('内部小区502室'); expect(exported).not.toContain('试课时问家长');
  });
  it('线上创建不填区域，后台统一为线上；切换线下必须补地址', async () => {
    const result = await ts.client.post('/api/orders', validOrderPayload({ teachingMode: 'online', locationDetail: undefined, publicArea: undefined }));
    expect(result.status).toBe(201); const o = result.body.order;
    expect([o.locationDetail, o.publicArea]).toEqual(['线上', '线上']);
    const bad = await ts.client.patch(`/api/orders/${o.id}?version=${o.version}`, { teachingMode: 'offline', locationDetail: '', publicArea: '' });
    expect(bad.status).toBe(400); expect(bad.body.fieldErrors.publicArea).toBeTruthy();
    const changed = await ts.client.patch(`/api/orders/${o.id}?version=${o.version}`, { teachingMode: 'online', locationDetail: '私人门牌801', publicArea: '旧地址' });
    expect(changed.status).toBe(200); expect(changed.body.order.publicArea).toBe('线上');
    expect((await ts.client.get('/api/exports/recruiting')).body).not.toContain('私人门牌');
  });
  it('公开区域别名单独识别；线上模板缺地点不报错；内部地址不默认公开', async () => {
    const text = fs.readFileSync('tests/fixtures/acceptance/parents/A.txt', 'utf8').replace(/公开授课区域：[^\n]*\n/u, '');
    const parsed = await ts.client.post('/api/imports/parse', { kind: 'parent', text: text.replace('10. 每周', '公开区域：城东验收区\n10. 每周') });
    expect(parsed.status).toBe(200); expect(parsed.body.form.publicArea).toBe('城东验收区');
    expect(parsed.body.form.locationDetail).toContain('502');
    const old = await ts.client.post('/api/imports/parse', { kind: 'parent', text });
    expect(old.body.form.publicArea).toBe('');
    const online = await ts.client.post('/api/imports/parse', { kind: 'parent', text: text.replace('上课方式：线下', '上课方式：线上').replace(/9\. 上课区域及地点：[^\n]*/u, '') });
    expect(online.body.fieldErrors.locationDetail).toBeUndefined(); expect(online.body.form.publicArea).toBe('线上');
  });
  it('家长挑选动作已删除，推荐不停止招募，暂停仍支持恢复', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    expect(Object.values(ORDER_STATUS_LABELS)).not.toContain('家长挑选中');
    expect((await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'review', version: order.version })).status).toBe(400);
    await appAction(ts.client, app.id, 'recommend'); expect((await getDetail(ts.client, order.id)).order.status).toBe('recruiting');
  });
  it('旧挑选/暂停/线上/通过未确认记录可迁移且重复迁移无变化', async () => {
    const first = await createOrder(ts.client); const second = await createOrder(ts.client, { teachingMode: 'online' });
    const a = await createApplication(ts.client, first.id);
    const db = ts.app.active.current();
    db.prepare("UPDATE orders SET status='reviewing' WHERE id=?").run(second.id);
    db.prepare("UPDATE orders SET status='reviewing', current_application_id=? WHERE id=?").run(a.id, first.id);
    db.prepare("UPDATE applications SET status='trial_passed', cooperation_confirmed_at=NULL WHERE id=?").run(a.id);
    db.exec('PRAGMA user_version=1');
    expect(migrate(db, defaultMigrationDir())).toBe(2);
    const migrated = await getDetail(ts.client, first.id);
    expect(migrated.order.status).toBe('reviewing'); expect(migrated.applications[0].cooperationConfirmedAt).toBeTruthy();
    expect((await getDetail(ts.client, second.id)).order.status).toBe('recruiting');
    const version = migrated.applications[0].version; migrate(db, defaultMigrationDir());
    expect((await getDetail(ts.client, first.id)).applications[0].version).toBe(version);
  });
});
describe('集中试课与收退款', () => {
  it('未推荐时直接合作两个接口均拒绝且费用不变，推荐后可收费完成', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    const before = await getDetail(ts.client, order.id);
    const legacy = await ts.client.post(`/api/applications/${app.id}/actions`, { action: 'direct-cooperation', version: app.version, orderVersion: order.version });
    expect(legacy.status).toBe(409); expect(legacy.body.message).toContain('已推荐');
    const direct = await workflow(app.id, 'direct', { agencyFeeCents: 20000, depositDueCents: 0, amountCents: 20000 });
    expect(direct.response.status).toBe(409); expect(await getDetail(ts.client, order.id)).toEqual(before);
    await appAction(ts.client, app.id, 'recommend');
    const passed = await workflow(app.id, 'direct', { agencyFeeCents: 20000, depositDueCents: 0, amountCents: 20000 });
    expect(passed.response.status).toBe(200); expect(passed.response.body.order.status).toBe('completed');
  });
  it('未推荐时两个安排试课接口均拒绝，推荐后才可安排且费用不提前变更', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    const before = await getDetail(ts.client, order.id);
    const legacy = await ts.client.post(`/api/applications/${app.id}/actions`, { action: 'schedule-trial', version: app.version, orderVersion: order.version });
    expect(legacy.status).toBe(409); expect(legacy.body.message).toContain('已推荐');
    const compound = await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000, amountCents: 10000 });
    expect(compound.response.status).toBe(409); expect(await getDetail(ts.client, order.id)).toEqual(before);
    await appAction(ts.client, app.id, 'recommend');
    expect((await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000 })).response.status).toBe(200);
  });
  it('安排后不收款，保证金分次确认后自动开始，重试不重复记账', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    await appAction(ts.client, app.id, 'recommend');
    await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000 });
    expect((await getDetail(ts.client, order.id)).order.status).toBe('awaiting_trial');
    expect((await workflow(app.id, 'receive-start', { amountCents: 0 })).response.status).toBe(409);
    expect((await workflow(app.id, 'receive-start', { amountCents: 10001 })).response.status).toBe(409);
    expect((await getDetail(ts.client, order.id)).applications[0].depositReceivedCents).toBe(0);
    const other = await createApplication(ts.client, order.id);
    expect((await workflow(other.id, 'receive-start', { amountCents: 10000 })).response.status).toBe(409);
    const partial = await workflow(app.id, 'receive-start', { amountCents: 4000 });
    expect(partial.response.body.order.status).toBe('awaiting_trial');
    const full = await workflow(app.id, 'receive-start', { amountCents: 6000 });
    expect(full.response.status).toBe(200); expect(full.response.body.order.status).toBe('trialing');
    const replay = await ts.client.post(`/api/applications/${app.id}/workflow`, full.body);
    expect(replay.body.replayed).toBe(true); expect(replay.body.application.depositReceivedCents).toBe(10000);
    expect(replay.body.application.feeSupplementReceivedCents).toBe(0);
  });
  it('安排试课只设置费用不会假记到账，失败配置整组回滚', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    await appAction(ts.client, app.id, 'recommend');
    const bad = await workflow(app.id, 'schedule', { agencyFeeCents: 10000, depositDueCents: 20000 });
    expect(bad.response.status).toBe(409); let d = await getDetail(ts.client, order.id);
    expect(d.order.currentApplicationId).toBeNull(); expect(d.applications[0].financeOperations).toHaveLength(0);
    await appAction(ts.client, app.id, 'recommend');
    expect((await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000 })).response.status).toBe(200);
    d = await getDetail(ts.client, order.id); expect(d.applications[0].depositReceivedCents).toBe(0);
    expect((await workflow(app.id, 'start')).response.status).toBe(409);
    expect((await workflow(app.id, 'prepare', { agencyFeeCents: 30000, depositDueCents: 10000, amountCents: 4000 })).response.status).toBe(200);
    expect((await workflow(app.id, 'start')).response.status).toBe(409);
    expect((await workflow(app.id, 'prepare', { agencyFeeCents: 30000, depositDueCents: 10000, amountCents: 6000 })).response.status).toBe(200);
    expect((await workflow(app.id, 'start')).response.status).toBe(200);
  });
  it('通过+实际收补款一次完成，重复请求不重复记账，换载荷拒绝', async () => {
    const { order, app } = await trial();
    const other = await createApplication(ts.client, order.id);
    const { response, body } = await workflow(app.id, 'pass', { amountCents: 20000 });
    expect(response.status).toBe(200); expect(response.body.order.status).toBe('completed');
    const replay = await ts.client.post(`/api/applications/${app.id}/workflow`, body);
    expect(replay.status).toBe(200); expect(replay.body.replayed).toBe(true);
    expect(replay.body.application.feeSupplementReceivedCents).toBe(20000);
    const changed = await ts.client.post(`/api/applications/${app.id}/workflow`, { ...body, amountCents: 10000 }); expect(changed.status).toBe(409);
    const d = await getDetail(ts.client, order.id); expect(d.applications.find((a: {id:number}) => a.id === other.id).status).toBe('order_closed');
  });
  it('通过即确认合作，未收款待结算；分次收中介费后自动完成', async () => {
    const { app } = await trial(); const pass = await workflow(app.id, 'pass');
    expect(pass.response.body.application.cooperationConfirmedAt).toBeTruthy(); expect(pass.response.body.order.status).toBe('reviewing');
    expect(pass.response.body.application.feeSupplementReceivedCents).toBe(0);
    expect((await workflow(app.id, 'settle', { amountCents: 20100 })).response.status).toBe(409);
    expect((await workflow(app.id, 'settle', { amountCents: 5000 })).response.body.order.status).toBe('reviewing');
    expect((await workflow(app.id, 'settle', { amountCents: 15000 })).response.body.order.status).toBe('completed');
  });
  it('其他老师未退清时保留已收中介费，退款后自动完成当前订单', async () => {
    const { app, order } = await trial(); await workflow(app.id, 'fail');
    const second = await createApplication(ts.client, order.id);
    await appAction(ts.client, second.id, 'recommend');
    await workflow(second.id, 'direct', { agencyFeeCents: 20000, depositDueCents: 0, amountCents: 20000 });
    let d = await getDetail(ts.client, order.id); expect(d.order.status).toBe('reviewing');
    expect(d.applications.find((a:{id:number}) => a.id === second.id).feeSupplementReceivedCents).toBe(20000);
    const refund = await workflow(app.id, 'refund', { amountCents: 10000 });
    expect(refund.response.status).toBe(200); d = await getDetail(ts.client, order.id); expect(d.order.status).toBe('completed');
  });
  it('退款可跨保证金和补款，一组失败不产生部分退款', async () => {
    const { app } = await trial(); await workflow(app.id, 'pass', { amountCents: 10000 }); await workflow(app.id, 'withdraw');
    expect((await workflow(app.id, 'refund', { amountCents: 20001 })).response.status).toBe(409);
    expect((await workflow(app.id, 'refund', { amountCents: 15000 })).response.status).toBe(200);
    const d = (await ts.client.get(`/api/applications/${app.id}`)).body;
    expect(d.application.depositRefundedCents).toBe(10000); expect(d.application.feeSupplementRefundedCents).toBe(5000);
    expect(d.order.status).toBe('recruiting');
  });
  it('候选不能替当前老师开始试课，旧版本复合操作不能覆盖新记录', async () => {
    const order = await createOrder(ts.client); const a = await createApplication(ts.client, order.id); const b = await createApplication(ts.client, order.id);
    await appAction(ts.client, a.id, 'recommend');
    await workflow(a.id, 'schedule', { agencyFeeCents: 0, depositDueCents: 0 });
    expect((await workflow(b.id, 'start')).response.status).toBe(409);
    const stale = await workflow(a.id, 'start', { version: a.version }); expect(stale.response.status).toBe(409);
    expect((await getDetail(ts.client, order.id)).order.status).toBe('awaiting_trial');
  });
  it('待办筛选在分页前执行，正常持有保证金不算退款，结清后移除待办', async () => {
    const { app, order } = await trial();
    const list = (await ts.client.get('/api/orders?needsAction=1&pageSize=1')).body;
    expect(list.items[0].tasks.map((t:{kind:string}) => t.kind)).toEqual(['trial']);
    await workflow(app.id, 'pass', { amountCents: 20000 });
    const blank = await createOrder(ts.client); const candidate = await createApplication(ts.client, blank.id);
    const tasks = (await ts.client.get('/api/orders?needsAction=1&pageSize=1')).body;
    expect(tasks.total).toBe(1); expect(tasks.items[0].id).toBe(blank.id); expect(tasks.items[0].tasks[0].kind).toBe('recommend');
    await appAction(ts.client, candidate.id, 'recommend');
    expect((await ts.client.get('/api/orders?needsAction=1')).body.items.some((o:{id:number}) => o.id === order.id)).toBe(false);
  });
});
describe('资料和附件一起保存', () => {
  it('报名附PNG/PDF一次保存，重试不重复创建或上传，预览与下载字节一致', async () => {
    const order = await createOrder(ts.client);
    const payload = validApplicationPayload({ creationRequestId: crypto.randomUUID() });
    const files = [{ name: '报名.png', mime: 'image/png', bytes: png() }, { name: '简历.pdf', mime: 'application/pdf', bytes: new Uint8Array(fs.readFileSync('tests/fixtures/acceptance/attachments/acceptance-resume.pdf')) }];
    const saved = await ts.client.post(`/api/orders/${order.id}/applications`, registration(files, payload));
    expect(saved.status).toBe(201); expect(saved.body.application.attachments).toHaveLength(2);
    const repeat = await ts.client.post(`/api/orders/${order.id}/applications`, registration(files, payload));
    expect(repeat.status).toBe(200); expect((await getDetail(ts.client, order.id)).applications).toHaveLength(1);
    const a = saved.body.application;
    for (const meta of a.attachments) {
      const preview = await ts.client.get(`/api/applications/${a.id}/attachments/${meta.fileId}/preview`);
      expect(preview.headers.get('content-disposition')).toContain('inline'); expect(preview.headers.get('content-type')).toBe(meta.mimeType);
      expect(Number(preview.headers.get('content-length'))).toBe(meta.size);
    }
  });
  it('报名含伪PDF或6附件时拒绝整条记录，不留下文件', async () => {
    const order = await createOrder(ts.client);
    const bad = await ts.client.post(`/api/orders/${order.id}/applications`, registration([{ name: '图片.png', mime: 'image/png', bytes: png() }, { name: '假的.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('<html>bad</html>') }]));
    expect(bad.status).toBe(409); expect((await getDetail(ts.client, order.id)).applications).toHaveLength(0);
    expect(fs.readdirSync(ts.app.active.attachmentsDir)).toHaveLength(0);
    const six = await ts.client.post(`/api/orders/${order.id}/applications`, registration(Array.from({ length: 6 }, () => ({ name: '图.png', mime: 'image/png', bytes: png() }))));
    expect(six.status).toBe(400); expect((await getDetail(ts.client, order.id)).applications).toHaveLength(0);
  });
  it('编辑资料并附文件失败时原资料不变，成功时一起更新', async () => {
    const order = await createOrder(ts.client); const a = await createApplication(ts.client, order.id);
    const bad = await ts.client.post(`/api/applications/${a.id}/profile`, registration([{ name: '假.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }], { version: a.version, teacherName: '应回滚' }));
    expect(bad.status).toBe(409); expect((await ts.client.get(`/api/applications/${a.id}`)).body.application.teacherName).toBe(a.teacherName);
    const ok = await ts.client.post(`/api/applications/${a.id}/profile`, registration([{ name: '新.png', mime: 'image/png', bytes: png() }], { version: a.version, teacherName: '编辑成功' }));
    expect(ok.status).toBe(200); expect(ok.body.application.teacherName).toBe('编辑成功'); expect(ok.body.application.attachments).toHaveLength(1);
  });
});
describe('删除和恢复', () => {
  it('已完成订单解除当前及成交老师引用后级联删除，备份恢复全部关联和附件', async () => {
    const { order, app } = await trial();
    const saved = await ts.client.post(`/api/orders/${order.id}/applications`, registration([{ name: '候选.png', mime: 'image/png', bytes: png() }]));
    const candidate = saved.body.application;
    expect((await workflow(app.id, 'pass', { amountCents: 20000 })).response.body.order.status).toBe('completed');
    const before = await getDetail(ts.client, order.id);
    expect(before.order.currentApplicationId).toBe(app.id); expect(before.order.matchedApplicationId).toBe(app.id);
    expect((await ts.client.delete(`/api/applications/${app.id}?version=${before.applications.find((a: { id: number }) => a.id === app.id).version}`)).body.code).toBe('DELETE_MATCHED');
    expect((await ts.client.delete(`/api/orders/${order.id}?version=${before.order.version}`)).body.code).toBe('DELETE_CONFIRM_REQUIRED');
    const removed = await ts.client.delete(`/api/orders/${order.id}?version=${before.order.version}&confirmHistory=${order.orderNo}`);
    expect(removed.status).toBe(200); expect(removed.body.applicationsDeleted).toBe(2);
    expect((await ts.client.get(`/api/orders/${order.id}`)).status).toBe(404);
    expect((await ts.client.get(`/api/applications/${app.id}`)).status).toBe(404);
    expect(fs.existsSync(path.join(ts.app.active.attachmentsDir, candidate.attachments[0].storagePath))).toBe(false);
    const backup = ts.app.backups.getBackupFile(removed.body.backupId);
    const checked = await ts.app.restores.validate(backup.absolutePath); await ts.app.restores.commit(checked.token);
    const restored = await getDetail(ts.client, order.id);
    expect(restored.order).toEqual(before.order); expect(restored.applications).toEqual(before.applications);
    expect(fs.readFileSync(path.join(ts.app.active.attachmentsDir, candidate.attachments[0].storagePath))).toEqual(Buffer.from(png()));
  });
  it('未收款的待结算订单也能解除当前老师引用并删除', async () => {
    const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
    await appAction(ts.client, app.id, 'recommend');
    const direct = await workflow(app.id, 'direct', { agencyFeeCents: 20000, depositDueCents: 0 });
    expect(direct.response.body.order.status).toBe('reviewing');
    const removed = await ts.client.delete(`/api/orders/${order.id}?version=${direct.response.body.order.version}`);
    expect(removed.status).toBe(200); expect((await ts.client.get(`/api/applications/${app.id}`)).status).toBe(404);
  });
  it('解除引用后删除失败，事务回滚订单引用、报名和附件', async () => {
    const { order, app } = await trial();
    const saved = await ts.client.post(`/api/orders/${order.id}/applications`, registration([{ name: '保留.png', mime: 'image/png', bytes: png() }]));
    const attachment = saved.body.application.attachments[0];
    await workflow(app.id, 'pass', { amountCents: 20000 });
    const before = await getDetail(ts.client, order.id);
    ts.app.active.current().exec("CREATE TRIGGER reject_order_delete BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT, '模拟删除失败'); END;");
    const removed = await ts.client.delete(`/api/orders/${order.id}?version=${before.order.version}&confirmHistory=${order.orderNo}`);
    expect(removed.status).toBe(500);
    expect(await getDetail(ts.client, order.id)).toEqual(before);
    expect(fs.readFileSync(path.join(ts.app.active.attachmentsDir, attachment.storagePath))).toEqual(Buffer.from(png()));
    expect(ts.app.active.current().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  it('删除订单级联报名和附件，删除前备份可以完整恢复', async () => {
    const o = await createOrder(ts.client);
    const saved = await ts.client.post(`/api/orders/${o.id}/applications`, registration([{ name: '图.png', mime: 'image/png', bytes: png() }]));
    const a = saved.body.application; const abs = path.join(ts.app.active.attachmentsDir, a.attachments[0].storagePath);
    const removed = await ts.client.delete(`/api/orders/${o.id}?version=${o.version}`);
    expect(removed.status).toBe(200); expect(fs.existsSync(abs)).toBe(false);
    expect((await ts.client.get(`/api/applications/${a.id}`)).status).toBe(404);
    const backup = ts.app.backups.getBackupFile(removed.body.backupId); expect(backup.entry.kind).toBe('pre-delete');
    const checked = await ts.app.restores.validate(backup.absolutePath); await ts.app.restores.commit(checked.token);
    const restored = await getDetail(ts.client, o.id); expect(restored.applications).toHaveLength(1);
    expect(fs.readFileSync(path.join(ts.app.active.attachmentsDir, a.attachments[0].storagePath))).toEqual(Buffer.from(png()));
  });
  it('误录报名可单独删除；保证金未退、试课中和旧版本删除被拒绝', async () => {
    const o = await createOrder(ts.client); const a = await createApplication(ts.client, o.id);
    const b = await createApplication(ts.client, o.id);
    expect((await ts.client.delete(`/api/applications/${b.id}?version=${b.version}`)).status).toBe(200);
    await appAction(ts.client, a.id, 'recommend');
    await workflow(a.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000, amountCents: 10000 });
    const current = (await getDetail(ts.client, o.id)).order;
    expect((await ts.client.delete(`/api/orders/${o.id}?version=${current.version}`)).body.code).toBe('DELETE_ACTIVE_TRIAL');
    await workflow(a.id, 'withdraw'); const newer = (await getDetail(ts.client, o.id)).order;
    expect((await ts.client.delete(`/api/orders/${o.id}?version=${newer.version}`)).body.code).toBe('DELETE_UNSETTLED');
    expect((await ts.client.delete(`/api/orders/${o.id}?version=${o.version}`)).body.code).toBe('VERSION_CONFLICT');
    await workflow(a.id, 'refund', { amountCents: 10000 });
    const final = (await ts.client.get(`/api/applications/${a.id}`)).body.application;
    expect((await ts.client.delete(`/api/applications/${a.id}?version=${final.version}`)).body.code).toBe('DELETE_CONFIRM_REQUIRED');
    expect((await ts.client.delete(`/api/applications/${a.id}?version=${final.version}&confirmHistory=${a.applicationNo}`)).status).toBe(200);
  });
  it('删除前备份失败时数据库与附件全部保留', async () => {
    const o = await createOrder(ts.client); const a = await createApplication(ts.client, o.id);
    vi.spyOn(ts.app.backups, 'performBackupLocked').mockRejectedValueOnce(new Error('模拟磁盘失败'));
    expect((await ts.client.delete(`/api/orders/${o.id}?version=${o.version}`)).status).toBe(500);
    expect((await getDetail(ts.client, o.id)).applications[0].id).toBe(a.id);
  });
});

it('整单最近修改取订单与全部报名最大值，排序分页及日期筛选一致且不改写记录', async () => {
  const a = await createOrder(ts.client); const b = await createOrder(ts.client); const c = await createOrder(ts.client);
  const a1 = await createApplication(ts.client, a.id); const a2 = await createApplication(ts.client, a.id);
  const db = ts.app.active.current();
  for (const o of [a, b, c]) db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run('2026-01-02T01:00:00.000Z', o.id);
  db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run('2026-01-05T01:00:00.000Z', c.id);
  db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run('2026-01-03T01:00:00.000Z', a1.id);
  db.prepare('UPDATE applications SET updated_at = ? WHERE id = ?').run('2026-01-04T01:00:00.000Z', a2.id);
  const list = async (query = '') => (await ts.client.get(`/api/orders?tasksFirst=0&${query}`)).body;
  const descending = await list('sort=updated-desc');
  expect(descending.items.map((o: { id: number }) => o.id)).toEqual([c.id, a.id, b.id]);
  expect(descending.items[1].lastActivityAt).toBe('2026-01-04T01:00:00.000Z');
  expect(descending.items[1].updatedAt).toBe('2026-01-02T01:00:00.000Z');
  expect((await list('sort=updated-asc')).items.map((o: { id: number }) => o.id)).toEqual([b.id, a.id, c.id]);
  expect((await list('pageSize=1&page=2')).items[0].id).toBe(a.id);
  const dated = await list('dateFrom=2026-01-04&dateTo=2026-01-04');
  expect(dated.total).toBe(1); expect(dated.items[0].id).toBe(a.id);
  const before = (await ts.client.get(`/api/orders/${a.id}`)).body.order;
  const saved = await ts.client.patch(`/api/applications/${a1.id}`, { version: a1.version, achievements: '最新成绩补充' });
  expect(saved.status).toBe(200);
  const after = (await ts.client.get(`/api/orders/${a.id}`)).body.order;
  expect(after.updatedAt).toBe(before.updatedAt); expect(after.version).toBe(before.version);
  const refreshed = await list('pageSize=1');
  expect(refreshed.items[0].id).toBe(a.id);
  expect(refreshed.items[0].lastActivityAt).toBe(saved.body.application.updatedAt);
});

it('直接合作只确认且费用为空，收费时约定并到账；超额失败回滚，不把空值当免费', async () => {
  const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
  await appAction(ts.client, app.id, 'recommend');
  const direct = await workflow(app.id, 'direct');
  expect(direct.response.status).toBe(200);
  expect(direct.response.body.order.status).toBe('reviewing');
  expect(direct.response.body.application.agencyFeeCents).toBeNull();
  expect(direct.response.body.application.feeSupplementReceivedCents).toBe(0);
  expect((await workflow(app.id, 'settle', { amountCents: 0 })).response.status).toBe(409);
  expect((await workflow(app.id, 'settle', { agencyFeeCents: 20000, depositDueCents: 0, amountCents: 20100 })).response.status).toBe(409);
  expect((await ts.client.get(`/api/applications/${app.id}`)).body.application.agencyFeeCents).toBeNull();
  const paid = await workflow(app.id, 'settle', { agencyFeeCents: 20000, depositDueCents: 0, amountCents: 20000 });
  expect(paid.response.status).toBe(200); expect(paid.response.body.order.status).toBe('completed');
  expect(paid.response.body.application.feeSupplementReceivedCents).toBe(20000);
});

it('未设置费用、未登记收退款时更正接口逐字段拒绝，已设费用不能伪造首次收款', async () => {
  const order = await createOrder(ts.client); const app = await createApplication(ts.client, order.id);
  const correct = async (corrected: Record<string, number>) => {
    const current = (await ts.client.get(`/api/applications/${app.id}`)).body.application;
    return ts.client.post(`/api/applications/${app.id}/finance/corrections`, { operationId: crypto.randomUUID(), version: current.version, reason: '更正录入', corrected });
  };
  const fields = ['agencyFeeCents','depositDueCents','depositReceivedCents','depositRefundedCents','feeSupplementReceivedCents','feeSupplementRefundedCents'];
  const before = (await ts.client.get(`/api/applications/${app.id}`)).body;
  for (const field of fields) {
    const response = await correct({ [field]: 0 });
    expect(response.status).toBe(409); expect(response.body.code).toBe('FINANCE_NOT_REGISTERED');
  }
  expect((await ts.client.get(`/api/applications/${app.id}`)).body).toEqual(before);
  await appAction(ts.client, app.id, 'recommend');
  expect((await workflow(app.id, 'schedule', { agencyFeeCents: 30000, depositDueCents: 10000 })).response.status).toBe(200);
  expect((await correct({ agencyFeeCents: 20000 })).status).toBe(200);
  for (const field of fields.slice(2)) {
    expect((await correct({ agencyFeeCents: 15000, [field]: 1000 })).status).toBe(409);
    expect((await ts.client.get(`/api/applications/${app.id}`)).body.application.agencyFeeCents).toBe(20000);
  }
});
it('已登记保证金、退款可更正；更正归零后仍能根据历史再次修正', async () => {
  const { app } = await trial();
  const correct = async (corrected: Record<string, number>) => {
    const current = (await ts.client.get(`/api/applications/${app.id}`)).body.application;
    return ts.client.post(`/api/applications/${app.id}/finance/corrections`, { operationId: crypto.randomUUID(), version: current.version, reason: '金额误录后补正', corrected });
  };
  expect((await correct({ depositReceivedCents: 0 })).status).toBe(200);
  expect((await correct({ depositReceivedCents: 10000 })).status).toBe(200);
  expect((await correct({ depositRefundedCents: 1000 })).status).toBe(409);
  expect((await workflow(app.id, 'fail')).response.status).toBe(200);
  expect((await workflow(app.id, 'refund', { amountCents: 1000 })).response.status).toBe(200);
  expect((await correct({ depositRefundedCents: 0 })).status).toBe(200);
  const again = await correct({ depositRefundedCents: 1000 });
  expect(again.status).toBe(200);
  expect(again.body.application.financeOperations.filter((op: {type: string}) => op.type === 'correction')).toHaveLength(4);
});
