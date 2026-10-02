// 备份：锁内一致性快照（VACUUM INTO）+ 附件复制 → 打包ZIP → 校验 → 原子改名 → 登记 → 轮换。
// 公共入口获取维护锁；恢复/清理等已持锁场景调用 performBackupLocked（内部方法，不重复加锁）。
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { LIMITS, type BackupIndexEntry, type BackupKind, type BackupManifest } from '../../shared/types.js';
import { hkCompactDateString } from '../../shared/datetime.js';
import { badRequest } from '../errors.js';
import { mergeDailyHighWater, orderDailyHighWater } from '../orderNumbers.js';
import type { Clock } from '../clock.js';
import type { RuntimeConfigStore } from '../runtimeConfig.js';
import type { DataPaths } from '../paths.js';
import type { ActiveData } from '../activeData.js';
import type { Repository } from '../repository.js';
import type { MaintenanceMutex } from '../locks.js';

const KIND_TAGS: Record<BackupKind, string> = {
  daily: 'daily',
  manual: 'manual',
  'pre-restore': 'safety-prerestore',
  'pre-cleanup': 'safety-precleanup',
  'pre-delete': 'safety-predelete',
};

function kindDir(paths: DataPaths, settingsAutoDir: string | null, kind: BackupKind): string {
  if (kind === 'daily' && settingsAutoDir) return settingsAutoDir;
  if (kind === 'daily') return paths.dailyBackupsDir;
  if (kind === 'manual') return paths.manualBackupsDir;
  return paths.safetyBackupsDir;
}

function sha256File(file: string): { hash: string; size: number } {
  const buf = fs.readFileSync(file);
  return { hash: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

export class BackupService {
  constructor(
    private deps: {
      db: DatabaseSync;
      repo: Repository;
      clock: Clock;
      runtime: RuntimeConfigStore;
      paths: DataPaths;
      active: ActiveData;
      maintenance: MaintenanceMutex;
      appVersion: string;
      migrationDir: string;
      schemaVersion: number;
    },
  ) {}

  listBackups(): {
    entries: BackupIndexEntry[];
    settings: ReturnType<RuntimeConfigStore['load']>['backupSettings'];
    daily: { lastSuccessDateHk: string | null; lastSuccessAtUtc: string | null; lastError: string | null };
    paths: { dailyDir: string; safetyDir: string; manualDir: string };
  } {
    const cfg = this.deps.runtime.load();
    const index = this.readIndex();
    const entries = index.filter((e) => fs.existsSync(path.join(e.dirPath, e.fileName)));
    return {
      entries,
      settings: cfg.backupSettings,
      daily: {
        lastSuccessDateHk: cfg.dailyBackup.lastSuccessDateHk,
        lastSuccessAtUtc: cfg.dailyBackup.lastSuccessAtUtc,
        lastError: cfg.dailyBackup.lastError,
      },
      paths: {
        dailyDir: cfg.backupSettings.autoBackupDir ?? this.deps.paths.dailyBackupsDir,
        safetyDir: this.deps.paths.safetyBackupsDir,
        manualDir: this.deps.paths.manualBackupsDir,
      },
    };
  }

  getBackupFile(id: string): { entry: BackupIndexEntry; absolutePath: string } {
    const entry = this.readIndex().find((e) => e.id === id);
    if (!entry) throw badRequest('BACKUP_NOT_FOUND', '备份不存在或未登记');
    const abs = path.join(entry.dirPath, entry.fileName);
    if (!fs.existsSync(abs)) throw badRequest('BACKUP_FILE_MISSING', '备份文件已被移动或删除');
    return { entry, absolutePath: abs };
  }

  readIndex(): BackupIndexEntry[] {
    const file = this.deps.paths.backupsIndex;
    if (!fs.existsSync(file)) return [];
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf-8')) as BackupIndexEntry[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private writeIndex(entries: BackupIndexEntry[]): void {
    const file = this.deps.paths.backupsIndex;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  /** 公共入口：手动/每日备份（自取维护锁） */
  async createBackup(kind: BackupKind): Promise<BackupIndexEntry> {
    return this.deps.maintenance.runExclusive(() => this.performBackupLocked(kind));
  }

  /** 内部方法：假定维护锁已持有（供恢复前/清理前备份调用，不重复加锁） */
  async performBackupLocked(kind: BackupKind): Promise<BackupIndexEntry> {
    const cfg = this.deps.runtime.load();
    const nowIso = this.deps.clock.iso();
    const stamp = `${hkCompactDateString(nowIso)}-${new Date(nowIso).toISOString().slice(11, 19).replace(/:/g, '')}`;
    const uniq = crypto.randomBytes(3).toString('hex');
    const finalName = `tutor-backup-${KIND_TAGS[kind]}-${stamp}-${uniq}.zip`;
    const targetDir = kindDir(this.deps.paths, cfg.backupSettings.autoBackupDir, kind);
    fs.mkdirSync(targetDir, { recursive: true });

    // 1) 锁内快照：数据库 + 全部仍被引用附件 → 独立快照目录
    const staging = this.deps.paths.stagingDir;
    fs.mkdirSync(staging, { recursive: true });
    const snapshotDir = path.join(staging, `snapshot-${uniq}`);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const dbSnapshot = path.join(snapshotDir, 'database.sqlite');
    try {
      const escapedPath = dbSnapshot.replace(/'/g, "''");
      this.deps.db.exec(`VACUUM INTO '${escapedPath}'`);
      // 附件：从活动代附件目录复制（锁内，防并发删除导致缺文件）
      const attachmentsSource = this.deps.active.attachmentsDir;
      const attachmentsTarget = path.join(snapshotDir, 'attachments');
      fs.mkdirSync(attachmentsTarget, { recursive: true });
      if (fs.existsSync(attachmentsSource)) {
        for (const name of fs.readdirSync(attachmentsSource)) {
          const src = path.join(attachmentsSource, name);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(attachmentsTarget, name));
        }
      }

      // 2) manifest
      const files: BackupManifest['files'] = [];
      for (const rel of ['database.sqlite', ...fs.readdirSync(attachmentsTarget).map((n) => `attachments/${n}`)]) {
        const abs = path.join(snapshotDir, rel);
        const { hash, size } = sha256File(abs);
        files.push({ path: rel, sha256: hash, size });
      }
      const manifest: BackupManifest = {
        formatVersion: LIMITS.backupFormatVersion,
        schemaVersion: this.deps.schemaVersion,
        appVersion: this.deps.appVersion,
        kind,
        createdAtUtc: nowIso,
        displayTimezone: 'Asia/Hong_Kong',
        counts: {
          orders: this.deps.repo.countOrders(),
          applications: this.deps.repo.countApplications(),
          attachments: fs.readdirSync(attachmentsTarget).length,
        },
        numberHighWater: { ...this.deps.runtime.load().numberHighWater },
        orderDailyHighWater: mergeDailyHighWater(this.deps.runtime.load().orderDailyHighWater, orderDailyHighWater(this.deps.db)),
        files,
      };
      fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

      // 3) 打包到临时文件
      const zip = new JSZip();
      for (const rel of ['manifest.json', 'database.sqlite', ...manifest.files.filter((f) => f.path.startsWith('attachments/')).map((f) => f.path)]) {
        zip.file(rel, fs.readFileSync(path.join(snapshotDir, rel)));
      }
      const tmpZip = path.join(staging, `tmp-backup-${uniq}.zip`);
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      fs.writeFileSync(tmpZip, buffer);

      // 4) 完整性校验（重新打开包核对清单与哈希）
      const check = await JSZip.loadAsync(buffer);
      for (const f of manifest.files) {
        const entry = check.file(f.path);
        if (!entry) throw new Error(`备份校验失败：缺少${f.path}`);
        const data = await entry.async('nodebuffer');
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        if (hash !== f.sha256) throw new Error(`备份校验失败：${f.path} 哈希不符`);
      }
      const manifestEntry = check.file('manifest.json');
      if (!manifestEntry) throw new Error('备份校验失败：缺少manifest.json');

      // 5) 原子改名落盘
      const finalPath = path.join(targetDir, finalName);
      try {
        fs.renameSync(tmpZip, finalPath);
      } catch {
        // 跨盘：复制+删除
        fs.copyFileSync(tmpZip, finalPath);
        fs.unlinkSync(tmpZip);
      }
      const { hash, size } = sha256File(finalPath);
      const entry: BackupIndexEntry = {
        id: crypto.randomUUID(),
        fileName: finalName,
        kind,
        dirPath: targetDir,
        createdAtUtc: nowIso,
        sizeBytes: size,
        sha256: hash,
      };
      const index = this.readIndex();
      index.push(entry);
      this.writeIndex(index);

      // 6) 轮换（仅在已有本次验证成功的新备份后执行）
      this.rotate(kind, cfg.backupSettings.dailyKeepCount);

      return entry;
    } finally {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  }

  /** 轮换：日备份保留N份；安全备份最多10份且≤30天；手动备份最近10份。只轮换登记在册的包。 */
  rotate(kind: BackupKind, dailyKeepCount: number): void {
    const index = this.readIndex();
    const now = this.deps.clock.iso();
    let toDelete: BackupIndexEntry[] = [];
    if (kind === 'daily') {
      const dailies = index
        .filter((e) => e.kind === 'daily')
        .sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1));
      toDelete = dailies.slice(Math.max(dailyKeepCount, 1));
    } else if (kind === 'manual') {
      toDelete = index.filter(e => e.kind === 'manual').sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc)).slice(LIMITS.maxManualBackups);
    } else if (kind === 'pre-restore' || kind === 'pre-cleanup' || kind === 'pre-delete') {
      const safes = index
        .filter((e) => e.kind === 'pre-restore' || e.kind === 'pre-cleanup' || e.kind === 'pre-delete')
        .sort((a, b) => (a.createdAtUtc < b.createdAtUtc ? 1 : -1));
      const ageCutoff = new Date(new Date(now).getTime() - LIMITS.safetyBackupMaxAgeDays * 24 * 3600 * 1000).toISOString();
      const byAge = safes.filter((e) => e.createdAtUtc < ageCutoff);
      const byCount = safes.slice(LIMITS.maxSafetyBackups);
      toDelete = [...new Set([...byAge, ...byCount])];
    }
    if (toDelete.length === 0) return;
    const deleteIds = new Set(toDelete.map((e) => e.id));
    for (const e of toDelete) {
      try {
        const abs = path.join(e.dirPath, e.fileName);
        if (fs.existsSync(abs)) fs.unlinkSync(abs);
      } catch {
        /* 单个删除失败不影响其余；下次轮换重试 */
      }
    }
    this.writeIndex(index.filter((e) => !deleteIds.has(e.id)));
  }

  deleteBackup(id: string): void {
    const index = this.readIndex();
    const entry = index.find((e) => e.id === id);
    if (!entry) throw badRequest('BACKUP_NOT_FOUND', '备份不存在');
    try {
      const abs = path.join(entry.dirPath, entry.fileName);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
    this.writeIndex(index.filter((e) => e.id !== id));
  }

  /** 备份目录设置校验：不能与活动数据代/附件/暂存互为祖先或子目录；不允许根目录/目录链接 */
  validateAutoBackupDir(dir: string): void {
    const resolved = path.resolve(dir);
    const root = path.parse(resolved).root;
    if (resolved === root) throw badRequest('INVALID_BACKUP_DIR', '自动备份目录不能是根目录');
    if (fs.existsSync(resolved)) {
      const st = fs.lstatSync(resolved);
      if (st.isSymbolicLink()) throw badRequest('INVALID_BACKUP_DIR', '自动备份目录不能是目录链接');
      if (!st.isDirectory()) throw badRequest('INVALID_BACKUP_DIR', '自动备份目录必须是文件夹');
    }
    const protectedPaths = [
      this.deps.paths.dataDir,
      this.deps.paths.generationsDir,
      this.deps.paths.stagingDir,
      this.deps.active.genDir,
    ].filter(Boolean);
    for (const p of protectedPaths) {
      const rp = path.resolve(p);
      if (resolved === rp || resolved.startsWith(rp + path.sep) || rp.startsWith(resolved + path.sep)) {
        throw badRequest(
          'INVALID_BACKUP_DIR',
          `自动备份目录不能与数据目录、活动数据代、附件或导入暂存目录重合或互为父子：${rp}`,
        );
      }
    }
  }

  updateSettings(patch: { dailyKeepCount?: number; dailyBackupTime?: string; autoBackupDir?: string | null }): { ok: true } {
    if (patch.dailyBackupTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.dailyBackupTime)) {
      throw badRequest('INVALID_SETTING', '每日备份时间须为HH:mm（00:00—23:59）');
    }
    const cfg = this.deps.runtime.load();
    if (patch.dailyBackupTime !== undefined) cfg.backupSettings.dailyBackupTime = patch.dailyBackupTime;
    if (patch.dailyKeepCount !== undefined) {
      if (!Number.isInteger(patch.dailyKeepCount) || patch.dailyKeepCount < 1) {
        throw badRequest('INVALID_SETTING', '日备份保留份数必须是正整数');
      }
      cfg.backupSettings.dailyKeepCount = patch.dailyKeepCount;
    }
    if (patch.autoBackupDir !== undefined) {
      if (patch.autoBackupDir === null || patch.autoBackupDir === '') {
        cfg.backupSettings.autoBackupDir = null;
      } else {
        this.validateAutoBackupDir(patch.autoBackupDir);
        fs.mkdirSync(patch.autoBackupDir, { recursive: true });
        cfg.backupSettings.autoBackupDir = path.resolve(patch.autoBackupDir);
      }
    }
    this.deps.runtime.save();
    return { ok: true };
  }

  /** 上传大小限制（导入用）更新 */
  updateImportLimits(patch: { importMaxUploadBytes?: number; importMaxTotalBytes?: number; importMaxEntries?: number }): void {
    const cfg = this.deps.runtime.load();
    const s = cfg.backupSettings;
    if (patch.importMaxUploadBytes !== undefined) {
      if (!Number.isInteger(patch.importMaxUploadBytes) || patch.importMaxUploadBytes < 1024 * 1024) {
        throw badRequest('INVALID_SETTING', '导入上传上限至少1MB');
      }
      s.importMaxUploadBytes = patch.importMaxUploadBytes;
    }
    if (patch.importMaxTotalBytes !== undefined) {
      if (!Number.isInteger(patch.importMaxTotalBytes) || patch.importMaxTotalBytes < 1024 * 1024) {
        throw badRequest('INVALID_SETTING', '导入解压总量上限至少1MB');
      }
      s.importMaxTotalBytes = patch.importMaxTotalBytes;
    }
    if (patch.importMaxEntries !== undefined) {
      if (!Number.isInteger(patch.importMaxEntries) || patch.importMaxEntries < 100) {
        throw badRequest('INVALID_SETTING', '导入条目数量上限至少100');
      }
      s.importMaxEntries = patch.importMaxEntries;
    }
    this.deps.runtime.save();
  }
}
