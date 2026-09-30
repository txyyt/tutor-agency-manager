// 每日备份调度规则单元测试：02:00触发、当日启动补做、不重复、失败5分钟重试、停机不假造历史包（AC44）。
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clock } from '../../src/server/clock.js';
import { RuntimeConfigStore } from '../../src/server/runtimeConfig.js';
import { Scheduler } from '../../src/server/services/schedulerService.js';

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-sched-'));
  const clock = new Clock();
  const runtime = new RuntimeConfigStore(path.join(dir, 'runtime.json'));
  runtime.load();
  runtime.save();
  const dailyCalls: string[] = [];
  const cleanupCalls: number[] = [];
  const scheduler = new Scheduler({
    clock,
    runtime,
    backup: {
      createBackup: async (kind: string) => {
        dailyCalls.push(kind);
        return { id: 'b1', fileName: 'x.zip', kind, dirPath: dir, createdAtUtc: clock.iso(), sizeBytes: 1, sha256: 'x' };
      },
    } as never,
    cleanup: {
      run: async () => {
        cleanupCalls.push(1);
        return { ran: false, deletedOrders: 0, deletedApplications: 0, deletedAttachments: 0, failedAttachmentDeletes: 0, backupId: null, skippedReason: '无', errors: [] };
      },
    } as never,
  });
  return { dir, clock, runtime, scheduler, dailyCalls, cleanupCalls };
}

describe('每日自动备份调度（可注入时钟）', () => {
  beforeEach(() => {
    fs.rmSync('/tmp/tam-sched-fake', { force: true, recursive: true });
  });

  it('01:59未到02:00不触发', async () => {
    const f = makeFixture();
    f.clock.setOffsetMs(Date.UTC(2026, 8, 30, 1, 59) - 8 * 3600_000 - Date.now());
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(0);
    f.scheduler.stop();
  });

  it('02:00触发一次；当天重复评估不重复生成', async () => {
    const f = makeFixture();
    f.clock.setOffsetMs(Date.UTC(2026, 8, 30, 2, 0) - 8 * 3600_000 - Date.now());
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    await f.scheduler.tickDailyBackup();
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    f.scheduler.stop();
  });

  it('当天首次启动补做（14:00启动、当日无备份 → 立即补做）', async () => {
    const f = makeFixture();
    f.clock.setOffsetMs(Date.UTC(2026, 8, 30, 14, 0) - 8 * 3600_000 - Date.now());
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    f.scheduler.stop();
  });

  it('当日已成功后重启不重复成功日包', async () => {
    const f = makeFixture();
    f.clock.setOffsetMs(Date.UTC(2026, 8, 30, 3, 0) - 8 * 3600_000 - Date.now());
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    f.clock.setOffsetMs(Date.UTC(2026, 8, 30, 22, 0) - 8 * 3600_000 - Date.now());
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    f.scheduler.stop();
  });

  it('失败后5分钟内不重试，超过5分钟重试（AC44）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-sched2-'));
    const clock = new Clock();
    clock.setOffsetMs(Date.UTC(2026, 8, 30, 2, 0) - 8 * 3600_000 - Date.now());
    const runtime = new RuntimeConfigStore(path.join(dir, 'runtime.json'));
    runtime.load();
    runtime.save();
    let attempts = 0;
    let failFirst = true;
    const scheduler = new Scheduler({
      clock,
      runtime,
      backup: {
        createBackup: async () => {
          attempts++;
          if (failFirst) throw new Error('模拟备份失败');
          return { id: 'b', fileName: 'x', kind: 'daily', dirPath: dir, createdAtUtc: clock.iso(), sizeBytes: 1, sha256: 'x' };
        },
      } as never,
      cleanup: { run: async () => ({}) } as never,
    });
    await scheduler.tickDailyBackup();
    expect(attempts).toBe(1);
    expect(runtime.load().dailyBackup.lastError).toContain('模拟备份失败');
    // 1分钟后：不重试
    clock.setOffsetMs(Date.UTC(2026, 8, 30, 2, 1) - 8 * 3600_000 - Date.now());
    await scheduler.tickDailyBackup();
    expect(attempts).toBe(1);
    // 5分钟后：重试成功
    failFirst = false;
    clock.setOffsetMs(Date.UTC(2026, 8, 30, 2, 5, 1) - 8 * 3600_000 - Date.now());
    await scheduler.tickDailyBackup();
    expect(attempts).toBe(2);
    expect(runtime.load().dailyBackup.lastError).toBeNull();
    expect(runtime.load().dailyBackup.lastSuccessDateHk).toBe('2026-09-30');
    scheduler.stop();
  });

  it('时区正确：UTC 18:00 = 香港02:00（次日）触发', async () => {
    const f = makeFixture();
    f.clock.setOffsetMs(Date.UTC(2026, 8, 29, 18, 0) - Date.now()); // 香港9/30 02:00
    await f.scheduler.tickDailyBackup();
    expect(f.dailyCalls).toHaveLength(1);
    expect(f.runtime.load().dailyBackup.lastSuccessDateHk).toBe('2026-09-30');
    f.scheduler.stop();
  });
});
