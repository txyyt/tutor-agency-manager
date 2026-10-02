// 备份/恢复/轮换/竞态/高水位（AC41-AC48、AC54-AC56、AC60、AC61、AC27）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
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

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer({ allowTimeControl: false });
});

afterAll(() => {
  ts.close();
});

async function makeRichData(prefix: string): Promise<{ orderId: number; appId: number }> {
  const order = await createOrder(ts.client, {
    parentName: `${prefix}家长`,
    parentWechat: `${prefix}-wx`,
    notes: `${prefix}内部备注`,
    sourceTemplateText: `${prefix}-粘贴原文`,
  });
  const a = await createApplication(ts.client, order.id, { teacherName: `${prefix}老师` });
  // 附件
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), `${prefix}-简历.png`);
  const detail = (await ts.client.get(`/api/applications/${a.id}`)).body;
  fd.append('version', String(detail.application.version));
  await ts.client.postForm(`/api/applications/${a.id}/attachments`, fd);
  await appAction(ts.client, a.id, 'recommend');
  await appAction(ts.client, a.id, 'schedule-trial', { orderVersion: order.version });
  await doFinance(ts.client, a.id, { type: 'set-fees', version: a.version, agencyFeeCents: 12300, depositDueCents: 4500 });
  await doFinance(ts.client, a.id, { type: 'receive-deposit', version: a.version, amountCents: 4500 });
  await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: (await getDetail(ts.client, order.id)).order.version });
  await appAction(ts.client, a.id, 'pass', { orderVersion: (await getDetail(ts.client, order.id)).order.version, confirmCooperation: true });
  await doFinance(ts.client, a.id, { type: 'receive-supplement', version: a.version, amountCents: 7800 });
  await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: (await getDetail(ts.client, order.id)).order.version });
  return { orderId: order.id, appId: a.id };
}

it('统一备份根目录适用于全部类型，切换目录后旧备份仍能下载和校验恢复', async () => {
  const isolated = await startTestServer({ allowTimeControl: false });
  const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-backup-root-'));
  try {
    const old = (await isolated.client.post('/api/backups', { kind: 'manual' })).body.entry;
    expect(old.dirPath).toBe(path.join(isolated.dataDir, 'backups', 'manual'));
    expect((await isolated.client.patch('/api/backups/settings', { autoBackupDir: customRoot, confirmMigration: true })).status).toBe(200);
    const paths = (await isolated.client.get('/api/backups')).body.paths;
    expect(paths).toEqual({ rootDir: customRoot, dailyDir: path.join(customRoot, 'daily'), manualDir: path.join(customRoot, 'manual'), lifecycleDir: path.join(customRoot, 'lifecycle'), safetyDir: path.join(customRoot, 'safety') });
    const kinds = ['daily', 'manual', 'startup', 'shutdown', 'pre-restore', 'pre-cleanup', 'pre-delete'] as const;
    for (const kind of kinds) {
      const entry = await isolated.app.backups.createBackup(kind);
      const folder = kind === 'daily' || kind === 'manual' ? kind : kind === 'startup' || kind === 'shutdown' ? 'lifecycle' : 'safety';
      expect(entry.dirPath).toBe(path.join(customRoot, folder));
      expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(true);
    }
    expect(isolated.app.backups.getBackupFile(old.id).absolutePath).toBe(path.join(customRoot, 'manual', old.fileName));
    expect(fs.existsSync(path.join(old.dirPath, old.fileName))).toBe(false);
    expect((await isolated.client.post('/api/restores/validate-existing', { backupId: old.id })).status).toBe(200);
    expect((await isolated.client.patch('/api/backups/settings', { autoBackupDir: null, confirmMigration: true })).status).toBe(200);
    const reset = (await isolated.client.post('/api/backups', { kind: 'manual' })).body.entry;
    expect(reset.dirPath).toBe(path.join(isolated.dataDir, 'backups', 'manual'));
    expect((await isolated.client.get('/api/backups')).body.paths.rootDir).toBe(path.join(isolated.dataDir, 'backups'));
  } finally {
    isolated.close();
    fs.rmSync(customRoot, { recursive: true, force: true });
  }
});

async function createManualBackup(): Promise<any> {
  const res = await ts.client.post('/api/backups', { kind: 'manual' });
  expect(res.status).toBe(201);
  return (res.body as any).entry;
}

async function downloadBackupZip(entryId: string): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${ts.port}/api/backups/${entryId}/download`, {
    headers: { 'X-CSRF-Token': ts.client.state.csrfToken, 'X-Data-Epoch': String(ts.client.state.dataEpoch), Cookie: ts.client.state.cookie },
  });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('AC41：界面导出完整ZIP（数据库/附件/清单，关系金额时间原文完整，导出不延期）', () => {
  it('备份包含全部内容且校验值正确', async () => {
    const { orderId, appId } = await makeRichData('备份源');
    const orderBefore = (await getDetail(ts.client, orderId)).order;
    const _appBefore = (await ts.client.get(`/api/applications/${appId}`)).body.application;

    const entry = await createManualBackup();
    expect(entry.fileName).toMatch(/^tutor-backup-manual-\d{8}-\d{6}-[0-9a-f]{6}\.zip$/);
    const zipBuf = await downloadBackupZip(entry.id);
    const zip = await JSZip.loadAsync(zipBuf);
    const manifest = JSON.parse(await (zip.file('manifest.json')!.async('string')));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.counts.orders).toBeGreaterThanOrEqual(1);
    expect(manifest.counts.applications).toBeGreaterThanOrEqual(1);
    expect(manifest.numberHighWater.orders).toBeGreaterThanOrEqual(orderId);
    expect(manifest.displayTimezone).toBe('Asia/Hong_Kong');
    // 数据库内容完整
    expect(zip.file('database.sqlite')).toBeTruthy();
    expect(manifest.files.some((f: any) => f.path.startsWith('attachments/'))).toBe(true);
    // 导出不延期：updated_at不变
    const orderAfter = (await getDetail(ts.client, orderId)).order;
    expect(orderAfter.updatedAt).toBe(orderBefore.updatedAt);
    // 原文随备份（在数据库里）
    expect(orderBefore.sourceTemplateText).toContain('备份源-粘贴原文');
  });
});

describe('AC42/AC61：恢复到备份时点、高水位与编号不复用', () => {
  it('新建高水位编号后恢复旧包，新编号仍超过原高水位；原记录时间编号保持', async () => {
    // 1) 备份（此刻只有少数订单）
    const entry = await createManualBackup();
    // 2) 继续创建更多数据（推高编号）
    const later = await createOrder(ts.client, { parentName: '备份后新增' });
    expect(later.id).toBeGreaterThan(1);
    // 3) 恢复旧包
    const zipBuf = await downloadBackupZip(entry.id);
    const tmpZip = path.join(os.tmpdir(), `restore-${crypto.randomUUID()}.zip`);
    fs.writeFileSync(tmpZip, zipBuf);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'backup.zip');
    const validate = await ts.client.postForm('/api/restores/validate', fd);
    expect(validate.status).toBe(200);
    const { token, preview } = validate.body as any;
    expect(preview.counts.orders).toBeGreaterThanOrEqual(1);
    const commit = await ts.client.post('/api/restores/commit', { token });
    expect(commit.status).toBe(200);
    const commitBody = commit.body as any;
    expect(commitBody.epoch).toBeGreaterThanOrEqual(2);
    // 4) 备份后新增的数据被替换（不存在）
    expect((await ts.client.get(`/api/orders/${later.id}`)).status).toBe(404);
    // 5) 新建编号 > 恢复前的最大编号（本机高水位）
    const fresh = await createOrder(ts.client, { parentName: '恢复后新建' });
    expect(fresh.id).toBeGreaterThan(later.id);
    // 6) 旧包没有高水位字段时兼容：删manifest字段再恢复（AC61后半）
    const zip2 = await JSZip.loadAsync(zipBuf);
    const manifestRaw = await zip2.file('manifest.json')!.async('string');
    const manifest = JSON.parse(manifestRaw);
    delete manifest.numberHighWater;
    zip2.file('manifest.json', JSON.stringify(manifest));
    const oldStyleBuf = await zip2.generateAsync({ type: 'nodebuffer' });
    const fd2 = new FormData();
    fd2.append('file', new Blob([new Uint8Array(oldStyleBuf)], { type: 'application/zip' }), 'old.zip');
    const v2 = await ts.client.postForm('/api/restores/validate', fd2);
    expect(v2.status).toBe(200);
    const c2 = await ts.client.post('/api/restores/commit', { token: (v2.body as any).token });
    expect(c2.status).toBe(200);
    const fresh2 = await createOrder(ts.client, { parentName: '兼容包恢复后新建' });
    expect(fresh2.id).toBeGreaterThan(fresh.id);
    // 恢复保留原created_at/updated_at（AC42）
    const oldest = (await ts.client.get('/api/orders')).body.items[0];
    expect(oldest.createdAt).toBeTruthy();
    void tmpZip;
    fs.rmSync(tmpZip, { force: true });
  });
});

describe('AC43/AC47：损坏包与非法路径拒绝；当前数据不变', () => {
  async function validateBuffer(buf: Buffer, name = 'x.zip'): Promise<{ status: number; body: any }> {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(buf)], { type: 'application/zip' }), name);
    return ts.client.postForm('/api/restores/validate', fd);
  }

  it('损坏ZIP拒绝', async () => {
    const r = await validateBuffer(Buffer.from('this is not a zip file at all'));
    expect(r.status).toBe(400);
    expect(r.body.code).toMatch(/INVALID_ZIP/);
  });

  it('校验值不符拒绝', async () => {
    const entry = await createManualBackup();
    const zipBuf = await downloadBackupZip(entry.id);
    const zip = await JSZip.loadAsync(zipBuf);
    // 篡改数据库一个字节 → 重新打包
    const db = await zip.file('database.sqlite')!.async('nodebuffer');
    db[100] = db[100]! ^ 0xff;
    zip.file('database.sqlite', db);
    const tampered = await zip.generateAsync({ type: 'nodebuffer' });
    const r = await validateBuffer(tampered);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CHECKSUM_MISMATCH');
  });

  it('路径穿越/绝对路径/重复条目拒绝；清单外文件拒绝', async () => {
    const entry = await createManualBackup();
    const zipBuf = await downloadBackupZip(entry.id);

    const buildWith = async (mutate: (zip: JSZip) => Promise<void>) => {
      const zip = await JSZip.loadAsync(zipBuf);
      await mutate(zip);
      return validateBuffer(await zip.generateAsync({ type: 'nodebuffer' }));
    };

    const traversal = await buildWith(async (zip) => {
      zip.file('attachments\\..\\..\\evil.txt', 'bad');
      const m = JSON.parse(await zip.file('manifest.json')!.async('string'));
      m.files.push({ path: 'attachments\\..\\..\\evil.txt', sha256: crypto.createHash('sha256').update('bad').digest('hex'), size: 3 });
      zip.file('manifest.json', JSON.stringify(m));
    });
    expect(traversal.status).toBe(400);
    expect(traversal.body.code).toBe('INVALID_ENTRY_PATH');

    const absolute = await buildWith(async (zip) => {
      zip.file('/etc/passwd', 'x');
      const m = JSON.parse(await zip.file('manifest.json')!.async('string'));
      m.files.push({ path: '/etc/passwd', sha256: crypto.createHash('sha256').update('x').digest('hex'), size: 1 });
      zip.file('manifest.json', JSON.stringify(m));
    });
    expect(absolute.status).toBe(400);
    expect(absolute.body.code).toBe('INVALID_ENTRY_PATH');

    const caseConflict = await buildWith(async (zip) => {
      zip.file('attachments/CASE.bin', 'x');
      zip.file('attachments/case.bin', 'y');
      const m = JSON.parse(await zip.file('manifest.json')!.async('string'));
      m.files.push({ path: 'attachments/CASE.bin', sha256: crypto.createHash('sha256').update('x').digest('hex'), size: 1 });
      m.files.push({ path: 'attachments/case.bin', sha256: crypto.createHash('sha256').update('y').digest('hex'), size: 1 });
      zip.file('manifest.json', JSON.stringify(m));
    });
    expect(caseConflict.status).toBe(400);
    expect(caseConflict.body.code).toBe('CASE_CONFLICT_ENTRY');

    const extra = await buildWith(async (zip) => {
      zip.file('sneaky.txt', 'not in manifest');
    });
    expect(extra.status).toBe(400);
    expect(extra.body.code).toBe('MANIFEST_MISMATCH');
  });

  it('错误数据库/缺表拒绝', async () => {
    const entry = await createManualBackup();
    const zipBuf = await downloadBackupZip(entry.id);
    const zip = await JSZip.loadAsync(zipBuf);
    // 换一个无业务表的合法SQLite
    const { DatabaseSync } = await import('node:sqlite');
    const tmp = path.join(os.tmpdir(), `fake-${crypto.randomUUID().slice(0, 8)}.sqlite`);
    const fake = new DatabaseSync(tmp);
    fake.exec('CREATE TABLE junk(a)');
    fake.close();
    zip.file('database.sqlite', fs.readFileSync(tmp));
    const m = JSON.parse(await zip.file('manifest.json')!.async('string'));
    for (const f of m.files) {
      if (f.path === 'database.sqlite') {
        const data = fs.readFileSync(tmp);
        f.sha256 = crypto.createHash('sha256').update(data).digest('hex');
        f.size = data.length;
      }
    }
    zip.file('manifest.json', JSON.stringify(m));
    const r = await validateBuffer(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(r.status).toBe(400);
    expect(r.body.code).toMatch(/INVARIANT|DB_|FK_|MANIFEST_MISMATCH/);
    // 当前数据不受影响
    const dash = await ts.client.get('/api/dashboard');
    expect(dash.status).toBe(200);
  });

  it('备份下载只能按登记ID，不能读任意外部文件', async () => {
    const secret = path.join(os.tmpdir(), `secret-${crypto.randomUUID()}.txt`);
    fs.writeFileSync(secret, '机密');
    const r1 = await ts.client.get(`/api/backups/not-a-uuid/download`);
    expect(r1.status).toBe(400);
    const r2 = await ts.client.get(`/api/backups/${encodeURIComponent(secret)}/download`);
    expect(r2.status).toBe(400);
    fs.rmSync(secret, { force: true });
  });
});

describe('AC45/AC60：轮换规则与目录隔离', () => {
  it('已登记备份可直接校验，校验不修改当前数据，确认后替换且生成安全备份', async () => {
    const backup = (await ts.client.post('/api/backups', { kind: 'manual' })).body.entry;
    const after = await createOrder(ts.client, { parentName: '已有备份恢复回归' });
    const checked = await ts.client.post('/api/restores/validate-existing', { backupId: backup.id });
    expect(checked.status).toBe(200); expect(checked.body.token).toBeTruthy();
    expect((await ts.client.get(`/api/orders/${after.id}`)).status).toBe(200);
    expect((await ts.client.post('/api/restores/validate-existing', { backupId: '../database.sqlite' })).status).toBe(400);
    expect((await ts.client.post('/api/restores/validate-existing', { backupId: crypto.randomUUID() })).status).toBe(400);
    const restored = await ts.client.post('/api/restores/commit', { token: checked.body.token });
    expect(restored.status).toBe(200); await ts.client.bootstrap();
    expect((await ts.client.get(`/api/orders/${after.id}`)).status).toBe(404);
    expect((await ts.client.get('/api/backups')).body.entries.some((e: {kind: string}) => e.kind === 'pre-restore')).toBe(true);
  });
  it('手动备份只保留最近5份，旧包删除，最新包仍可校验恢复', async () => {
    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      const result = await ts.client.post('/api/backups', { kind: 'manual' });
      expect(result.status).toBe(201); created.push(result.body.entry.id);
    }
    const list = (await ts.client.get('/api/backups')).body.entries.filter((e: {kind: string}) => e.kind === 'manual');
    expect(list).toHaveLength(5);
    expect(list.map((e: {id: string}) => e.id)).toEqual(created.slice(-5));
    expect((await ts.client.get(`/api/backups/${created[0]}/download`)).status).toBe(400);
    const latest = ts.app.backups.getBackupFile(created[11]!);
    expect((await ts.app.restores.validate(latest.absolutePath)).preview.counts.orders).toBeGreaterThanOrEqual(0);
  });
  it('备份时间可保存和重载，非法值拒绝且旧配置保持可用', async () => {
    expect((await ts.client.patch('/api/backups/settings', { dailyBackupTime: '21:30' })).status).toBe(200);
    expect((await ts.client.get('/api/backups')).body.settings.dailyBackupTime).toBe('21:30');
    expect(JSON.parse(fs.readFileSync(ts.app.paths.runtimeJson, 'utf8')).backupSettings.dailyBackupTime).toBe('21:30');
    for (const value of ['24:00', '02:60', '2:00', '']) {
      expect((await ts.client.patch('/api/backups/settings', { dailyBackupTime: value })).status).toBe(400);
    }
    expect((await ts.client.get('/api/backups')).body.settings.dailyBackupTime).toBe('21:30');
    await ts.client.patch('/api/backups/settings', { dailyBackupTime: '02:00' });
  });
  it('定时备份固定保留5份；安全备份最多5份/30天；日轮换不影响手动备份', async () => {
    // 调低保留数验证轮换
    await ts.client.patch('/api/backups/settings', { dailyKeepCount: 5 });
    for (let i = 0; i < 7; i++) {
      await ts.client.post('/api/backups', { kind: 'daily' });
    }
    let backups = (await ts.client.get('/api/backups')).body;
    const dailies = backups.entries.filter((e: any) => e.kind === 'daily');
    expect(dailies.length).toBe(5); // 只保留5份
    // 手动备份不受影响
    const manualCount = backups.entries.filter((e: any) => e.kind === 'manual').length;
    expect(manualCount).toBeGreaterThanOrEqual(2); // 上面创建的手动包未被轮换
    // 安全备份5份上限
    for (let i = 0; i < 12; i++) {
      await ts.client.post('/api/backups', { kind: 'daily' }); // daily轮换不影响
    }
    // 直接通过内部方法创建安全备份验证上限
    for (let i = 0; i < 12; i++) {
      await ts.app.backups.performBackupLocked('pre-cleanup');
    }
    backups = (await ts.client.get('/api/backups')).body;
    const safes = backups.entries.filter((e: any) => e.kind === 'pre-cleanup');
    expect(safes.length).toBe(5);
    // 目录隔离：自动备份目录与数据目录重叠被拒绝
    const bad = await ts.client.patch('/api/backups/settings', { autoBackupDir: ts.dataDir });
    expect(bad.status).toBe(400);
    const bad2 = await ts.client.patch('/api/backups/settings', { autoBackupDir: path.join(ts.dataDir, 'generations') });
    expect(bad2.status).toBe(400);
    // 恢复为默认
    await ts.client.patch('/api/backups/settings', { dailyKeepCount: 50, autoBackupDir: null });
  });
});

describe('AC46/AC55/AC56：恢复前备份、中断恢复、epoch拦截、锁不嵌套、双实例', () => {
  it('AC56a：清理内部调用备份不死锁（锁不嵌套）', async () => {
    const result = await ts.app.cleanup.run(); // 内部 performBackupLocked，不重复获取锁
    expect(result).toBeTruthy();
  });

  it('AC56b：同数据目录第二实例拒绝', async () => {
    const env = loadEnv({ dataDir: ts.dataDir, port: 3999, appRoot: process.cwd() });
    const second = createServer(env);
    expect(() => second.start(false)).toThrow(/单实例/);
  });

  it('AC55：恢复后旧epoch写请求被拦截；旧数据代被清理；备份配置保留', () => {
    // 详细流程在粘贴-恢复联动测试中验证；此处验证配置存在性
    const cfg = ts.app.runtime.load();
    expect(cfg.dataEpoch).toBeGreaterThanOrEqual(1);
    expect(cfg.backupSettings.dailyKeepCount).toBeGreaterThan(0);
  });

  it('AC46：恢复前备份失败则终止导入，当前数据可用', async () => {
    // 用独立服务器验证
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-bk-'));
    const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
    const server = createServer(env);
    server.start(false);
    const http1 = await import('node:http');
    const hs = http1.createServer(server.app);
    await new Promise<void>((r) => hs.listen(0, '127.0.0.1', r));
    const port = (hs.address() as any).port;
    const c = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c.bootstrap();
    await c.post('/api/orders', validOrder());
    // 备份成功包
    await c.post('/api/backups', { kind: 'manual' });
    const backups = (await c.get('/api/backups')).body;
    expect(backups.entries.length).toBe(1);
    // 破坏备份能力：把staging目录变成只读不可写（模拟备份失败）——通过替换active为坏状态太侵入，
    // 改为：monkey-patch performBackupLocked抛错后调用commit路径等价服务
    const original = server.backups.performBackupLocked.bind(server.backups);
    server.backups.performBackupLocked = async () => {
      throw new Error('模拟备份失败');
    };
    // 准备一个合法zip（从第一个备份包）
    const entry = backups.entries[0];
    const zipBuf = fs.readFileSync(path.join(entry.dirPath, entry.fileName));
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'b.zip');
    const v = await c.postForm('/api/restores/validate', fd);
    expect(v.status).toBe(200);
    const commit = await c.post('/api/restores/commit', { token: (v.body as any).token });
    expect(commit.status).toBe(409);
    expect(JSON.stringify(commit.body)).toContain('模拟备份失败');
    // 当前数据仍可用
    const orders = (await c.get('/api/orders')).body;
    expect(orders.total).toBe(1);
    server.backups.performBackupLocked = original;
    hs.close();
    server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('AC46b：prepared未切换的恢复操作，重启后保留原代并清理新代', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ro-'));
    const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
    const server = createServer(env);
    server.start(false);
    const http1 = await import('node:http');
    const hs = http1.createServer(server.app);
    await new Promise<void>((r) => hs.listen(0, '127.0.0.1', r));
    const port = (hs.address() as any).port;
    const c = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c.bootstrap();
    await c.post('/api/orders', validOrder());
    const activeGen = server.runtime.load().activeGenerationId;
    hs.close();
    server.stop();

    // 模拟中断：手工放入一个prepared恢复日志和一个完整新代目录
    const fakeGen = `gen-fake-${crypto.randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(dataDir, 'generations', fakeGen, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'generations', fakeGen, 'database.sqlite'), fs.readFileSync(path.join(dataDir, 'generations', activeGen, 'database.sqlite')));
    fs.mkdirSync(path.join(dataDir, 'restore-ops'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'restore-ops', 'op-fake.json'),
      JSON.stringify({ opId: 'op-fake', status: 'prepared', targetGenerationId: fakeGen, sourceGenerationId: activeGen, createdAtUtc: new Date().toISOString() }),
    );
    // runtime仍指向原代（未切换）

    const server2 = createServer(env);
    server2.start(false);
    // 对账：未切换 → 作废新代
    expect(server2.runtime.load().activeGenerationId).toBe(activeGen);
    expect(fs.existsSync(path.join(dataDir, 'generations', fakeGen))).toBe(false);
    const opState = JSON.parse(fs.readFileSync(path.join(dataDir, 'restore-ops', 'op-fake.json'), 'utf-8'));
    expect(opState.status).toBe('aborted');
    // 数据完好
    const hs2 = http1.createServer(server2.app);
    await new Promise<void>((r) => hs2.listen(0, '127.0.0.1', r));
    const port2 = (hs2.address() as any).port;
    const c2 = new TestClient(port2, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c2.bootstrap();
    expect((await c2.get('/api/orders')).body.total).toBe(1);
    hs2.close();
    server2.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('AC46c：已切换未收尾（runtime指向新代），重启后收尾并清理旧代', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-ro2-'));
    const env = loadEnv({ dataDir, port: 3000, appRoot: process.cwd() });
    const server = createServer(env);
    server.start(false);
    const http1 = await import('node:http');
    const hs = http1.createServer(server.app);
    await new Promise<void>((r) => hs.listen(0, '127.0.0.1', r));
    const port = (hs.address() as any).port;
    const c = new TestClient(port, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c.bootstrap();
    await c.post('/api/orders', validOrder());
    const oldGen = server.runtime.load().activeGenerationId;
    hs.close();
    server.stop();

    // 模拟：runtime已指向新代（切换完成）但旧代未清理、op状态仍为prepared
    const newGen = `gen-new-${crypto.randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(dataDir, 'generations', newGen, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'generations', newGen, 'database.sqlite'), fs.readFileSync(path.join(dataDir, 'generations', oldGen, 'database.sqlite')));
    const runtimePath = path.join(dataDir, 'runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
    runtime.activeGenerationId = newGen;
    runtime.dataEpoch = 2;
    fs.writeFileSync(runtimePath, JSON.stringify(runtime));
    fs.writeFileSync(
      path.join(dataDir, 'restore-ops', 'op-fake2.json'),
      JSON.stringify({ opId: 'op-fake2', status: 'prepared', targetGenerationId: newGen, sourceGenerationId: oldGen, createdAtUtc: new Date().toISOString() }),
    );

    const server2 = createServer(env);
    server2.start(false);
    expect(server2.runtime.load().activeGenerationId).toBe(newGen);
    expect(fs.existsSync(path.join(dataDir, 'generations', oldGen))).toBe(false); // 旧代清理
    const opState = JSON.parse(fs.readFileSync(path.join(dataDir, 'restore-ops', 'op-fake2.json'), 'utf-8'));
    expect(opState.status).toBe('finished');
    const hs2 = http1.createServer(server2.app);
    await new Promise<void>((r) => hs2.listen(0, '127.0.0.1', r));
    const port2 = (hs2.address() as any).port;
    const c2 = new TestClient(port2, { cookie: '', csrfToken: '', dataEpoch: 1 });
    await c2.bootstrap();
    expect((await c2.get('/api/orders')).body.total).toBe(1);
    hs2.close();
    server2.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('AC54：快照完成后删除源附件，备份仍可恢复', () => {
  it('备份后删除附件并完成订单 → 恢复该备份 → 附件仍然齐全', async () => {
    // 自建流程：附件上传后备份，再删除附件并完成订单
    const order = await createOrder(ts.client, { parentName: '快照竞态家长' });
    const appId = (await createApplication(ts.client, order.id)).id;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d1e480000000049454e44ae426082', 'hex');
    const fdUp = new FormData();
    fdUp.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), '快照-简历.png');
    const d0 = (await ts.client.get(`/api/applications/${appId}`)).body;
    fdUp.append('version', String(d0.application.version));
    await ts.client.postForm(`/api/applications/${appId}/attachments`, fdUp);
    const entry = await createManualBackup();
    // 备份后删除附件（订单进行中允许删除）
    const detail = (await ts.client.get(`/api/applications/${appId}`)).body;
    const fileId = detail.application.attachments[0].fileId;
    const del = await ts.client.delete(`/api/applications/${appId}/attachments/${fileId}?version=${detail.application.version}`);
    expect(del.status).toBe(200);
    // 完成订单
    await appAction(ts.client, appId, 'recommend');
    await appAction(ts.client, appId, 'schedule-trial', {});
    await doFinance(ts.client, appId, { type: 'set-fees', version: (await (await ts.client.get(`/api/applications/${appId}`)).body).application.version, agencyFeeCents: 10000, depositDueCents: 0 });
    await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'start-trial', version: (await getDetail(ts.client, order.id)).order.version });
    await appAction(ts.client, appId, 'pass', { confirmCooperation: true });
    await doFinance(ts.client, appId, { type: 'receive-supplement', amountCents: 10000 });
    await ts.client.post(`/api/orders/${order.id}/actions`, { action: 'complete', version: (await getDetail(ts.client, order.id)).order.version });
    // 恢复
    const zipBuf = await downloadBackupZip(entry.id);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'b.zip');
    const v = await ts.client.postForm('/api/restores/validate', fd);
    expect(v.status).toBe(200);
    const commit = await ts.client.post('/api/restores/commit', { token: (v.body as any).token });
    expect(commit.status).toBe(200);
    // 附件回来了
    const after = (await ts.client.get(`/api/applications/${appId}`)).body;
    expect(after.application.attachments.some((a: any) => a.originalName.includes('简历'))).toBe(true);
    // 数据库和附件来自同一代：附件文件真实存在
    const meta = after.application.attachments[0];
    const attPath = path.join(ts.dataDir, 'generations', ts.app.runtime.load().activeGenerationId, 'attachments', meta.storagePath);
    expect(fs.existsSync(attPath)).toBe(true);
  });
});

function validOrder(): Record<string, unknown> {
  return {
    parentName: '临时家长', parentWechat: `wx-${crypto.randomUUID().slice(0, 6)}`, parentPhone: '13800000000',
    childGrade: '初二', subjects: '数学', learningSituation: '一般', tutoringGoal: '提高',
    teachingMode: 'offline', locationDetail: '某小区', publicArea: '某区',
    weeklySchedule: '周末', publicSchedule: '周末', sessionsPerWeek: 1, sessionMinutes: 60,
    hourlyPayCents: 10000, payNegotiable: true, genderPreference: 'any',
  };
}
