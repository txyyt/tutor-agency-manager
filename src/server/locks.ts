// 锁：数据目录单实例锁（跨进程）+ 维护锁（进程内互斥，禁止嵌套获取）。
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

/** 进程内维护锁：备份/恢复/清理/附件变更共用。重入即报错，避免恢复调备份、清理调备份时死锁。 */
export class MaintenanceMutex {
  private chain: Promise<unknown> = Promise.resolve();
  private heldFlag = false;

  get isHeld(): boolean {
    return this.heldFlag;
  }

  /** 最外层获取一次；内部步骤必须使用“假定已持锁”的内部方法，不得再次调用本方法。 */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.heldFlag) {
      return Promise.reject(
        new AppError(500, 'LOCK_REENTRY', '维护锁重入：内部步骤不得重复获取维护锁（程序缺陷）'),
      );
    }
    const result = this.chain.then(async () => {
      this.heldFlag = true;
      try {
        return await fn();
      } finally {
        this.heldFlag = false;
      }
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** 数据目录单实例锁：第二个服务进程启动时明确拒绝。 */
export class InstanceLock {
  private lockPath: string;
  private fd: number | null = null;

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  acquire(): void {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.fd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(this.fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        return;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'EEXIST') {
          if (this.tryBreakStaleLock()) continue;
          throw new AppError(
            409,
            'INSTANCE_ALREADY_RUNNING',
            '该数据目录已有一个服务进程在运行（单实例限制）。如确认没有运行中的服务，请删除 data/instance.lock 后重试。',
          );
        }
        throw err;
      }
    }
    throw new AppError(409, 'INSTANCE_ALREADY_RUNNING', '无法获取单实例锁');
  }

  /** 锁文件存在但持有进程已死亡时接管 */
  private tryBreakStaleLock(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8')) as { pid?: number };
      const pid = raw.pid;
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(pid, 0);
          return false; // 进程仍在运行
        } catch {
          // ESRCH：进程不存在 → 陈旧锁
        }
      }
    } catch {
      // 锁文件损坏，视为陈旧
    }
    try {
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }
}
