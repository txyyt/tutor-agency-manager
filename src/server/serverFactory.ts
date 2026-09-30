// 服务工厂：装配全部组件（数据目录、锁、数据库、服务、Express应用）。
// main入口、集成测试、CLI共用同一装配，保证界面与命令行共享同一业务服务。
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import { type Env } from './env.js';
import { resolveDataPaths, ensureDirs, generationDir, type DataPaths } from './paths.js';
import { InstanceLock, MaintenanceMutex } from './locks.js';
import { RuntimeConfigStore } from './runtimeConfig.js';
import { ActiveData } from './activeData.js';
import { openDatabase, migrate, defaultMigrationDir, CURRENT_SCHEMA_VERSION } from './db.js';
import { Repository } from './repository.js';
import { Clock } from './clock.js';
import { OrderService } from './services/orderService.js';
import { ApplicationService } from './services/applicationService.js';
import { AttachmentService } from './services/attachmentService.js';
import { CleanupService } from './services/cleanupService.js';
import { BackupService } from './services/backupService.js';
import { RestoreService } from './services/restoreService.js';
import { Scheduler } from './services/schedulerService.js';
import { createApp } from './http/app.js';
import { conflict } from './errors.js';

export interface AppServer {
  env: Env;
  paths: DataPaths;
  clock: Clock;
  runtime: RuntimeConfigStore;
  active: ActiveData;
  repo: Repository;
  app: Express;
  instanceLock: InstanceLock;
  scheduler: Scheduler;
  orders: OrderService;
  applications: ApplicationService;
  attachments: AttachmentService;
  cleanup: CleanupService;
  backups: BackupService;
  restores: RestoreService;
  /** 完整启动：锁、数据库、调度器、恢复对账 */
  start(runScheduler?: boolean): { restoredOpsResolved: number; restoreNotes: string[] };
  stop(): void;
}

export function createServer(env: Env): AppServer {
  const paths = resolveDataPaths(env.dataDir);
  const clock = new Clock();
  const runtime = new RuntimeConfigStore(paths.runtimeJson);
  const maintenance = new MaintenanceMutex();
  const active = new ActiveData();
  const instanceLock = new InstanceLock(paths.instanceLock);
  const migrationDir = env.migrationDir || defaultMigrationDir();

  let repo: Repository;
  let orders: OrderService;
  let applications: ApplicationService;
  let attachments: AttachmentService;
  let cleanup: CleanupService;
  let backups: BackupService;
  let restores: RestoreService;
  let scheduler: Scheduler;

  function persistHighWater(): void {
    runtime.save();
  }

  function openGeneration(genId: string): void {
    const dir = generationDir(paths, genId);
    active.open(genId, dir);
    repo = new Repository(active.proxy);
     
    rebuildServices();
  }

  function rebuildServices(): void {
    orders = new OrderService({
      db: active.proxy,
      repo,
      clock,
      bumpHighWater: (table, id) => {
        const cfg = runtime.load();
        if (table === 'orders') cfg.numberHighWater.orders = Math.max(cfg.numberHighWater.orders, id);
        else cfg.numberHighWater.applications = Math.max(cfg.numberHighWater.applications, id);
        runtime.save();
      },
    });
    applications = new ApplicationService({
      db: active.proxy,
      repo,
      clock,
      bumpHighWater: (table, id) => {
        const cfg = runtime.load();
        if (table === 'orders') cfg.numberHighWater.orders = Math.max(cfg.numberHighWater.orders, id);
        else cfg.numberHighWater.applications = Math.max(cfg.numberHighWater.applications, id);
        runtime.save();
      },
    });
    attachments = new AttachmentService({ db: active.proxy, repo, clock, active });
    backups = new BackupService({
      db: active.proxy,
      repo,
      clock,
      runtime,
      paths,
      active,
      maintenance,
      appVersion: env.appVersion,
      migrationDir,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
    cleanup = new CleanupService({
      db: active.proxy,
      repo,
      clock,
      active,
      backup: backups,
      maintenance,
      onUpdate: () => {
        runtime.save();
      },
    });
    restores = new RestoreService({
      clock,
      runtime,
      paths,
      active,
      backup: backups,
      maintenance,
      migrationDir,
      appVersion: env.appVersion,
    });
    scheduler = new Scheduler({ clock, runtime, backup: backups, cleanup });
  }

  const server: AppServer = {
    env,
    paths,
    clock,
    runtime,
    active,
     
    repo: null as any,
    app: null as unknown as Express,
    instanceLock,
     
    scheduler: null as any,
     
    orders: null as any,
     
    applications: null as any,
     
    attachments: null as any,
     
    cleanup: null as any,
     
    backups: null as any,
     
    restores: null as any,
    start(runScheduler = true) {
      fs.mkdirSync(paths.dataDir, { recursive: true });
      instanceLock.acquire();
      ensureDirs(paths);
      // 恢复操作对账（进程中断后保证完整新代或完整原代）
      const generationReconciliation = reconcileGenerations(paths, runtime);
      // 打开活动数据代并迁移
      const cfg = runtime.load();
      if (!cfg.activeGenerationId) {
        const genId = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const dir = generationDir(paths, genId);
        fs.mkdirSync(dir, { recursive: true });
        fs.mkdirSync(path.join(dir, 'attachments'), { recursive: true });
        const db = openDatabase(path.join(dir, 'database.sqlite'));
        migrate(db, migrationDir);
        db.close();
        cfg.activeGenerationId = genId;
        runtime.save();
      }
      openGeneration(cfg.activeGenerationId);
      const openedDb = active.current();
      migrate(openedDb, migrationDir);
      // 启动清理未引用附件
      attachments.sweepUnreferenced();
      // 完成对象注入
      Object.assign(server, {
        repo,
        orders,
        applications,
        attachments,
        cleanup,
        backups,
        restores,
        scheduler,
      });
      // 恢复操作对账（进程中断后保证“完整新代或完整原代”）
      const reconciliation = { ...generationReconciliation, ...restores.reconcileOnStartup() };
      server.app = createApp({
        env,
        clock,
        runtime,
        paths,
        active,
        repo,
        orders,
        applications,
        attachments,
        cleanup,
        backups,
        restores,
        scheduler,
        onRecordChanged: persistHighWater,
        maintenance,
      });
      // 启动补做：当日备份 + 清理（CLI操作时可跳过）
      if (runScheduler) scheduler.start();
      return reconciliation;
    },
    stop() {
      scheduler?.stop();
      active.close();
      instanceLock.release();
    },
  };

  return server;
}

/** 旧代对账：runtime指向不存在的代时修复到最新完整代；返回恢复操作对账结果 */
function reconcileGenerations(paths: DataPaths, runtime: RuntimeConfigStore): { restoredOpsResolved: number; restoreNotes: string[] } {
  const notes: string[] = [];
  const restoredOpsResolved = 0;
  const cfg = runtime.load();
  if (cfg.activeGenerationId) {
    const dir = generationDir(paths, cfg.activeGenerationId);
    if (!fs.existsSync(dir)) {
      // 活动代目录丢失：选最新的完整代
      const gens = listCompleteGenerations(paths);
      if (gens.length === 0) {
        notes.push('活动数据代丢失且无历史代，将创建全新数据代');
        cfg.activeGenerationId = '';
        runtime.save();
      } else {
        const latest = gens[gens.length - 1]!;
        cfg.activeGenerationId = latest.genId;
        runtime.save();
        notes.push(`活动数据代丢失，已回退到最近的完整数据代 ${latest.genId}`);
      }
    }
  }
  return { restoredOpsResolved, restoreNotes: notes };
}

export function listCompleteGenerations(paths: DataPaths): Array<{ genId: string; dir: string }> {
  if (!fs.existsSync(paths.generationsDir)) return [];
  return fs
    .readdirSync(paths.generationsDir)
    .filter((name) => name.startsWith('gen-'))
    .map((genId) => ({ genId, dir: generationDir(paths, genId) }))
    .filter((g) => fs.existsSync(path.join(g.dir, 'database.sqlite')))
    .sort((a, b) => (a.genId < b.genId ? -1 : 1));
}

export { conflict };
