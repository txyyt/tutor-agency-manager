import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { startTestServer, type TestServer, createOrder } from '../helpers/testServer.js';

let ts: TestServer;
beforeEach(async () => { ts = await startTestServer(); });
afterEach(() => { vi.restoreAllMocks(); ts.close(); });

it('启动和关闭合计5份、定时独立5份、手动5份，正常包仍可恢复', async () => {
  await createOrder(ts.client);
  const newest: string[] = [];
  for (let i = 0; i < 8; i++) {
    const kind = i % 2 ? 'shutdown' : 'startup';
    const entry = await ts.app.backups.createBackup(kind);
    newest.push(entry.id);
    await ts.app.backups.createBackup('daily');
  }
  const all = ts.app.backups.listBackups();
  const lifecycle = all.entries.filter(e => ['startup', 'shutdown'].includes(e.kind));
  expect(lifecycle.map(e => e.id)).toEqual(newest.slice(-5));
  expect(all.entries.filter(e => e.kind === 'daily')).toHaveLength(5);
  const last = lifecycle.at(-1)!;
  const file = ts.app.backups.getBackupFile(last.id).absolutePath;
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  expect(JSON.parse(await zip.file('manifest.json')!.async('string')).kind).toBe('shutdown');
  expect((await ts.app.restores.validate(file)).preview.counts.orders).toBe(1);
  expect((await ts.client.patch('/api/backups/settings', { dailyKeepCount: 30 })).status).toBe(400);
});

it('手动删除被占用文件拒绝并保留索引，解除占用后可重试成功', async () => {
  const entry = await ts.app.backups.createBackup('manual');
  const target = ts.app.backups.getBackupFile(entry.id).absolutePath;
  const unlink = fs.unlinkSync;
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === target) throw new Error('文件被占用');
    return unlink(file);
  });
  const response = await ts.client.delete(`/api/backups/${entry.id}`);
  expect(response.status).toBe(409); expect(response.body.code).toBe('BACKUP_DELETE_FAILED');
  expect(fs.existsSync(target)).toBe(true);
  expect(ts.app.backups.listBackups().entries.find(e => e.id === entry.id)?.deleteError).toContain('删除失败');
  spy.mockRestore();
  expect((await ts.client.delete(`/api/backups/${entry.id}`)).status).toBe(200);
  expect(fs.existsSync(target)).toBe(false);
});

it('自动轮换删除失败保留记录和恢复入口，下次轮换可重试', async () => {
  const first = await ts.app.backups.createBackup('daily');
  const target = path.join(first.dirPath, first.fileName);
  const unlink = fs.unlinkSync;
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === target) throw new Error('无删除权限');
    return unlink(file);
  });
  for (let i = 0; i < 5; i++) await ts.app.backups.createBackup('daily');
  expect(ts.app.backups.listBackups().entries.filter(e => e.kind === 'daily')).toHaveLength(6);
  expect(ts.app.backups.getBackupFile(first.id).entry.deleteError).toContain('重试');
  expect((await ts.app.restores.validate(target)).preview.counts.orders).toBe(0);
  spy.mockRestore(); await ts.app.backups.createBackup('daily');
  expect(ts.app.backups.listBackups().entries.filter(e => e.kind === 'daily')).toHaveLength(5);
  expect(fs.existsSync(target)).toBe(false);
});
