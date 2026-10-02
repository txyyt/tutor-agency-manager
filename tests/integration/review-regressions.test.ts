import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import {
  createApplication, createOrder, startTestServer,
  validApplicationPayload, validOrderPayload, type TestServer,
} from '../helpers/testServer.js';

let ts: TestServer;
beforeEach(async () => { ts = await startTestServer(); });
afterEach(() => { vi.restoreAllMocks(); ts.close(); });

async function prepareRestore() {
  await createOrder(ts.client);
  const backup = await ts.app.backups.createBackup('manual');
  return ts.app.restores.validate(ts.app.backups.getBackupFile(backup.id).absolutePath);
}

describe('功能复核回归：记录修改与保留期', () => {
  it('公开订单编号与数字ID均可定位同一订单，错误编号返回404', async () => {
    const order = await createOrder(ts.client);
    expect((await ts.client.get(`/api/orders/${order.orderNo}`)).body.order.id).toBe(order.id);
    expect((await ts.client.get(`/api/orders/${order.id}`)).body.order.id).toBe(order.id);
    expect((await ts.client.get('/api/orders/JJ-NOT-FOUND')).status).toBe(404);
  });

  it('订单相同完整表单和空补丁不修改时间或版本，真实布尔值变更才修改', async () => {
    const order = await createOrder(ts.client);
    ts.app.clock.setOffsetMs(60_000);
    for (const patch of [validOrderPayload(), {}]) {
      const result = await ts.client.patch(`/api/orders/${order.id}`, { ...patch, version: order.version });
      expect(result.status).toBe(200);
      expect(result.body.changed).toBe(false);
      expect(result.body.order.updatedAt).toBe(order.updatedAt);
      expect(result.body.order.version).toBe(order.version);
    }
    const changed = await ts.client.patch(`/api/orders/${order.id}`, { payNegotiable: false, version: order.version });
    expect(changed.body.changed).toBe(true);
    expect(changed.body.order.payNegotiable).toBe(false);
    expect(changed.body.order.updatedAt).not.toBe(order.updatedAt);
  });

  it('老师相同完整表单不延长保留期，真实资料变更更新日期并保留绑定订单', async () => {
    const order = await createOrder(ts.client);
    const app = await createApplication(ts.client, order.id);
    ts.app.clock.setOffsetMs(60_000);
    const same = await ts.client.patch(`/api/applications/${app.id}`, { ...validApplicationPayload(), version: app.version });
    expect(same.status).toBe(200);
    expect(same.body.changed).toBe(false);
    expect(same.body.application.updatedAt).toBe(app.updatedAt);
    expect(same.body.application.version).toBe(app.version);
    const changed = await ts.client.patch(`/api/applications/${app.id}`, { teacherName: '修改姓名', version: app.version });
    expect(changed.body.application.orderId).toBe(order.id);
    expect(changed.body.application.updatedAt).not.toBe(app.updatedAt);
    expect(changed.body.application.status).toBe('submitted');
  });

  it('部分修改保留未提交文本，明确提交空字符串可清空', async () => {
    const order = await createOrder(ts.client);
    const app = await createApplication(ts.client, order.id, { trialConstraints: '周六', notes: '老师备注' });
    const o = await ts.client.patch(`/api/orders/${order.id}`, { parentPhone: '13800009999', version: order.version });
    expect(o.body.order.notes).toBe(order.notes);
    expect(o.body.order.teacherRequirements).toBe(order.teacherRequirements);
    expect(o.body.order.publicRequirements).toBe(order.publicRequirements);
    const a = await ts.client.patch(`/api/applications/${app.id}`, { phone: '13900009999', version: app.version });
    expect(a.body.application.achievements).toBe(app.achievements);
    expect(a.body.application.trialConstraints).toBe('周六');
    expect(a.body.application.notes).toBe('老师备注');
    const cleared = await ts.client.patch(`/api/applications/${app.id}`, { notes: '', version: a.body.application.version });
    expect(cleared.body.application.notes).toBe('');
  });

  it('修改薪资选择时校验合并后的资料，旧版本不能覆盖新资料', async () => {
    const order = await createOrder(ts.client);
    const app = await createApplication(ts.client, order.id);
    const invalid = await ts.client.patch(`/api/applications/${app.id}`, { acceptsOrderPay: false, version: app.version });
    expect(invalid.status).toBe(400);
    const valid = await ts.client.patch(`/api/applications/${app.id}`, { acceptsOrderPay: false, expectedHourlyPayCents: 20000, version: app.version });
    expect(valid.status).toBe(200);
    expect((await ts.client.patch(`/api/applications/${app.id}`, { teacherName: '旧页面', version: app.version })).status).toBe(409);
  });
});

describe('功能复核回归：恢复与每日备份', () => {
  it('恢复前已经开始但尚未完成的附件上传不能写入恢复后的数据库', async () => {
    const order = await createOrder(ts.client);
    const app = await createApplication(ts.client, order.id);
    const entry = await ts.app.backups.createBackup('manual');
    const { token } = await ts.app.restores.validate(ts.app.backups.getBackupFile(entry.id).absolutePath);
    const boundary = 'tam-regression-upload';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
    const first = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n${app.version}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="resume.png"\r\nContent-Type: image/png\r\n\r\n`), png,
    ]);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const load = ts.app.runtime.load.bind(ts.app.runtime);
    const spy = vi.spyOn(ts.app.runtime, 'load').mockImplementation(() => { entered(); return load(); });
    let upload!: http.ClientRequest;
    const response = new Promise<number>((resolve, reject) => {
      upload = http.request({ hostname: '127.0.0.1', port: ts.port, path: `/api/applications/${app.id}/attachments`, method: 'POST', headers: {
        Cookie: ts.client.state.cookie, 'X-CSRF-Token': ts.client.state.csrfToken, 'X-Data-Epoch': String(ts.client.state.dataEpoch),
        'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': first.length + tail.length,
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      upload.on('error', reject);
      upload.write(first);
    });
    try {
      await ready;
      spy.mockRestore();
      await ts.app.restores.commit(token);
      upload.end(tail);
      expect(await response).toBe(409);
      expect(ts.app.applications.getApplication(app.id).attachments).toHaveLength(0);
    } finally { upload.destroy(); }
  });

  it('恢复前快照生成后仍拒绝写入，不出现成功后记录消失', async () => {
    const { token } = await prepareRestore();
    const latest = await createOrder(ts.client, { parentName: '必须进入安全备份' });
    const original = ts.app.backups.performBackupLocked.bind(ts.app.backups);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(ts.app.backups, 'performBackupLocked').mockImplementation(async (kind) => {
      const entry = await original(kind);
      reached();
      await gate;
      return entry;
    });
    const commit = ts.app.restores.commit(token);
    try {
      await ready;
      const write = await ts.rawClient({ method: 'POST', path: '/api/orders', body: validOrderPayload() });
      expect(write.status).toBe(503);
      expect((await ts.client.get('/api/health')).status).toBe(200);
      expect((await ts.client.get('/api/session')).status).toBe(200);
    } finally { release(); }
    await commit;
    const safety = ts.app.backups.listBackups().entries.find((entry) => entry.kind === 'pre-restore')!;
    const preview = await ts.app.restores.validate(ts.app.backups.getBackupFile(safety.id).absolutePath);
    expect(preview.preview.counts.orders).toBe(2);
    expect(ts.app.repo.getOrderById(latest.id)).toBeNull(); // 恢复旧包的预期结果，最新数据已在安全备份
    expect((await ts.client.post('/api/orders', validOrderPayload())).status).toBe(201);
  });

  for (const failure of ['配置写入', '新数据库打开']) {
    it(`${failure}失败时保留最新数据、原指针和epoch，并允许继续使用`, async () => {
      const { token } = await prepareRestore();
      const latest = await createOrder(ts.client, { parentName: '恢复失败必须保留' });
      const original = structuredClone(ts.app.runtime.load());
      if (failure === '配置写入') {
        const save = ts.app.runtime.save.bind(ts.app.runtime);
        vi.spyOn(ts.app.runtime, 'save').mockImplementation(() => {
          if (ts.app.runtime.load().activeGenerationId !== original.activeGenerationId) throw new Error('模拟写配置失败');
          save();
        });
      } else {
        const open = ts.app.active.open.bind(ts.app.active);
        vi.spyOn(ts.app.active, 'open').mockImplementation((id, dir) => {
          if (id !== original.activeGenerationId) throw new Error('模拟打开失败');
          open(id, dir);
        });
      }
      await expect(ts.app.restores.commit(token)).rejects.toThrow('模拟');
      expect(ts.app.active.generationId).toBe(original.activeGenerationId);
      expect(ts.app.runtime.load().dataEpoch).toBe(original.dataEpoch);
      const disk = JSON.parse(fs.readFileSync(ts.app.paths.runtimeJson, 'utf8'));
      expect(disk.activeGenerationId).toBe(original.activeGenerationId);
      expect(disk.dataEpoch).toBe(original.dataEpoch);
      expect((await ts.client.get(`/api/orders/${latest.id}`)).body.order.parentName).toBe('恢复失败必须保留');
      expect((await ts.client.post('/api/orders', validOrderPayload())).status).toBe(201);
    });
  }

  it('超过15分钟的恢复令牌在提交时失效，当前数据不变', async () => {
    const { token } = await prepareRestore();
    const before = structuredClone(ts.app.runtime.load());
    ts.app.clock.setOffsetMs(16 * 60_000);
    await expect(ts.app.restores.commit(token)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(ts.app.runtime.load().activeGenerationId).toBe(before.activeGenerationId);
    expect(ts.app.runtime.load().dataEpoch).toBe(before.dataEpoch);
    expect(ts.app.backups.listBackups().entries.filter((e) => e.kind === 'pre-restore')).toHaveLength(0);
  });

  it('成功切换后收尾失败仍报告成功，启动对账可完成收尾', async () => {
    const { token } = await prepareRestore();
    const write = (ts.app.restores as any).writeOpState.bind(ts.app.restores);
    const spy = vi.spyOn(ts.app.restores as any, 'writeOpState').mockImplementation((...args: any[]) => {
      if (args[0].status === 'finished') throw new Error('模拟收尾失败');
      return write(...args);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await ts.app.restores.commit(token);
    expect(result.epoch).toBe(2);
    expect(ts.app.active.isOpen).toBe(true);
    expect(ts.app.orders.listOrders({ page: 1, pageSize: 20 }).total).toBe(1);
    expect(log).toHaveBeenCalled();
    spy.mockRestore();
    expect(ts.app.restores.reconcileOnStartup().resolved).toBe(1);
    const operation = JSON.parse(fs.readFileSync(`${ts.app.paths.restoreOpsDir}/${result.opId}.json`, 'utf8'));
    expect(operation.status).toBe('finished');
  });

  it('启动备份与定时备份独立，运行跨越默认20点才生成定时包', async () => {
    ts.app.clock.setOffsetMs(Date.parse('2030-01-01T01:00:00Z') - Date.now());
    await ts.app.scheduler.triggerNow(); await ts.app.scheduler.lifecycleBackup('startup');
    expect(ts.app.runtime.load().dailyBackup.lastSuccessDateHk).toBeNull();
    ts.app.clock.setOffsetMs(Date.parse('2030-01-01T12:00:10Z') - Date.now());
    await ts.app.scheduler.tickDailyBackup();
    expect(ts.app.backups.listBackups().entries.filter(e => e.kind === 'daily')).toHaveLength(1);
    expect(ts.app.backups.listBackups().entries.filter(e => e.kind === 'startup')).toHaveLength(1);
  });
});
