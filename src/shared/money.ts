// 金额精确转换：字符串→整数分，不走浮点累计。

export class MoneyFormatError extends Error {}

/** "150" → 15000；"150.5" → 15050；最多两位小数；禁止负数/NaN/科学计数法。 */
export function yuanStringToCents(input: string): number {
  const s = input.trim().replace(/^[+]/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new MoneyFormatError(`金额“${input}”无效：请填写最多两位小数的非负金额`);
  }
  const dot = s.indexOf('.');
  if (dot === -1) return Number(s) * 100;
  const intPart = s.slice(0, dot);
  const frac = s.slice(dot + 1).padEnd(2, '0');
  return Number(intPart) * 100 + Number(frac);
}

/** 整数分 → 显示字符串（元），如 15000 → "150"、15050 → "150.5"。 */
export function centsToYuanString(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new MoneyFormatError(`金额分值非法：${cents}`);
  const yuan = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return String(yuan);
  return frac % 10 === 0 ? `${yuan}.${frac / 10}` : `${yuan}.${String(frac).padStart(2, '0')}`;
}

/** 显示用：金额 + 元 */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '未填写';
  return `${centsToYuanString(cents)}元`;
}
