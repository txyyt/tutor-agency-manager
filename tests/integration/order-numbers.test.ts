import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { startTestServer, createOrder, validOrderPayload, type TestServer } from '../helpers/testServer.js';
import { createServer } from '../../src/server/serverFactory.js';
import { loadEnv } from '../../src/server/env.js';
import { compareOrderNumbers } from '../../src/server/orderNumbers.js';
let ts: TestServer;
beforeEach(async () => { ts = await startTestServer(); });
afterEach(() => ts.close());
function at(time: string) { ts.app.clock.setOffsetMs(Date.parse(time) - Date.now()); }

it('北京时间午夜重置，回到旧日继续计数，幂等重试不消耗序号', async () => {
  at('2030-01-01T15:59:00.000Z');
  const a = await createOrder(ts.client); const b = await createOrder(ts.client);
  expect(a.orderNo).toBe('JJ-20300101-0001'); expect(b.orderNo).toBe('JJ-20300101-0002');
  at('2030-01-01T16:01:00.000Z');
  const requestId = crypto.randomUUID();
  const input = validOrderPayload({ creationRequestId: requestId });
  const first = await ts.client.post('/api/orders', input); const retry = await ts.client.post('/api/orders', input);
  expect(first.body.order.orderNo).toBe('JJ-20300102-0001'); expect(retry.body.order.id).toBe(first.body.order.id);
  expect((await createOrder(ts.client)).orderNo).toBe('JJ-20300102-0002');
  at('2030-01-01T15:59:00.000Z');
  expect((await createOrder(ts.client)).orderNo).toBe('JJ-20300101-0003');
});
it('删除最高编号不复用，新服务读取持久化计数继续编号', async () => {
  at('2030-01-02T01:00:00.000Z');
  const a = await createOrder(ts.client);
  ts.app.active.current().prepare('DELETE FROM orders WHERE id = ?').run(a.id);
  expect((await createOrder(ts.client)).orderNo).toBe('JJ-20300102-0002');
  ts.app.stop();
  const restarted = createServer(loadEnv({ dataDir: ts.dataDir, appRoot: process.cwd() }));
  try {
    restarted.start(false); restarted.clock.setOffsetMs(Date.parse('2030-01-02T01:00:00Z') - Date.now());
    expect(restarted.orders.createOrder(validOrderPayload(), {}).order.orderNo).toBe('JJ-20300102-0003');
  } finally { restarted.stop(); }
});
it('旧编号保留，同日续排；四位不足时扩展并正确排序', async () => {
  at('2030-01-02T01:00:00.000Z');
  const old = await createOrder(ts.client);
  ts.app.active.current().prepare('UPDATE orders SET order_no = ? WHERE id = ?').run('JJ-20300102-9999', old.id);
  const fresh = await createOrder(ts.client);
  expect(fresh.orderNo).toBe('JJ-20300102-10000');
  expect((await ts.client.get(`/api/orders/${old.id}`)).body.order.orderNo).toBe('JJ-20300102-9999');
  expect(compareOrderNumbers(old.orderNo.replace('0001','9999'), fresh.orderNo)).toBeLessThan(0);
  const list = (await ts.client.get('/api/orders?tasksFirst=0&sort=number-asc')).body.items;
  expect(list.map((o: {id: number}) => o.id)).toEqual([old.id, fresh.id]);
  at('2030-01-03T01:00:00Z'); expect((await createOrder(ts.client)).orderNo).toBe('JJ-20300103-0001');
});
it('恢复旧包不回退本机每日计数，旧格式备份仍可恢复', async () => {
  at('2030-01-02T01:00:00Z');
  await createOrder(ts.client);
  const backup = await ts.app.backups.createBackup('manual');
  const file = path.join(backup.dirPath, backup.fileName);
  const later = await createOrder(ts.client);
  const checked = await ts.app.restores.validate(file); await ts.app.restores.commit(checked.token);
  const next = await createOrder(ts.client); expect(next.orderNo).toBe('JJ-20300102-0003'); expect(next.id).toBeGreaterThan(later.id);
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  delete manifest.orderDailyHighWater;
  zip.file('manifest.json', JSON.stringify(manifest));
  const legacyFile = path.join(ts.dataDir, 'legacy-number-backup.zip');
  fs.writeFileSync(legacyFile, await zip.generateAsync({type:'nodebuffer'}));
  const legacy = await ts.app.restores.validate(legacyFile); await ts.app.restores.commit(legacy.token);
  expect((await createOrder(ts.client)).orderNo).toBe('JJ-20300102-0004');
});
it('新机器恢复备份也保留已删除订单的每日序号', async () => {
  at('2030-01-02T01:00:00Z');
  const a = await createOrder(ts.client); const b = await createOrder(ts.client);
  ts.app.active.current().prepare('DELETE FROM orders WHERE id = ?').run(b.id);
  const backup = await ts.app.backups.createBackup('manual');
  const other = await startTestServer();
  try {
    other.app.clock.setOffsetMs(Date.parse('2030-01-02T01:00:00Z') - Date.now());
    const checked = await other.app.restores.validate(path.join(backup.dirPath, backup.fileName));
    await other.app.restores.commit(checked.token);
    expect((await createOrder(other.client)).orderNo).toBe('JJ-20300102-0003');
    expect((await other.client.get(`/api/orders/${a.id}`)).body.order.orderNo).toBe(a.orderNo);
  } finally { other.close(); }
});
