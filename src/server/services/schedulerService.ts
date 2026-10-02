// 调度器：运行中到达设置时间才备份，错过不补做；启动/关闭备份单独保存。清理启动执行+每24小时。
// 只在系统运行时执行；不安装系统级定时任务；停机期间不执行、不假造历史快照。
import { hkDateString } from '../../shared/datetime.js';
import type { Clock } from '../clock.js';
import type { RuntimeConfigStore } from '../runtimeConfig.js';
import type { BackupService } from './backupService.js';
import type { CleanupService } from './cleanupService.js';

export interface SchedulerStatus {
  dailyBackup: {
    lastSuccessDateHk: string | null;
    lastSuccessAtUtc: string | null;
    lastError: string | null;
    lastAttemptAtUtc: string | null;
    dueNow: boolean;
  };
  cleanup: {
    lastRunAtUtc: string | null;
    lastResult: string | null;
    intervalMs: number;
  };
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastCleanupAtMs: number | null = null;
  private currentTask: Promise<void> | null = null;
  private lastScheduledCheckMs: number | null = null;

  constructor(
    private deps: {
      clock: Clock;
      runtime: RuntimeConfigStore;
      backup: BackupService;
      cleanup: CleanupService;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    // 初次评估只检查当前时间，不补做错过的定时备份；启动清理。
    void this.tick(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async idle(): Promise<void> { await this.currentTask; }

  async lifecycleBackup(kind: 'startup' | 'shutdown'): Promise<void> {
    await this.idle();
    await this.deps.backup.createBackup(kind);
  }

  private tick(onStartup = false): Promise<void> {
    if (this.currentTask) return this.currentTask;
    this.currentTask = (async () => {
      await this.tickDailyBackup();
      await this.tickCleanup(onStartup);
    })().finally(() => { this.currentTask = null; });
    return this.currentTask;
  }

  private scheduledTimeMs(nowIso: string): number {
    return Date.parse(`${hkDateString(nowIso)}T${this.deps.runtime.load().backupSettings.dailyBackupTime}:00+08:00`);
  }

  private isDue(nowIso: string): boolean {
    const now = Date.parse(nowIso);
    const scheduled = this.scheduledTimeMs(nowIso);
    const crossed = this.lastScheduledCheckMs === null
      ? now >= scheduled && now < scheduled + 60_000
      : this.lastScheduledCheckMs < scheduled && now >= scheduled;
    return crossed && this.deps.runtime.load().dailyBackup.lastSuccessDateHk !== hkDateString(nowIso);
  }

  /** 仅在运行中跨过设置时间时触发；启动太晚不补做。日期仅用于防止同一时点重复生成。 */
  async tickDailyBackup(): Promise<void> {
    const nowIso = this.deps.clock.iso();
    const due = this.isDue(nowIso);
    this.lastScheduledCheckMs = Date.parse(nowIso);
    if (due) await this.runDailyBackup(nowIso, hkDateString(nowIso));
  }

  async runDailyBackup(nowIso: string, today: string): Promise<void> {
    this.deps.runtime.mutate((c) => {
      c.dailyBackup.lastAttemptAtUtc = nowIso;
    });
    try {
      const entry = await this.deps.backup.createBackup('daily');
      this.deps.runtime.mutate((c) => {
        c.dailyBackup.lastSuccessDateHk = today;
        c.dailyBackup.lastSuccessAtUtc = entry.createdAtUtc;
        c.dailyBackup.lastError = null;
      });
    } catch (err) {
      this.deps.runtime.mutate((c) => {
        c.dailyBackup.lastError = (err as Error).message;
      });
    }
  }

  private async tickCleanup(onStartup: boolean): Promise<void> {
    const nowMs = Date.now();
    const interval = 24 * 60 * 60 * 1000;
    const due = this.lastCleanupAtMs === null || nowMs - this.lastCleanupAtMs >= interval;
    if (!due) return;
    if (!onStartup && this.lastCleanupAtMs === null) {
      // 非启动路径第一次tick视为启动初始化，不重复触发
    }
    this.lastCleanupAtMs = nowMs;
    try {
      const result = await this.deps.cleanup.run();
      this.deps.runtime.mutate((c) => {
        c.cleanupState.lastRunAtUtc = this.deps.clock.iso();
        c.cleanupState.lastResult = result.skippedReason
          ? result.skippedReason
          : `删除${result.deletedOrders}单/${result.deletedApplications}报名，附件${result.deletedAttachments}个${result.failedAttachmentDeletes ? `，失败${result.failedAttachmentDeletes}个待重试` : ''}`;
      });
    } catch (err) {
      this.deps.runtime.mutate((c) => {
        c.cleanupState.lastRunAtUtc = this.deps.clock.iso();
        c.cleanupState.lastResult = `清理执行失败：${(err as Error).message}`;
      });
    }
  }

  status(): SchedulerStatus {
    const cfg = this.deps.runtime.load();
    const nowIso = this.deps.clock.iso();
    return {
      dailyBackup: {
        lastSuccessDateHk: cfg.dailyBackup.lastSuccessDateHk,
        lastSuccessAtUtc: cfg.dailyBackup.lastSuccessAtUtc,
        lastError: cfg.dailyBackup.lastError,
        lastAttemptAtUtc: cfg.dailyBackup.lastAttemptAtUtc,
        dueNow: this.isDue(nowIso),
      },
      cleanup: {
        lastRunAtUtc: cfg.cleanupState.lastRunAtUtc,
        lastResult: cfg.cleanupState.lastResult,
        intervalMs: 24 * 60 * 60 * 1000,
      },
    };
  }

  /** 测试辅助：立即触发一次完整tick */
  async triggerNow(): Promise<void> {
    await this.tick(true);
  }
}
