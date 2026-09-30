// 同步事务；复合业务通过保存点调用已有服务，失败时整组回滚。
import type { DatabaseSync } from 'node:sqlite';
const depths = new WeakMap<DatabaseSync, number>();
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const depth = depths.get(db) ?? 0;
  const name = `business_${depth}`;
  db.exec(depth ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE;');
  depths.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth ? `RELEASE SAVEPOINT ${name}` : 'COMMIT;');
    return result;
  } catch (error) {
    try {
      if (depth) { db.exec(`ROLLBACK TO SAVEPOINT ${name}`); db.exec(`RELEASE SAVEPOINT ${name}`); }
      else db.exec('ROLLBACK;');
    } catch { /* 保留业务异常 */ }
    throw error;
  } finally { depths.set(db, depth); }
}
