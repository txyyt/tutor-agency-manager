// 调度器：每日02:00（Asia/Hong_Kong）自动备份+当日启动补做+失败5分钟重试；清理启动补做+每24小时。
// 只在系统运行时执行；不安装系统级定时任务；停机期间不执行、不假造历史快照。
import { hkDateString, hkPartsFromUtc } from '../../shared/datetime.js';
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
  private running = false;

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
    // 启动立即评估一次（补做当日备份、启动补清理）
    void this.tick(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(onStartup = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tickDailyBackup(onStartup);
      await this.tickCleanup(onStartup);
    } finally {
      this.running = false;
    }
  }

  /** 评估并执行当日备份规则（02:00后且当日未成功；失败5分钟重试）。公开供测试注入时钟后调用。 */
  async tickDailyBackup(onStartup = false): Promise<void> {
    const cfg = this.deps.runtime.load();
    const nowIso = this.deps.clock.iso();
    const hk = hkPartsFromUtc(nowIso);
    const today = hkDateString(nowIso);
    const pastTwoAm = hk.hour > 2 || (hk.hour === 2 && hk.minute >= 0);
    const doneToday = cfg.dailyBackup.lastSuccessDateHk === today;
    const lastAttempt = cfg.dailyBackup.lastAttemptAtUtc
      ? new Date(cfg.dailyBackup.lastAttemptAtUtc).getTime()
      : 0;
    const retryDue = this.deps.clock.now().getTime() - lastAttempt >= 5 * 60 * 1000;
    if ((onStartup || pastTwoAm || cfg.dailyBackup.lastError !== null) && !doneToday && retryDue) {
      await this.runDailyBackup(nowIso, today);
    }
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
    const hk = hkPartsFromUtc(nowIso);
    const today = hkDateString(nowIso);
    return {
      dailyBackup: {
        lastSuccessDateHk: cfg.dailyBackup.lastSuccessDateHk,
        lastSuccessAtUtc: cfg.dailyBackup.lastSuccessAtUtc,
        lastError: cfg.dailyBackup.lastError,
        lastAttemptAtUtc: cfg.dailyBackup.lastAttemptAtUtc,
        dueNow: (hk.hour > 2 || hk.hour === 2) && cfg.dailyBackup.lastSuccessDateHk !== today,
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
