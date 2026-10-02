import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, type TestServer } from '../helpers/testServer.js';
import { BackupMigration } from '../../src/server/services/backupMigration.js';

let server: TestServer;
let workspace: string;
let target: string;
beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-migration-'));
  target = path.join(workspace, 'new-backups');
  server = await startTestServer({ dataDir: path.join(workspace, 'data') });
});
afterEach(() => {
  vi.restoreAllMocks();
  server.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});
const change = () => server.client.patch('/api/backups/settings', { autoBackupDir: target, confirmMigration: true });

it('迁移后移除旧空分类目录，保留用户总目录及包含无关文件的分类', async () => {
  await server.app.backups.createBackup('manual');
  const root = server.app.paths.backupsRoot;
  for (const category of ['daily', 'lifecycle', 'safety']) fs.mkdirSync(path.join(root, category), { recursive: true });
  fs.writeFileSync(path.join(root, 'safety', '用户文件.txt'), '保留', 'utf8');
  expect((await change()).status).toBe(200);
  for (const category of ['manual', 'daily', 'lifecycle']) expect(fs.existsSync(path.join(root, category))).toBe(false);
  expect(fs.existsSync(root)).toBe(true);
  expect(fs.readFileSync(path.join(root, 'safety', '用户文件.txt'), 'utf8')).toBe('保留');
});

it('空分类目录占用时提示并保留重试记录，重试完成后移除', async () => {
  const entry = await server.app.backups.createBackup('manual');
  const remove = fs.rmdirSync;
  const spy = vi.spyOn(fs, 'rmdirSync').mockImplementation(directory => {
    if (String(directory) === entry.dirPath) throw Object.assign(new Error('模拟目录占用'), { code: 'EPERM' });
    remove(directory);
  });
  const result = await change();
  expect(result.status).toBe(200);
  expect(result.body.migrationResult.warnings).toHaveLength(1);
  expect(server.app.backups.listBackups().migration.pendingCleanupCount).toBe(1);
  expect(fs.readdirSync(entry.dirPath)).toEqual([]);
  spy.mockRestore();
  expect((await server.client.post('/api/backups/migration/retry-cleanup')).body.warnings).toEqual([]);
  expect(fs.existsSync(entry.dirPath)).toBe(false);
  expect(server.app.backups.listBackups().migration.pendingCleanupCount).toBe(0);
});

it('新备份目录位于旧分类目录内部时保留其父目录', async () => {
  expect((await change()).status).toBe(200);
  const entry = await server.app.backups.createBackup('manual');
  target = path.join(entry.dirPath, '新备份');
  expect((await change()).status).toBe(200);
  expect(fs.existsSync(entry.dirPath)).toBe(true);
  expect(fs.existsSync(server.app.backups.getBackupFile(entry.id).absolutePath)).toBe(true);
});

it('不清理旧分类目录中的目录链接及其指向的用户文件夹', async () => {
  await server.app.backups.createBackup('manual');
  const userFolder = path.join(workspace, '用户目录');
  fs.mkdirSync(userFolder);
  const link = path.join(server.app.paths.backupsRoot, 'daily');
  if (fs.existsSync(link)) fs.rmdirSync(link);
  fs.symlinkSync(userFolder, link, 'junction');
  expect((await change()).status).toBe(200);
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(userFolder)).toBe(true);
});

it('已不存在的历史文件不阻塞迁移，成功后清理失效记录并报告数量', async () => {
  const missing = await server.app.backups.createBackup('manual');
  const valid = await server.app.backups.createBackup('manual');
  fs.unlinkSync(path.join(missing.dirPath, missing.fileName));
  const result = await change();
  expect(result.status).toBe(200);
  expect(result.body.migrationResult.skippedMissingCount).toBe(1);
  expect(result.body.migrationResult.migratedCount).toBe(1);
  expect(server.app.backups.readIndex().map(e => e.id)).toEqual([valid.id]);
  expect((await server.app.restores.validate(server.app.backups.getBackupFile(valid.id).absolutePath)).preview.counts.orders).toBe(0);
});

it('存在但损坏的原备份仍拒绝迁移，返回具体原因而非泛化内部错误', async () => {
  const entry = await server.app.backups.createBackup('manual');
  fs.appendFileSync(path.join(entry.dirPath, entry.fileName), '损坏');
  const result = await change();
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('BACKUP_SETTINGS_FAILED');
  expect(result.body.message).toContain(entry.fileName);
  expect(result.body.message).toContain('校验失败');
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBeNull();
  expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(true);
});

it('迁移所有分类与分散目录的备份，保留无关文件，清空设置也迁移回来', async () => {
  const entries = [];
  for (const kind of ['daily', 'manual', 'startup', 'shutdown', 'pre-cleanup', 'pre-restore', 'pre-delete'] as const) entries.push(await server.app.backups.createBackup(kind));
  const scattered = path.join(workspace, 'earlier-location');
  fs.mkdirSync(scattered);
  const manual = entries.find(e => e.kind === 'manual')!;
  fs.renameSync(path.join(manual.dirPath, manual.fileName), path.join(scattered, manual.fileName));
  manual.dirPath = scattered;
  fs.writeFileSync(server.app.paths.backupsIndex, JSON.stringify(entries), 'utf8');
  fs.writeFileSync(path.join(scattered, '用户文档.txt'), '不移动', 'utf8');
  const unchanged = await server.client.patch('/api/backups/settings', { autoBackupDir: target });
  expect(unchanged.status).toBe(409);
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBeNull();
  const result = await change();
  expect(result.status).toBe(200);
  expect(result.body.migrationResult.migratedCount).toBe(7);
  for (const entry of entries) {
    expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(false);
    const file = server.app.backups.getBackupFile(entry.id);
    expect(file.entry.dirPath.startsWith(target + path.sep)).toBe(true);
    expect((await server.app.restores.validate(file.absolutePath)).preview.counts.orders).toBe(0);
  }
  expect(fs.readFileSync(path.join(scattered, '用户文档.txt'), 'utf8')).toBe('不移动');
  expect((await server.client.patch('/api/backups/settings', { autoBackupDir: null, confirmMigration: true })).status).toBe(200);
  expect(server.app.backups.listBackups().entries.every(e => e.dirPath.startsWith(server.app.paths.backupsRoot + path.sep))).toBe(true);
  expect(fs.existsSync(path.join(server.dataDir, 'backup-migration.json'))).toBe(false);
});

it('同名异内容文件拒绝覆盖，原目录和配置不变', async () => {
  const entry = await server.app.backups.createBackup('manual');
  fs.mkdirSync(path.join(target, 'manual'), { recursive: true });
  const collision = path.join(target, 'manual', entry.fileName);
  fs.writeFileSync(collision, '用户文件', 'utf8');
  expect((await change()).status).toBe(409);
  expect(fs.readFileSync(collision, 'utf8')).toBe('用户文件');
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBeNull();
  expect(fs.existsSync(server.app.backups.getBackupFile(entry.id).absolutePath)).toBe(true);
});

it('复制损坏时校验拒绝切换，原文件完整，之后可重试', async () => {
  const entry = await server.app.backups.createBackup('manual');
  const original = fs.readFileSync(path.join(entry.dirPath, entry.fileName));
  const copy = fs.copyFileSync;
  const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
    copy(source, destination, flags);
    if (String(destination).includes('.migration-')) fs.appendFileSync(destination, '损坏');
  });
  expect((await change()).status).toBe(409);
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBeNull();
  expect(fs.readFileSync(path.join(entry.dirPath, entry.fileName))).toEqual(original);
  expect(server.app.backups.getBackupFile(entry.id).entry.dirPath).toBe(entry.dirPath);
  spy.mockRestore();
  expect((await change()).status).toBe(200);
});

it('配置提交失败回滚索引和全部设置，保留原备份', async () => {
  const entry = await server.app.backups.createBackup('manual');
  const settings = structuredClone(server.app.runtime.load().backupSettings);
  vi.spyOn(server.app.runtime, 'replace').mockImplementationOnce(() => { throw new Error('模拟保存配置失败'); });
  expect((await server.client.patch('/api/backups/settings', { autoBackupDir: target, dailyBackupTime: '21:30', confirmMigration: true })).status).toBe(409);
  expect(server.app.runtime.load().backupSettings).toEqual(settings);
  expect(server.app.backups.getBackupFile(entry.id).entry.dirPath).toBe(entry.dirPath);
  expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(true);
});

it('不支持硬链接的磁盘使用完整临时文件改名，迁移后可恢复', async () => {
  const entry = await server.app.backups.createBackup('manual');
  vi.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('不支持硬链接'), { code: 'ENOTSUP' }); });
  expect((await change()).status).toBe(200);
  expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(false);
  expect((await server.app.restores.validate(server.app.backups.getBackupFile(entry.id).absolutePath)).preview.counts.orders).toBe(0);
});

it('旧文件占用时保留新目录可用，重试清理只删除旧副本', async () => {
  const entry = await server.app.backups.createBackup('manual');
  const oldFile = path.join(entry.dirPath, entry.fileName);
  const unlink = fs.unlinkSync;
  const spy = vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === oldFile) throw new Error('模拟文件占用');
    unlink(file);
  });
  const result = await change();
  expect(result.status).toBe(200);
  expect(result.body.migrationResult.warnings).toHaveLength(1);
  expect(server.app.backups.listBackups().migration.pendingCleanupCount).toBe(1);
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBe(target);
  expect((await server.app.restores.validate(server.app.backups.getBackupFile(entry.id).absolutePath)).preview.counts.orders).toBe(0);
  spy.mockRestore();
  expect((await server.client.post('/api/backups/migration/retry-cleanup')).body.warnings).toEqual([]);
  expect(fs.existsSync(oldFile)).toBe(false);
  expect(server.app.backups.listBackups().migration.pendingCleanupCount).toBe(0);
});

it('提交后的中断启动继续清理，保留新目录与恢复入口', async () => {
  const entry = await server.app.backups.createBackup('manual');
  const oldFile = path.join(entry.dirPath, entry.fileName);
  const unlink = fs.unlinkSync;
  vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
    if (String(file) === oldFile) throw new Error('模拟删除中断');
    unlink(file);
  });
  expect((await change()).status).toBe(200);
  vi.restoreAllMocks();
  server.close();
  server = await startTestServer({ dataDir: path.join(workspace, 'data') });
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBe(target);
  expect(fs.existsSync(oldFile)).toBe(false);
  expect(server.app.backups.listBackups().migration.pendingCleanupCount).toBe(0);
  expect((await server.client.post('/api/restores/validate-existing', { backupId: entry.id })).status).toBe(200);
});

it('提交前中断启动回滚目录和索引，原文件可恢复', async () => {
  const entry = await server.app.backups.createBackup('manual');
  // 在索引改写之后的配置提交处中断，并跳过本次回滚，模拟直接终止进程。
  vi.spyOn(server.app.runtime, 'replace').mockImplementationOnce(() => { throw new Error('模拟中断'); });
  const reconcile = BackupMigration.prototype.reconcile;
  let calls = 0;
  vi.spyOn(BackupMigration.prototype, 'reconcile').mockImplementation(function (this: BackupMigration) {
    if (++calls === 2) throw new Error('进程已结束，等待下次启动');
    return reconcile.call(this);
  });
  expect((await change()).status).toBe(409);
  expect(fs.existsSync(path.join(server.dataDir, 'backup-migration.json'))).toBe(true);
  vi.restoreAllMocks();
  server.close();
  server = await startTestServer({ dataDir: path.join(workspace, 'data') });
  expect(server.app.runtime.load().backupSettings.autoBackupDir).toBeNull();
  expect(server.app.backups.getBackupFile(entry.id).entry.dirPath).toBe(entry.dirPath);
  expect((await server.client.post('/api/restores/validate-existing', { backupId: entry.id })).status).toBe(200);
  expect(fs.existsSync(path.join(server.dataDir, 'backup-migration.json'))).toBe(false);
});

it('手动5份、安全所有类型合计5份独立轮换', async () => {
  const manual = [];
  const safety = [];
  const kinds = ['pre-delete', 'pre-cleanup', 'pre-restore'] as const;
  for (let i = 0; i < 8; i++) {
    manual.push(await server.app.backups.createBackup('manual'));
    safety.push(await server.app.backups.createBackup(kinds[i % 3]!));
  }
  const list = server.app.backups.listBackups().entries;
  expect(list.filter(e => e.kind === 'manual').map(e => e.id)).toEqual(manual.slice(-5).map(e => e.id));
  expect(list.filter(e => e.kind.startsWith('pre-')).map(e => e.id)).toEqual(safety.slice(-5).map(e => e.id));
  for (const entry of [...manual.slice(0, 3), ...safety.slice(0, 3)]) expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(false);
});

it('升级启动时把旧版本超过5份的手动和安全备份轮换为最新5份', async () => {
  const legacy = [];
  for (let i = 0; i < 7; i++) {
    for (const kind of ['manual', 'pre-cleanup'] as const) {
      const entry = await server.app.backups.createBackup(kind);
      legacy.push({ entry, bytes: fs.readFileSync(path.join(entry.dirPath, entry.fileName)) });
    }
  }
  // 重建旧版本保留的全部真实备份包与索引。
  for (const { entry, bytes } of legacy) fs.writeFileSync(path.join(entry.dirPath, entry.fileName), bytes);
  fs.writeFileSync(server.app.paths.backupsIndex, JSON.stringify(legacy.map(item => item.entry)), 'utf8');
  server.close();
  server = await startTestServer({ dataDir: path.join(workspace, 'data') });
  const list = server.app.backups.listBackups().entries;
  for (const kind of ['manual', 'pre-cleanup']) {
    const original = legacy.filter(item => item.entry.kind === kind);
    expect(list.filter(e => e.kind === kind).map(e => e.id)).toEqual(original.slice(-5).map(item => item.entry.id));
    for (const { entry } of original.slice(0, 2)) expect(fs.existsSync(path.join(entry.dirPath, entry.fileName))).toBe(false);
  }
});
