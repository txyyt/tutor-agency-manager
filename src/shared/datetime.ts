// 时间处理：内部一律UTC ISO字符串；界面按 Asia/Hong_Kong（UTC+8，无夏令时）显示。
// 纯函数，前后端共用；不依赖Intl（保证确定性）。

const HK_OFFSET_MINUTES = 8 * 60;

export function hkPartsFromUtc(iso: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + HK_OFFSET_MINUTES * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** 2026-09-30 形式的香港本地日期 */
export function hkDateString(iso: string): string {
  const p = hkPartsFromUtc(iso);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function hkCompactDateString(iso: string): string {
  return hkDateString(iso).replace(/-/g, '');
}

export function hkTimeString(iso: string): string {
  const p = hkPartsFromUtc(iso);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 2026-09-30 14:30 形式 */
export function formatHkDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${hkDateString(iso)} ${hkTimeString(iso)}`;
}

/** 2026年09月30日 14:30 形式（界面展示） */
export function formatHkDateTimeCn(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = hkPartsFromUtc(iso);
  return `${p.year}年${String(p.month).padStart(2, '0')}月${String(p.day).padStart(2, '0')}日 ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 当前香港本地日期时间是否已到指定时刻（用于02:00调度） */
export function hkTodayKey(nowIso: string): string {
  return hkDateString(nowIso);
}

/** 解析 YYYY-MM-DD（严格） */
export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
