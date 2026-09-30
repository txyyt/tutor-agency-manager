// 事务助手：同步事务包装。
import type { DatabaseSync } from 'node:sqlite';

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const r = fn();
    db.exec('COMMIT;');
    return r;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      /* 忽略回滚错误，保留原始异常 */
    }
    throw err;
  }
}
