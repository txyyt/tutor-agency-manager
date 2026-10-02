import type { DatabaseSync } from 'node:sqlite';

/** 包括历史旧格式编号：保留每个日期已经使用的最大序号。 */
export function orderDailyHighWater(db: DatabaseSync): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of db.prepare('SELECT order_no FROM orders').all() as Array<{ order_no: string }>) {
    const match = /^JJ-(\d{8})-(\d+)$/.exec(row.order_no);
    if (!match) continue;
    const day = match[1]!;
    const n = Number(match[2]);
    if (Number.isSafeInteger(n) && n > 0) result[day] = Math.max(result[day] ?? 0, n);
  }
  return result;
}

export function mergeDailyHighWater(...sources: Array<Record<string, number>>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const source of sources) {
    for (const [day, n] of Object.entries(source)) result[day] = Math.max(result[day] ?? 0, n);
  }
  return result;
}

/** 日期和序号分别比较，10000不能排在9999前面。 */
export function compareOrderNumbers(a: string, b: string): number {
  const x = /^JJ-(\d{8})-(\d+)$/.exec(a);
  const y = /^JJ-(\d{8})-(\d+)$/.exec(b);
  return x && y ? x[1]!.localeCompare(y[1]!) || Number(x[2]) - Number(y[2]) : a.localeCompare(b);
}
