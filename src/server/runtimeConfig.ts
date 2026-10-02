// runtime.json：活动数据代指针、data_epoch、编号高水位、备份设置与调度元数据。
// 所有变更原子写入（临时文件+改名），不使用业务表。
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, type BackupSettings } from '../shared/types.js';

export interface RuntimeConfig {
  activeGenerationId: string;
  dataEpoch: number;
  numberHighWater: { orders: number; applications: number };
  orderDailyHighWater: Record<string, number>;
  backupSettings: BackupSettings;
  dailyBackup: {
    lastSuccessDateHk: string | null;
    lastSuccessAtUtc: string | null;
    lastError: string | null;
    lastAttemptAtUtc: string | null;
  };
  cleanupState: {
    lastRunAtUtc: string | null;
    lastResult: string | null;
  };
}

export class RuntimeConfigStore {
  private filePath: string;
  private cache: RuntimeConfig | null = null;

  constructor(runtimeJsonPath: string) {
    this.filePath = runtimeJsonPath;
  }

  load(): RuntimeConfig {
    if (this.cache) return this.cache;
    if (fs.existsSync(this.filePath)) {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<RuntimeConfig>;
      this.cache = {
        activeGenerationId: raw.activeGenerationId ?? '',
        dataEpoch: raw.dataEpoch ?? 1,
        numberHighWater: raw.numberHighWater ?? { orders: 0, applications: 0 },
        orderDailyHighWater: raw.orderDailyHighWater ?? {},
        backupSettings: {
          autoBackupDir: raw.backupSettings?.autoBackupDir ?? null,
          dailyKeepCount: raw.backupSettings?.dailyKeepCount ?? LIMITS.defaultDailyBackupsToKeep,
          dailyBackupTime: raw.backupSettings?.dailyBackupTime ?? '20:00',
          importMaxUploadBytes:
            raw.backupSettings?.importMaxUploadBytes ?? LIMITS.defaultImportMaxUploadBytes,
          importMaxTotalBytes:
            raw.backupSettings?.importMaxTotalBytes ?? LIMITS.defaultImportMaxTotalBytes,
          importMaxEntries: raw.backupSettings?.importMaxEntries ?? LIMITS.defaultImportMaxEntries,
        },
        dailyBackup: raw.dailyBackup ?? {
          lastSuccessDateHk: null,
          lastSuccessAtUtc: null,
          lastError: null,
          lastAttemptAtUtc: null,
        },
        cleanupState: raw.cleanupState ?? { lastRunAtUtc: null, lastResult: null },
      };
    } else {
      this.cache = {
        activeGenerationId: '',
        dataEpoch: 1,
        numberHighWater: { orders: 0, applications: 0 },
        orderDailyHighWater: {},
        backupSettings: {
          autoBackupDir: null,
          dailyKeepCount: LIMITS.defaultDailyBackupsToKeep,
          dailyBackupTime: '20:00',
          importMaxUploadBytes: LIMITS.defaultImportMaxUploadBytes,
          importMaxTotalBytes: LIMITS.defaultImportMaxTotalBytes,
          importMaxEntries: LIMITS.defaultImportMaxEntries,
        },
        dailyBackup: {
          lastSuccessDateHk: null,
          lastSuccessAtUtc: null,
          lastError: null,
          lastAttemptAtUtc: null,
        },
        cleanupState: { lastRunAtUtc: null, lastResult: null },
      };
    }
    return this.cache;
  }

  save(): void {
    if (!this.cache) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `runtime.json.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  mutate(fn: (cfg: RuntimeConfig) => void): void {
    const cfg = structuredClone(this.load());
    fn(cfg);
    this.replace(cfg);
  }

  /** 同步持久化失败时还原缓存，避免内存指针和磁盘指针分离。 */
  replace(cfg: RuntimeConfig): void {
    const previous = this.load();
    this.cache = structuredClone(cfg);
    try {
      this.save();
    } catch (err) {
      this.cache = previous;
      throw err;
    }
  }
}
