// 数据目录布局：
// data/runtime.json                活动代指针、data_epoch、编号高水位、备份设置、日备份调度元数据
// data/instance.lock               单实例运行锁（pid）
// data/generations/<genId>/database.sqlite + attachments/
// data/backups/{daily,manual,safety}/  备份包（均在活动代之外）
// data/staging/                    导入暂存、快照临时目录、上传临时目录（均在活动代之外）
// data/restore-ops/                恢复操作持久状态
import fs from 'node:fs';
import path from 'node:path';

export interface DataPaths {
  dataDir: string;
  runtimeJson: string;
  instanceLock: string;
  generationsDir: string;
  backupsRoot: string;
  dailyBackupsDir: string;
  manualBackupsDir: string;
  safetyBackupsDir: string;
  backupsIndex: string;
  stagingDir: string;
  restoreOpsDir: string;
}

export function resolveDataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    runtimeJson: path.join(dataDir, 'runtime.json'),
    instanceLock: path.join(dataDir, 'instance.lock'),
    generationsDir: path.join(dataDir, 'generations'),
    backupsRoot: path.join(dataDir, 'backups'),
    dailyBackupsDir: path.join(dataDir, 'backups', 'daily'),
    manualBackupsDir: path.join(dataDir, 'backups', 'manual'),
    safetyBackupsDir: path.join(dataDir, 'backups', 'safety'),
    backupsIndex: path.join(dataDir, 'backups', 'index.json'),
    stagingDir: path.join(dataDir, 'staging'),
    restoreOpsDir: path.join(dataDir, 'restore-ops'),
  };
}

export function ensureDirs(paths: DataPaths): void {
  for (const dir of [
    paths.dataDir,
    paths.generationsDir,
    paths.backupsRoot,
    paths.dailyBackupsDir,
    paths.manualBackupsDir,
    paths.safetyBackupsDir,
    paths.stagingDir,
    paths.restoreOpsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function generationDir(paths: DataPaths, genId: string): string {
  return path.join(paths.generationsDir, genId);
}

export function attachmentsDirOf(genDir: string): string {
  return path.join(genDir, 'attachments');
}

export function databaseFileOf(genDir: string): string {
  return path.join(genDir, 'database.sqlite');
}
