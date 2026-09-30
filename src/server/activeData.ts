// 活动数据代：稳定代理引用 + 可切换的真实连接（恢复时原子切换，旧请求不混读两代）。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { maintenanceUnavailable } from './errors.js';
import { openDatabase } from './db.js';

export class ActiveData {
  private real: DatabaseSync | null = null;
  private genId = '';
  private genDirPath = '';

  /** 稳定的代理对象：服务层永远持有它，恢复切换后自动指向新连接。 */
  readonly proxy: DatabaseSync;

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.proxy = new Proxy({} as DatabaseSync, {
      get(_target, prop) {
        const db = self.current();
         
        const value = Reflect.get(db as unknown as object, prop, db) as any;
        return typeof value === 'function' ? value.bind(db) : value;
      },
      has(_target, prop) {
        return prop in (self.current() as unknown as object);
      },
      getPrototypeOf() {
        return DatabaseSync.prototype;
      },
    });
  }

  open(genId: string, genDir: string): void {
    this.close();
    this.real = openDatabase(path.join(genDir, 'database.sqlite'));
    this.genId = genId;
    this.genDirPath = genDir;
  }

  close(): void {
    if (this.real) {
      try {
        this.real.close();
      } catch {
        /* ignore */
      }
      this.real = null;
    }
    this.genId = '';
    this.genDirPath = '';
  }

  current(): DatabaseSync {
    if (!this.real) {
      throw maintenanceUnavailable('数据维护中（备份/恢复），请稍后重试');
    }
    return this.real;
  }

  get generationId(): string {
    if (!this.real) throw maintenanceUnavailable('数据维护中（备份/恢复），请稍后重试');
    return this.genId;
  }

  get genDir(): string {
    if (!this.real) throw maintenanceUnavailable('数据维护中（备份/恢复），请稍后重试');
    return this.genDirPath;
  }

  get attachmentsDir(): string {
    return path.join(this.genDir, 'attachments');
  }

  ensureAttachmentsDir(): string {
    const dir = this.attachmentsDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  get isOpen(): boolean {
    return this.real !== null;
  }
}
