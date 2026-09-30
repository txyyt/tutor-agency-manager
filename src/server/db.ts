// SQLite（node:sqlite）打开、迁移、事务工具。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../shared/types.js';

export type SqliteValue = string | number | bigint | Buffer | null;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');
  return db;
}

export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

function setUserVersion(db: DatabaseSync, v: number): void {
  db.exec(`PRAGMA user_version = ${v};`);
}

function migrationFiles(migrationDir: string): Array<{ version: number; file: string }> {
  const entries = fs.readdirSync(migrationDir).filter((f) => f.endsWith('.sql'));
  return entries
    .map((f) => ({ version: Number(f.split('_')[0]), file: f }))
    .sort((a, b) => a.version - b.version);
}

/** 迁移：按 user_version 顺序应用 migrations/*.sql；可重复执行。 */
export function migrate(db: DatabaseSync, migrationDir: string): number {
  const current = getUserVersion(db);
  const files = migrationFiles(migrationDir);
  for (const m of files) {
    if (m.version <= current) continue;
    if (m.version !== current + 1) {
      throw new Error(`迁移序号不连续：当前v${current}，遇到v${m.version}（${m.file}）`);
    }
    const sql = fs.readFileSync(path.join(migrationDir, m.file), 'utf-8');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(sql);
      setUserVersion(db, m.version);
      db.exec('COMMIT;');
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
  return getUserVersion(db);
}

/** 解析迁移目录：编译产物与tsx源码两种运行方式均指向项目根/migrations */
export function defaultMigrationDir(): string {
  // dist/server/db.js → ../../migrations；src/server/db.ts → ../../migrations
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

export class Transaction {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  run<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const r = fn();
      this.db.exec('COMMIT;');
      return r;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

export function schemaVersionOfDb(db: DatabaseSync): number {
  return getUserVersion(db);
}

export const CURRENT_SCHEMA_VERSION = LIMITS.dbSchemaVersion;
