// 微信模板确定性文本解析器。
// 原则：按字段名称（含别名）识别，不依赖编号；只有“已知顶级字段标签”才会开启新字段，
// 正文中的括号、冒号、编号内容一律作为多行值的续行保留；冲突不静默取最后一项。
import type { ConvertCtx } from './converters.js';
import {
  convertDate,
  convertGender,
  convertGenderPreference,
  convertLongText,
  convertPhone,
  convertSalary,
  convertSessionMinutes,
  convertSessionsPerWeek,
  convertTeachingMode,
  convertWechat,
  convertYesNo,
  isPlaceholder,
} from './converters.js';
import { LIMITS } from '../types.js';
import { centsToYuanString } from '../money.js';

export type TemplateKind = 'parent' | 'teacher';

export interface TemplateParseResult {
  kind: TemplateKind;
  /** 规范化后的原文（
换行），保存时随记录存储 */
  sourceText: string;
  /** 草稿：字段名 → 值（string|number|boolean|null），未转换成功的保留 raw 字段 */
  draft: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  warnings: string[];
  unrecognizedFields: string[];
  conflicts: Record<string, string[]>;
  /** 老师模板识别出的订单编号（可能带冲突） */
  orderNo: string | null;
}

export type ParseStructureErrorCode =
  | 'EMPTY_INPUT'
  | 'TOO_LONG'
  | 'MULTIPLE_TEMPLATES'
  | 'NO_RECOGNIZED_CONTENT';

export class ParseStructureError extends Error {
  code: ParseStructureErrorCode;
  constructor(code: ParseStructureErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface FieldDef {
  key: string;
  label: string;
  aliases: string[];
  required: boolean;
  convert: (raw: string, ctx: ConvertCtx) => ReturnType<typeof convertLongText>;
}

const phoneAliases = ['电话', '手机号', '联系电话', '电话号码'];
const wechatAliases = ['微信', '微信号'];
const scheduleAliases = ['每周可上课的日期和时间', '每周可上课时间', '可上课时间', '每周上课时间'];

const PARENT_FIELDS: FieldDef[] = [
  { key: 'parentName', label: '家长称呼', aliases: ['家长称呼', '家长姓名', '称呼'], required: true, convert: (r) => convertLongText(r, { required: true, label: '家长称呼' }) },
  { key: 'parentWechat', label: '微信', aliases: wechatAliases, required: true, convert: convertWechat },
  { key: 'parentPhone', label: '电话', aliases: phoneAliases, required: true, convert: convertPhone },
  { key: 'childGrade', label: '孩子年级', aliases: ['孩子年级'], required: true, convert: (r) => convertLongText(r, { required: true, label: '孩子年级' }) },
  { key: 'subjects', label: '辅导科目', aliases: ['辅导科目', '科目'], required: true, convert: (r) => convertLongText(r, { required: true, label: '辅导科目' }) },
  { key: 'learningSituation', label: '目前学习情况', aliases: ['目前学习情况', '学习情况'], required: true, convert: (r) => convertLongText(r, { required: true, label: '目前学习情况' }) },
  { key: 'tutoringGoal', label: '辅导目标', aliases: ['辅导目标'], required: true, convert: (r) => convertLongText(r, { required: true, label: '辅导目标' }) },
  { key: 'teachingMode', label: '上课方式', aliases: ['上课方式'], required: true, convert: convertTeachingMode },
  { key: 'locationDetail', label: '上课区域及地点', aliases: ['上课区域及地点', '上课地点', '上课区域'], required: true, convert: (r) => convertLongText(r, { required: true, label: '上课区域及地点' }) },
  { key: 'weeklySchedule', label: '每周可上课的日期和时间', aliases: scheduleAliases, required: true, convert: (r) => convertLongText(r, { required: true, label: '每周可上课的日期和时间' }) },
  { key: 'sessionsPerWeek', label: '每周上课次数', aliases: ['每周上课次数', '每周次数'], required: true, convert: convertSessionsPerWeek },
  { key: 'sessionMinutes', label: '每次上课时长', aliases: ['每次上课时长', '每次时长', '单次时长'], required: true, convert: convertSessionMinutes },
  { key: 'expectedStartDate', label: '预计开始时间', aliases: ['预计开始时间', '开始时间'], required: false, convert: convertDate },
  { key: 'hourlyPay', label: '薪资', aliases: ['薪资', '时薪', '薪资要求'], required: true, convert: convertSalary },
  { key: 'payNegotiable', label: '是否可以协商', aliases: ['是否可以协商', '可否协商'], required: true, convert: convertYesNo },
  { key: 'genderPreference', label: '老师性别要求', aliases: ['老师性别要求', '性别要求'], required: true, convert: convertGenderPreference },
  { key: 'otherRequirements', label: '对老师的其他要求', aliases: ['对老师的其他要求', '其他要求', '老师要求'], required: true, convert: (r) => convertLongText(r, { required: true, label: '对老师的其他要求（无要求填“无”）' }) },
  { key: 'notes', label: '其他备注', aliases: ['其他备注', '备注'], required: false, convert: (r) => convertLongText(r) },
];

const TEACHER_FIELDS: FieldDef[] = [
  { key: 'orderNo', label: '报名订单编号', aliases: ['报名订单编号', '订单编号', '订单号'], required: true, convert: (r) => convertLongText(r, { required: true, label: '报名订单编号' }) },
  { key: 'teacherName', label: '姓名', aliases: ['姓名'], required: true, convert: (r) => convertLongText(r, { required: true, label: '姓名' }) },
  { key: 'gender', label: '性别', aliases: ['性别'], required: true, convert: convertGender },
  { key: 'wechat', label: '微信', aliases: wechatAliases, required: true, convert: convertWechat },
  { key: 'phone', label: '电话', aliases: phoneAliases, required: true, convert: convertPhone },
  { key: 'university', label: '就读学校', aliases: ['就读学校', '学校'], required: true, convert: (r) => convertLongText(r, { required: true, label: '就读学校' }) },
  { key: 'major', label: '专业', aliases: ['专业'], required: true, convert: (r) => convertLongText(r, { required: true, label: '专业' }) },
  { key: 'studyYear', label: '当前年级', aliases: ['当前年级'], required: true, convert: (r) => convertLongText(r, { required: true, label: '当前年级' }) },
  { key: 'teachableSubjectsGrades', label: '可辅导的科目及年级', aliases: ['可辅导的科目及年级', '可辅导科目及年级', '可辅导科目', '可辅导的科目'], required: true, convert: (r) => convertLongText(r, { required: true, label: '可辅导的科目及年级' }) },
  { key: 'achievements', label: '相关成绩或能力说明', aliases: ['相关成绩或能力说明', '成绩或能力说明', '成绩说明', '成绩与能力'], required: false, convert: (r) => convertLongText(r) },
  { key: 'teachingExperience', label: '家教或其他教学经验', aliases: ['家教或其他教学经验', '教学经验', '家教经验'], required: true, convert: (r) => convertLongText(r, { required: true, label: '家教或其他教学经验（没有经验填“暂无”）' }) },
  { key: 'strengthsAndPlan', label: '针对本订单的优势及辅导思路', aliases: ['针对本订单的优势及辅导思路', '优势及辅导思路', '优势与辅导思路', '辅导思路'], required: true, convert: (r) => convertLongText(r, { required: true, label: '针对本订单的优势及辅导思路' }) },
  { key: 'weeklySchedule', label: '每周可上课的日期和时间', aliases: scheduleAliases, required: true, convert: (r) => convertLongText(r, { required: true, label: '每周可上课的日期和时间' }) },
  { key: 'earliestStartDate', label: '最早可开始时间', aliases: ['最早可开始时间', '最早开始'], required: false, convert: convertDate },
  { key: 'acceptsOrderPay', label: '是否接受订单中的薪资', aliases: ['是否接受订单中的薪资', '是否接受订单薪资', '是否接受薪资'], required: true, convert: convertYesNo },
  { key: 'expectedHourlyPay', label: '期望薪资', aliases: ['如不接受，期望薪资', '期望薪资'], required: false, convert: convertSalary },
  { key: 'canAttendTrial', label: '是否可以按安排参加试课', aliases: ['是否可以按安排参加试课', '是否能按安排参加试课', '是否可以参加试课', '是否可试课'], required: true, convert: convertYesNo },
  { key: 'trialConstraints', label: '试课时间限制', aliases: ['如有时间限制，请说明', '时间限制'], required: false, convert: (r) => convertLongText(r) },
  { key: 'notes', label: '其他备注', aliases: ['其他备注', '备注'], required: false, convert: (r) => convertLongText(r) },
  { key: 'resumeAttachmentNote', label: '简历附件', aliases: ['简历附件'], required: false, convert: (r) => convertLongText(r) },
];

const PARENT_TITLE = '家教需求登记';
const TEACHER_TITLE = '大学生家教报名';

const GROUP_HEADER_RE = /^【[^】]{1,20}$/; // 无右括号的半截组标题也算
const LABEL_RE = /^(?:\d{1,2}\s*[.、．)]\s*)?([^：:]{1,24})[：:]\s*(.*)$/;

const FIXED_EXPLANATIONS = new Set(
  [
    '（例如：基础薄弱、成绩中等、希望提高解题能力）',
    '（例如：巩固基础、作业辅导、考试复习）',
    '（线下先填写小区或附近地标，无需填写门牌号；线上填写“线上”）',
    '（例如：周二、周四 19:00—21:00）',
    '（例如：专业、教学经验、擅长科目等）',
    '（例如：大二、研一）',
    '（请注明考试名称、年份、分数及满分）',
    '（请说明学生年级、科目、教学时长等；没有经验可填写“暂无”）',
  ].map(normalizeQuotes),
);

const FIXED_FOOTERS = new Set(
  [
    '请按一份独立家教需求填写一份表。',
    '如需分别聘请不同老师，请分别填写。',
    '请针对本订单填写。',
    '如报名多个订单，请分别提交，每份注明订单编号。',
    '请如实填写资料和教学经历。',
  ].map(normalizeQuotes),
);

// 明确不猜测映射的常见字段名：提示手动补正
const KNOWN_UNMAPPED = new Set(['联系方式', 'qq', 'qq号', '邮箱', '电子邮件', '孩子姓名', '详细地址', '住址', '身份证']);

function normalizeQuotes(s: string): string {
  return s.replace(/["“”]/g, '"').replace(/['‘’]/g, "'").trim();
}

function normalizeLine(s: string): string {
  return normalizeQuotes(s.replace(/[\s\u00A0\u3000]+$/g, '').replace(/^[\s\u00A0\u3000]+/g, ''));
}

/** 去除编号前缀，返回 { label, rest }；不是标签行返回 null */
function matchLabelLine(line: string): { label: string; rest: string } | null {
  const m = LABEL_RE.exec(line);
  if (!m) return null;
  const rawLabel = (m[1] ?? '').trim();
  const rest = (m[2] ?? '').trim();
  if (!rawLabel) return null;
  // 去掉尾部括号说明（如“（选填）”“（选填，可附 PDF 或图片）”）
  const label = rawLabel.replace(/（[^）]*）$/, '').replace(/\([^)]*\)$/, '').trim();
  return { label, rest };
}

export function detectKind(text: string): { parentTitles: number; teacherTitles: number } {
  const parentTitles = countOccurrences(text, `【${PARENT_TITLE}】`);
  const teacherTitles = countOccurrences(text, `【${TEACHER_TITLE}】`);
  return { parentTitles, teacherTitles };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 解析已填写的模板文本。结构问题抛 ParseStructureError；字段问题记入 fieldErrors。
 * @param kind 期望模板类型
 * @param text 用户粘贴的文本
 * @param ctx 转换上下文（今天日期，测试可注入）
 */
export function parseTemplate(kind: TemplateKind, text: string, ctx: ConvertCtx): TemplateParseResult {
  if (text.trim() === '') throw new ParseStructureError('EMPTY_INPUT', '粘贴内容为空');
  if (text.length > LIMITS.maxTemplateTextChars) {
    throw new ParseStructureError('TOO_LONG', `粘贴内容超过${LIMITS.maxTemplateTextChars}字符上限，请分开粘贴`);
  }
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const titles = detectKind(normalized);
  const myTitle = kind === 'parent' ? titles.parentTitles : titles.teacherTitles;
  const otherTitle = kind === 'parent' ? titles.teacherTitles : titles.parentTitles;
  if (myTitle === 0 && otherTitle === 0) {
    // 没有标题：仍然尝试解析，但给出警告（不强制，用户可能删了标题行）
  }
  if (myTitle + otherTitle > 1) {
    throw new ParseStructureError('MULTIPLE_TEMPLATES', '检测到多份模板标题，请一次只粘贴一份，多人的内容请分开粘贴');
  }
  if (otherTitle > 0 && myTitle === 0) {
    throw new ParseStructureError(
      'MULTIPLE_TEMPLATES',
      kind === 'parent' ? '粘贴的内容是“大学生家教报名”模板，请在老师报名入口使用' : '粘贴的内容是“家教需求登记”模板，请在家长需求入口使用',
    );
  }

  const fields = kind === 'parent' ? PARENT_FIELDS : TEACHER_FIELDS;
  const byLabel = new Map<string, FieldDef>();
  for (const f of fields) {
    byLabel.set(normalizeQuotes(f.label), f);
    for (const a of f.aliases) byLabel.set(normalizeQuotes(a), f);
  }

  /** key → 已收集的值（多个来源） */
  const collected = new Map<string, { values: string[]; rawLines: string[] }>();
  const warnings: string[] = [];
  const unrecognizedFields: string[] = [];
  let current: FieldDef | null = null;

  const pushValue = (def: FieldDef, v: string, rawLine: string) => {
    const entry = collected.get(def.key) ?? { values: [], rawLines: [] };
    entry.values.push(v);
    entry.rawLines.push(rawLine);
    collected.set(def.key, entry);
  };
  const appendCurrent = (line: string) => {
    if (!current) return false;
    const entry = collected.get(current.key);
    if (!entry) return false;
    const last = entry.values.length - 1;
    const prev = entry.values[last] ?? '';
    entry.values[last] = prev === '' ? line : `${prev}\n${line}`;
    return true;
  };

  const lines = normalized.split('\n');
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (line === '') {
      continue; // 空行不开启新字段；多行值内部的空行由下一行续行自然衔接
    }
    // 标题
    if (line.includes(`【${PARENT_TITLE}】`) || line.includes(`【${TEACHER_TITLE}】`)) continue;
    // 组标题或残缺组标题
    if (/^【.+】$/.test(line) || GROUP_HEADER_RE.test(line)) {
      current = null;
      continue;
    }
    // 固定说明文本
    if (FIXED_EXPLANATIONS.has(normalizeQuotes(line))) continue;
    if (FIXED_FOOTERS.has(normalizeQuotes(line))) continue;

    const labelMatch = matchLabelLine(line);
    if (labelMatch) {
      const def = byLabel.get(normalizeQuotes(labelMatch.label));
      if (def) {
        // 已知顶级字段 → 开新字段
        current = def;
        pushValue(def, labelMatch.rest, line);
        continue;
      }
      const norm = normalizeQuotes(labelMatch.label).toLowerCase();
      if (KNOWN_UNMAPPED.has(norm)) {
        // 明确不猜测映射的常见字段：单独列出并提示（如“联系方式”不猜成微信或电话）
        unrecognizedFields.push(line);
        warnings.push(`识别到模板外字段“${labelMatch.label}”，系统不会猜测其含义（如为微信或电话，请手动补填对应项）`);
        current = null;
        continue;
      }
      if (current) {
        // 未知冒号行：作为当前字段续行保留（正文中的“年级：”等不会被误判）
        appendCurrent(line);
        continue;
      }
      unrecognizedFields.push(line);
      current = null;
      continue;
    }
    // 普通续行
    if (!appendCurrent(line)) {
      unrecognizedFields.push(line);
    }
  }

  // ---- 冲突与转换 ----
  const fieldErrors: Record<string, string> = {};
  const conflicts: Record<string, string[]> = {};
  const draft: Record<string, unknown> = {};
  let orderNo: string | null = null;

  for (const def of fields) {
    const entry = collected.get(def.key);
    if (!entry || entry.values.length === 0) {
      if (def.required) {
        fieldErrors[def.key] = `【${def.label}】缺失，请补正`;
        draft[def.key] = def.key === 'hourlyPay' || def.key === 'expectedHourlyPay' ? null : null;
      }
      continue;
    }
    const distinct = [...new Set(entry.values.map((v) => v.trim()))];
    if (distinct.length > 1) {
      conflicts[def.key] = [...entry.rawLines];
      fieldErrors[def.key] = `【${def.label}】出现多次且内容不一致，请检查原文后保留一项（系统暂取第一次出现的内容）`;
      if (def.key === 'orderNo') {
        warnings.push('检测到多个不同的订单编号，请确认要报名的订单后修改');
      }
    }
    const raw = distinct[0] ?? '';
    const converted = def.convert(raw, ctx);
    draft[def.key] = converted.value;
    if (converted.raw !== undefined) draft[`${def.key}Raw`] = converted.raw;
    if (converted.error) {
      const prev = fieldErrors[def.key];
      fieldErrors[def.key] = prev ? `${prev}；${converted.error}` : converted.error;
    }
    if (converted.warning) warnings.push(`【${def.label}】${converted.warning}`);
    if (def.key === 'orderNo') orderNo = typeof converted.value === 'string' && converted.value !== '' ? converted.value : null;
  }

  // 占位值但字段根本没出现（如“简历附件”未出现）不提示；
  // 提示附件：文本中出现“附件”字样时说明文件未真正上传
  const resumeEntry = collected.get('resumeAttachmentNote');
  if (kind === 'teacher' && (resumeEntry || /见附件|附件/.test(normalized))) {
    warnings.push('文本中提到附件：粘贴不等于已上传，请在本页另行选择本机文件上传简历');
  }

  // 跨字段规则：老师“接受订单薪资”时期望薪资的占位不算缺失；不接受时缺失要提示
  if (kind === 'teacher') {
    const accepts = draft.acceptsOrderPay === true;
    if (accepts) {
      delete fieldErrors.expectedHourlyPay;
    } else if (draft.acceptsOrderPay === false) {
      const entry = collected.get('expectedHourlyPay');
      const rawVal = entry?.values[0]?.trim() ?? '';
      if ((draft.expectedHourlyPay === null || draft.expectedHourlyPay === undefined) && !entry) {
        fieldErrors.expectedHourlyPay = '【期望薪资】不接受订单薪资时必须填写期望薪资';
      } else if (rawVal === '' && (draft.expectedHourlyPay === null || draft.expectedHourlyPay === undefined)) {
        fieldErrors.expectedHourlyPay = '【期望薪资】不接受订单薪资时必须填写期望薪资';
      }
    }
  }

  // 必填字段为占位（如“____”）时 convert 返回 error，无需额外处理；
  // 但整段未识别时给出结构性提示
  if (collected.size === 0) {
    throw new ParseStructureError('NO_RECOGNIZED_CONTENT', '未能识别任何模板字段，请确认粘贴的是本系统提供的家长/老师模板');
  }

  return {
    kind,
    sourceText: normalized,
    draft,
    fieldErrors,
    warnings,
    unrecognizedFields,
    conflicts,
    orderNo,
  };
}

/** 老师模板草稿 → 报名表单草稿的字段映射（供界面/测试复用） */
export function teacherDraftToForm(draft: Record<string, unknown>): Record<string, unknown> {
  return {
    teacherName: draft.teacherName ?? '',
    gender: draft.gender ?? '',
    wechat: draft.wechat ?? '',
    phone: draft.phone ?? '',
    university: draft.university ?? '',
    major: draft.major ?? '',
    studyYear: draft.studyYear ?? '',
    teachableSubjectsGrades: draft.teachableSubjectsGrades ?? '',
    achievements: draft.achievements ?? '',
    teachingExperience: draft.teachingExperience ?? '',
    strengthsAndPlan: draft.strengthsAndPlan ?? '',
    availableSchedule: draft.weeklySchedule ?? '',
    earliestStartDate: draft.earliestStartDate ?? null,
    acceptsOrderPay: draft.acceptsOrderPay ?? null,
    expectedHourlyPayRaw:
      draft.expectedHourlyPayRaw ??
      (typeof draft.expectedHourlyPay === 'number' ? centsToYuanString(draft.expectedHourlyPay) : ''),
    canAttendTrial: draft.canAttendTrial ?? null,
    trialConstraints: draft.trialConstraints ?? '',
    notes: draft.notes ?? '',
  };
}

/** 家长模板草稿 → 订单表单草稿 */
export function parentDraftToForm(draft: Record<string, unknown>): Record<string, unknown> {
  return {
    parentName: draft.parentName ?? '',
    parentWechat: draft.parentWechat ?? '',
    parentPhone: draft.parentPhone ?? '',
    childGrade: draft.childGrade ?? '',
    subjects: draft.subjects ?? '',
    learningSituation: draft.learningSituation ?? '',
    tutoringGoal: draft.tutoringGoal ?? '',
    teachingMode: draft.teachingMode ?? '',
    locationDetail: draft.locationDetail ?? '',
    publicArea: '',
    weeklySchedule: draft.weeklySchedule ?? '',
    publicSchedule: draft.weeklySchedule ?? '', // 默认与内部一致，操作人可修改
    sessionsPerWeek: draft.sessionsPerWeek ?? null,
    sessionMinutes: draft.sessionMinutes ?? null,
    expectedStartDate: draft.expectedStartDate ?? null,
    hourlyPayRaw: draft.hourlyPayRaw ?? (typeof draft.hourlyPay === 'number' ? centsToYuanString(draft.hourlyPay) : ''),
    payNegotiable: draft.payNegotiable ?? null,
    genderPreference: draft.genderPreference ?? '',
    teacherRequirements: draft.otherRequirements ?? '',
    publicRequirements: draft.otherRequirements ?? '', // 默认同内部要求，操作人检查后可修改
    notes: draft.notes ?? '',
  };
}

export { isPlaceholder };
