import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Clock } from '../../src/server/clock.js';
import { RuntimeConfigStore } from '../../src/server/runtimeConfig.js';
import { Scheduler } from '../../src/server/services/schedulerService.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tam-sched-'));
  const clock = new Clock();
  const runtime = new RuntimeConfigStore(path.join(dir, 'runtime.json'));
  const calls: string[] = [];
  let fail = false;
  const scheduler = new Scheduler({ clock, runtime,
    backup: { createBackup: async (kind: string) => { if (fail) throw new Error('模拟失败'); calls.push(kind); return { createdAtUtc: clock.iso() }; } } as never,
    cleanup: { run: async () => ({ skippedReason: '无' }) } as never,
  });
  const at = (time: string) => clock.setOffsetMs(Date.parse(time) - Date.now());
  return { runtime, scheduler, calls, at, dir, setFail: (value: boolean) => { fail = value; } };
}

describe('运行中定时备份与启停备份独立', () => {
  it('旧配置默认时间20:00，旧保留数升级为5，用户自定义时间保留', () => {
    const f = fixture(); f.runtime.load(); f.runtime.save();
    const file = path.join(f.dir, 'runtime.json'); const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.backupSettings.dailyBackupTime; raw.backupSettings.dailyKeepCount = 30;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    const reloaded = new RuntimeConfigStore(file); expect(reloaded.load().backupSettings.dailyBackupTime).toBe('20:00');
    expect(reloaded.load().backupSettings.dailyKeepCount).toBe(5);
    reloaded.mutate(c => { c.backupSettings.dailyBackupTime = '21:30'; });
    expect(new RuntimeConfigStore(file).load().backupSettings.dailyBackupTime).toBe('21:30');
  });
  it('上午启动和关闭分别备份，不占定时备份，20点只生成一次', async () => {
    const f = fixture(); f.at('2030-01-01T01:00:00Z'); await f.scheduler.tickDailyBackup();
    await f.scheduler.lifecycleBackup('startup'); await f.scheduler.lifecycleBackup('shutdown');
    expect(f.calls).toEqual(['startup', 'shutdown']); expect(f.runtime.load().dailyBackup.lastSuccessDateHk).toBeNull();
    f.at('2030-01-01T11:59:45Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toHaveLength(2);
    f.at('2030-01-01T12:00:15Z'); expect(f.scheduler.status().dailyBackup.dueNow).toBe(true);
    await f.scheduler.tickDailyBackup(); await f.scheduler.tickDailyBackup(); expect(f.calls).toEqual(['startup', 'shutdown', 'daily']);
    expect(f.runtime.load().dailyBackup.lastSuccessDateHk).toBe('2030-01-01');
  });
  it('设置21:30按新时间触发，旧默认20点不触发', async () => {
    const f = fixture(); f.runtime.mutate(c => { c.backupSettings.dailyBackupTime = '21:30'; });
    f.at('2030-01-01T11:59:00Z'); await f.scheduler.tickDailyBackup();
    f.at('2030-01-01T12:00:10Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toHaveLength(0);
    f.at('2030-01-01T13:30:10Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toEqual(['daily']);
  });
  it('晚于设置时间启动不补做，重启遗留错误不触发历史备份', async () => {
    const f = fixture(); f.runtime.mutate(c => { c.dailyBackup.lastError = '之前失败'; });
    f.at('2030-01-01T13:00:00Z'); await f.scheduler.tickDailyBackup(); await f.scheduler.lifecycleBackup('startup');
    expect(f.calls).toEqual(['startup']);
    f.at('2030-01-02T11:59:00Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toHaveLength(1);
    f.at('2030-01-02T12:00:10Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toEqual(['startup', 'daily']);
  });
  it('定时备份失败记录错误，不冒充成功或不断重试', async () => {
    const f = fixture(); f.at('2030-01-01T11:59:00Z'); await f.scheduler.tickDailyBackup(); f.setFail(true);
    f.at('2030-01-01T12:00:10Z'); await f.scheduler.tickDailyBackup();
    expect(f.runtime.load().dailyBackup.lastError).toContain('模拟失败'); expect(f.runtime.load().dailyBackup.lastSuccessDateHk).toBeNull();
    f.setFail(false); f.at('2030-01-01T12:05:10Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toHaveLength(0);
  });
  it('午夜时间设置正确跨日期触发', async () => {
    const f = fixture(); f.runtime.mutate(c => { c.backupSettings.dailyBackupTime = '00:00'; });
    f.at('2030-01-01T15:59:45Z'); await f.scheduler.tickDailyBackup();
    f.at('2030-01-01T16:00:15Z'); await f.scheduler.tickDailyBackup(); expect(f.calls).toEqual(['daily']);
    expect(f.runtime.load().dailyBackup.lastSuccessDateHk).toBe('2030-01-02');
  });
});
