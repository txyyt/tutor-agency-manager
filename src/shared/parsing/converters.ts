// 模板字段值转换：薪资/次数/时长/日期/布尔/枚举的确定性规范化。
// 所有转换基于字符串精确处理，不走浮点累计。
import { isValidIsoDate } from '../datetime.js';
import { yuanStringToCents } from '../money.js';

export interface ConvertCtx {
  /** 香港本地今天，YYYY-MM-DD，用于“10月15日”补年份 */
  hkToday: string;
}

export interface Converted {
  value: unknown;
  /** 无法转换为结构值时保留原文，供操作人补正 */
  raw?: string;
  error?: string;
  warning?: string;
}

export function isPlaceholder(s: string): boolean {
  const t = s.trim();
  if (t === '') return true;
  if (/^_{2,}$/.test(t.replace(/\s/g, ''))) return true; // ____ 占位
  if (/^[＿_]+$/.test(t.replace(/\s/g, ''))) return true;
  return false;
}

function stripSpaces(s: string): string {
  return s.replace(/[\s\u00A0\u3000]/g, '');
}

const CHOICE_HINT_YES_NO = ['是/否', '可以/不可以', '接受/不接受'];
const CHOICE_HINT_MODE = ['线上/线下'];
const CHOICE_HINT_GENDER_ANY = ['不限/男/女'];

// ---------- 是 / 否 ----------
export function convertYesNo(raw: string): Converted {
  const t = stripSpaces(raw);
  if (isPlaceholder(raw)) return { value: null, error: '未填写，请选择是或否' };
  if (CHOICE_HINT_YES_NO.includes(t)) return { value: null, error: '未选择（仍是“是 / 否”提示），请填写是或否' };
  const yes = ['是', '可以', '接受', '愿意', '能', '同意'];
  const no = ['否', '不可以', '不接受', '不愿意', '不能', '不同意'];
  if (yes.includes(t)) return { value: true };
  if (no.includes(t)) return { value: false };
  return { value: null, raw, error: `“${raw.trim()}”无法识别为是/否，请填写“是”或“否”` };
}

// ---------- 线上 / 线下 ----------
export function convertTeachingMode(raw: string): Converted {
  const t = stripSpaces(raw);
  if (isPlaceholder(raw)) return { value: null, error: '未填写，请选择线上或线下' };
  if (CHOICE_HINT_MODE.includes(t)) return { value: null, error: '未选择（仍是“线上 / 线下”提示），请填写线上或线下' };
  const hasOnline = t.includes('线上');
  const hasOffline = t.includes('线下');
  if (hasOnline && hasOffline) return { value: null, raw, error: `“${raw.trim()}”同时包含线上和线下，请二选一` };
  if (hasOnline) return { value: 'online' };
  if (hasOffline) return { value: 'offline' };
  return { value: null, raw, error: `“${raw.trim()}”无法识别，请填写“线上”或“线下”` };
}

// ---------- 性别（老师本人） ----------
export function convertGender(raw: string): Converted {
  const t = stripSpaces(raw);
  if (isPlaceholder(raw)) return { value: null, error: '未填写，请填写男或女' };
  if (t === '男') return { value: 'male' };
  if (t === '女') return { value: 'female' };
  return { value: null, raw, error: `“${raw.trim()}”无法识别，请填写“男”或“女”` };
}

// ---------- 性别要求（不限/男/女） ----------
export function convertGenderPreference(raw: string): Converted {
  const t = stripSpaces(raw);
  if (isPlaceholder(raw)) return { value: null, error: '未填写，请填写不限、男或女' };
  if (CHOICE_HINT_GENDER_ANY.includes(t)) return { value: null, error: '未选择（仍是“不限 / 男 / 女”提示），请填写不限、男或女' };
  if (t === '不限') return { value: 'any' };
  if (t === '男') return { value: 'male' };
  if (t === '女') return { value: 'female' };
  return { value: null, raw, error: `“${raw.trim()}”无法识别，请填写“不限”、“男”或“女”` };
}

// ---------- 薪资（元/小时 → 整数分） ----------
const RANGE_RE = /^\s*(\d+(?:\.\d+)?)\s*(?:[-~－～—–]|至|到)\s*(\d+(?:\.\d+)?)\s*元?\s*(?:\/|每)?\s*(?:小时|时|h|H)?\s*$/;

export function convertSalary(raw: string): Converted {
  const t = raw.trim();
  const stripped0 = t
    .replace(/元\s*\/\s*(小时|时|h|H)/g, '')
    .replace(/元/g, '')
    .trim();
  if (isPlaceholder(t) || isPlaceholder(stripped0)) {
    return { value: null, error: '未填写薪资，请填写具体金额（如150元/小时）' };
  }
  const stripped = stripped0
    .replace(/元\s*\/\s*(小时|时|h|H)/g, '')
    .replace(/元\s*每\s*小时/g, '')
    .replace(/元\/小时/g, '')
    .replace(/元\s*\/\s*时/g, '')
    .replace(/每小时/g, '')
    .replace(/元\/时/g, '')
    .replace(/元/g, '')
    .trim();
  const rangeMatch = RANGE_RE.exec(stripped);
  if (rangeMatch) {
    return { value: null, raw: t, error: `薪资“${t}”是一个区间，请确定具体金额后填写，系统不会擅自取最低值` };
  }
  const m = /^(\d+(?:\.\d{1,2})?)$/.exec(stripSpaces(stripped));
  if (m && m[1] !== undefined) {
    try {
      return { value: yuanStringToCents(m[1]) };
    } catch {
      return { value: null, raw: t, error: `薪资“${t}”格式无效` };
    }
  }
  return { value: null, raw: t, error: `薪资“${t}”无法识别，请填写具体金额（如150元/小时）；最多两位小数` };
}

// 只接受确定的整数写法，不把“一两”“两三”等模糊描述当成数字。
function parseChineseInteger(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text.length === 1 && digits[text] !== undefined) return digits[text];
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (tens) return (tens[1] ? (digits[tens[1]] ?? NaN) : 1) * 10 + (tens[2] ? (digits[tens[2]] ?? NaN) : 0);
  return NaN;
}

// ---------- 每周次数 ----------
export function convertSessionsPerWeek(raw: string): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) return { value: null, error: '未填写每周上课次数' };
  const s = stripSpaces(t.normalize('NFKC'))
    .replace(/^(?:每周|一周|每星期|每个星期|每礼拜)(?:上课)?/, '')
    .replace(/次(?:[\/／](?:周|星期|礼拜))?$/, '');
  const n = parseChineseInteger(s);
  if (!Number.isInteger(n) || n < 1 || n > 28) {
    return { value: null, raw: t, error: `每周上课次数“${t}”无法确定，请确认具体次数，填写1—28的整数（如“每周两次”“2次/周”）` };
  }
  return { value: n };
}

// ---------- 每次时长（→ 整数分钟） ----------
export function convertSessionMinutes(raw: string): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) return { value: null, error: '未填写每次上课时长' };
  const s = stripSpaces(t.normalize('NFKC')).replace(/^(?:每次上课时长|每次时长|上课时长|每次)/, '');
  const number = '(?:\\d+(?:\\.\\d+)?|[零一二两三四五六七八九十]+)';
  const integer = '(?:\\d+|[零一二两三四五六七八九十]+)';
  const hours = (v: string) => /^\d/.test(v) ? hoursStringToMinutes(v) : parseChineseInteger(v) * 60;

  if (s === '半小时' || s === '半个小时') return { value: 30 };
  const half = new RegExp(`^(${integer})(?:个半小时|(?:个)?小时半)$`).exec(s);
  if (half) return validateMinutes(parseChineseInteger(half[1] ?? '') * 60 + 30, t);
  const hm = new RegExp(`^(${number})(?:个)?小时(${integer})分钟?$`).exec(s);
  if (hm) return validateMinutes(hours(hm[1] ?? '') + parseChineseInteger(hm[2] ?? ''), t);
  const hOnly = new RegExp(`^(${number})(?:个)?小时$`).exec(s);
  if (hOnly) return validateMinutes(hours(hOnly[1] ?? ''), t);
  const mOnly = new RegExp(`^(${integer})(?:分钟?)?$`).exec(s);
  if (mOnly) return validateMinutes(parseChineseInteger(mOnly[1] ?? ''), t);
  return { value: null, raw: t, error: `上课时长“${t}”无法确定，请确认具体时长（如“1.5小时”“一个半小时”“90分钟”），区间或模糊描述需人工确认` };
}

function hoursStringToMinutes(h: string): number {
  if (!h.includes('.')) return Number(h) * 60;
  const [int, frac] = h.split('.');
  const intMinutes = Number(int || '0') * 60;
  // 小数部分是“百分之几小时”：0.5小时=30分钟；四舍五入到整分钟后校验
  const fracMinutes = Math.round(Number(`0.${frac ?? '0'}`) * 60);
  if (!Number.isInteger(fracMinutes)) return NaN;
  return intMinutes + fracMinutes;
}

function validateMinutes(minutes: number, raw: string): Converted {
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 600) {
    return { value: null, raw, error: `上课时长“${raw}”无效，请填写15—600的整数分钟` };
  }
  return { value: minutes };
}

// ---------- 日期 ----------
const VAGUE_OK = ['协商', '待定', '暂无', '未定', '面议', '随时', '均可'];

export function convertDate(raw: string, ctx: ConvertCtx): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) return { value: null }; // 留空=协商
  if (VAGUE_OK.includes(stripSpaces(t))) return { value: null, warning: `“${t}”按协商处理，未填具体日期` };
  const iso = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(stripSpaces(t));
  if (iso) {
    const y = iso[1], m = iso[2], d = iso[3];
    const date = `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
    if (!isValidIsoDate(date)) return { value: null, raw: t, error: `日期“${t}”不存在，请检查` };
    return { value: date };
  }
  const md = /^(\d{1,2})月(\d{1,2})日$/.exec(stripSpaces(t));
  if (md) {
    const m = Number(md[1]), d = Number(md[2]);
    const year = Number(ctx.hkToday.slice(0, 4));
    let date = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!isValidIsoDate(date)) {
      return { value: null, raw: t, error: `日期“${t}”不存在，请检查` };
    }
    // 若已过去超过180天，推断为明年
    const today = new Date(`${ctx.hkToday}T00:00:00Z`).getTime();
    const parsed = new Date(`${date}T00:00:00Z`).getTime();
    if (today - parsed > 180 * 24 * 3600 * 1000) {
      date = `${year + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { value: date, warning: `“${t}”已按 ${date}（明年）处理，请确认` };
    }
    return { value: date, warning: `“${t}”已按 ${date} 处理，请确认` };
  }
  return { value: null, raw: t, error: `“${t}”是相对或有歧义的日期，请改为具体日期（如2026-10-15）或留空表示协商` };
}

// ---------- 电话（保留原样，只做合法性检查） ----------
export function convertPhone(raw: string): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) return { value: null, error: '未填写电话（必填）' };
  const digits = t.replace(/[^0-9]/g, '');
  if (!/^[0-9+\-()\s\uFF08\uFF09]+$/.test(t)) {
    return { value: null, raw: t, error: `电话“${t}”含无效字符，只能包含数字、空格、连字符、括号和区号+` };
  }
  if (digits.length < 5 || digits.length > 25) {
    return { value: null, raw: t, error: `电话“${t}”位数无效` };
  }
  return { value: t };
}

// ---------- 微信（保留原样） ----------
export function convertWechat(raw: string): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) return { value: null, error: '未填写微信（必填）' };
  if (t.length > 60) return { value: null, raw: t, error: '微信号过长（超过60字符）' };
  return { value: t };
}

// ---------- 长文本（保留原文，包括括号与冒号） ----------
export function convertLongText(raw: string, opts?: { required?: boolean; label?: string; allowPlaceholderWord?: string }): Converted {
  const t = raw.trim();
  if (isPlaceholder(t)) {
    if (opts?.required) return { value: null, error: `${opts.label ?? '该字段'}未填写（必填）` };
    return { value: '' };
  }
  return { value: t };
}

// ---------- 非负整数（普通） ----------
export function convertPositiveInt(raw: string, label: string, min: number, max: number): Converted {
  const t = stripSpaces(raw);
  if (isPlaceholder(raw)) return { value: null, error: `${label}未填写` };
  if (!/^\d+$/.test(t)) return { value: null, raw, error: `${label}“${raw.trim()}”应为整数` };
  const n = Number(t);
  if (n < min || n > max) return { value: null, raw, error: `${label}应在${min}—${max}之间` };
  return { value: n };
}
