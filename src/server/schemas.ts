// 请求体校验schema（Zod）。服务端是唯一权威校验；解析草稿保存也走同一校验。
import { z } from 'zod';
import { LIMITS } from '../shared/types.js';

const trimmed = (min: number, max: number, label: string) =>
  z.string().transform((s) => s.trim()).pipe(z.string().min(min, `${label}不能为空`).max(max, `${label}过长（最多${max}字）`));

const optionalText = (max: number, label: string) =>
  z.string().max(max, `${label}过长（最多${max}字）`).optional().default('');

const patchText = (max: number, label: string) =>
  z.string().max(max, `${label}过长（最多${max}字）`).optional();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为YYYY-MM-DD').nullable().optional();

const phoneSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, '电话为必填项')
      .max(25, '电话过长')
      .regex(/^[0-9+\-()\s\uFF08\uFF09]+$/, '电话只能包含数字、空格、连字符、括号或区号+')
      .refine((s) => s.replace(/[^0-9]/g, '').length >= 5, '电话数字位数不足（至少5位）'),
  );

const wechatSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, '微信为必填项').max(60, '微信过长'));

export const orderCreateSchema = z.object({
  parentName: trimmed(1, 60, '家长称呼'),
  parentWechat: wechatSchema,
  parentPhone: phoneSchema,
  childGrade: trimmed(1, 60, '孩子年级'),
  subjects: trimmed(1, 200, '辅导科目'),
  learningSituation: trimmed(1, 1000, '目前学习情况'),
  tutoringGoal: trimmed(1, 1000, '辅导目标'),
  teachingMode: z.enum(['online', 'offline'], { message: '上课方式必须是线上或线下' }),
  locationDetail: trimmed(0, 200, '上课区域及地点').optional().default(''),
  publicArea: trimmed(0, 100, '公开区域（用于群内发布）').optional().default(''),
  weeklySchedule: trimmed(1, 300, '每周可上课时间'),
  publicSchedule: trimmed(1, 300, '公开上课时间（用于群内发布）'),
  sessionsPerWeek: z.number().int('每周次数必须是整数').min(1).max(28),
  sessionMinutes: z.number().int('时长必须是整数分钟').min(15, '时长至少15分钟').max(600),
  expectedStartDate: isoDate,
  hourlyPayCents: z.number().int('薪资必须是整数分').gt(0, '薪资必须大于0'),
  payNegotiable: z.boolean({ message: '是否可协商必填' }),
  genderPreference: z.enum(['any', 'male', 'female']),
  teacherRequirements: optionalText(1000, '老师要求'),
  publicRequirements: optionalText(1000, '公开老师要求'),
  notes: optionalText(2000, '内部备注'),
  sourceTemplateText: z.string().max(LIMITS.maxTemplateTextChars).nullable().optional(),
  creationRequestId: z.string().uuid().nullable().optional(),
}).superRefine((v, ctx) => {
  if (v.teachingMode === 'offline') {
    if (!v.publicArea) ctx.addIssue({ code: 'custom', path: ['publicArea'], message: '线下上课必须填写公开授课区域' });
  }
}).transform((v) => v.teachingMode === 'online' ? { ...v, locationDetail: '线上', publicArea: '线上' } : v);

export const orderUpdateSchema = z.object({
  parentName: trimmed(1, 60, '家长称呼').optional(),
  parentWechat: wechatSchema.optional(),
  parentPhone: phoneSchema.optional(),
  childGrade: trimmed(1, 60, '孩子年级').optional(),
  subjects: trimmed(1, 200, '辅导科目').optional(),
  learningSituation: trimmed(1, 1000, '目前学习情况').optional(),
  tutoringGoal: trimmed(1, 1000, '辅导目标').optional(),
  teachingMode: z.enum(['online', 'offline']).optional(),
  locationDetail: trimmed(0, 200, '上课区域及地点').optional(),
  publicArea: trimmed(0, 100, '公开区域').optional(),
  weeklySchedule: trimmed(1, 300, '每周可上课时间').optional(),
  publicSchedule: trimmed(1, 300, '公开上课时间').optional(),
  sessionsPerWeek: z.number().int().min(1).max(28).optional(),
  sessionMinutes: z.number().int().min(15).max(600).optional(),
  expectedStartDate: isoDate,
  hourlyPayCents: z.number().int().gt(0).optional(),
  payNegotiable: z.boolean().optional(),
  genderPreference: z.enum(['any', 'male', 'female']).optional(),
  teacherRequirements: patchText(1000, '老师要求'),
  publicRequirements: patchText(1000, '公开老师要求'),
  notes: patchText(2000, '内部备注'),
}).strip();

export const applicationCreateSchema = z
  .object({
    teacherName: trimmed(1, 60, '姓名'),
    gender: z.enum(['male', 'female'], { message: '性别必须是男或女' }),
    wechat: wechatSchema,
    phone: phoneSchema,
    university: trimmed(1, 100, '就读学校'),
    major: trimmed(1, 100, '专业'),
    studyYear: trimmed(1, 30, '当前年级'),
    teachableSubjectsGrades: trimmed(1, 300, '可辅导的科目及年级'),
    achievements: optionalText(2000, '成绩能力说明'),
    teachingExperience: trimmed(1, 2000, '教学经验（没有经验填“暂无”）'),
    strengthsAndPlan: trimmed(1, 2000, '优势与辅导思路'),
    availableSchedule: trimmed(1, 300, '可上课时间'),
    earliestStartDate: isoDate,
    acceptsOrderPay: z.boolean({ message: '是否接受订单薪资必填' }),
    expectedHourlyPayCents: z.number().int().gt(0).nullable().optional(),
    canAttendTrial: z.boolean({ message: '是否可试课必填' }),
    trialConstraints: optionalText(500, '试课时间限制'),
    notes: optionalText(2000, '内部备注'),
    sourceTemplateText: z.string().max(LIMITS.maxTemplateTextChars).nullable().optional(),
    creationRequestId: z.string().uuid().nullable().optional(),
  })
  .strip()
  .refine(
    (v) => v.acceptsOrderPay ? (v.expectedHourlyPayCents ?? null) === null : typeof v.expectedHourlyPayCents === 'number' && v.expectedHourlyPayCents > 0,
    { message: '不接受订单薪资时必须填写正数期望薪资；接受时不要填期望薪资', path: ['expectedHourlyPayCents'] },
  );

export const applicationUpdateSchema = z.object({
  teacherName: trimmed(1, 60, '姓名').optional(),
  gender: z.enum(['male', 'female']).optional(),
  wechat: wechatSchema.optional(),
  phone: phoneSchema.optional(),
  university: trimmed(1, 100, '就读学校').optional(),
  major: trimmed(1, 100, '专业').optional(),
  studyYear: trimmed(1, 30, '当前年级').optional(),
  teachableSubjectsGrades: trimmed(1, 300, '可辅导的科目及年级').optional(),
  achievements: patchText(2000, '成绩能力说明'),
  teachingExperience: trimmed(1, 2000, '教学经验').optional(),
  strengthsAndPlan: trimmed(1, 2000, '优势与辅导思路').optional(),
  availableSchedule: trimmed(1, 300, '可上课时间').optional(),
  earliestStartDate: isoDate,
  acceptsOrderPay: z.boolean().optional(),
  expectedHourlyPayCents: z.number().int().gt(0).nullable().optional(),
  canAttendTrial: z.boolean().optional(),
  trialConstraints: patchText(500, '试课时间限制'),
  notes: patchText(2000, '内部备注'),
}).strip();

export const parseImportSchema = z.object({
  kind: z.enum(['parent', 'teacher']),
  text: z.string().min(1, '粘贴内容为空').max(LIMITS.maxTemplateTextChars, `粘贴内容超过${LIMITS.maxTemplateTextChars}字上限`),
  contextOrderId: z.number().int().nullable().optional(),
});

export const orderActionSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'complete', 'start-trial']),
  version: z.number().int(),
  target: z.string().optional(),
});

export const applicationActionSchema = z.object({
  action: z.enum(['recommend', 'schedule-trial', 'pass', 'fail', 'withdraw', 'confirm-cooperation', 'direct-cooperation']),
  version: z.number().int(),
  orderVersion: z.number().int().optional(),
  target: z.enum(['reviewing', 'recruiting']).optional(),
  confirmCooperation: z.boolean().optional(),
});

export const financeSchema = z.object({
  type: z.enum(['set-fees', 'receive-deposit', 'refund-deposit', 'receive-supplement', 'refund-supplement']),
  operationId: z.string().uuid('缺少幂等操作ID'),
  version: z.number().int(),
  amountCents: z.number().int().optional(),
  agencyFeeCents: z.number().int().optional(),
  depositDueCents: z.number().int().optional(),
});

export const financeCorrectionSchema = z.object({
  operationId: z.string().uuid('缺少幂等操作ID'),
  version: z.number().int(),
  reason: z.string().transform((s) => s.trim()).pipe(z.string().min(1, '更正理由必填').max(500)),
  corrected: z.object({
    agencyFeeCents: z.number().int().min(0).nullable().optional(),
    depositDueCents: z.number().int().min(0).nullable().optional(),
    depositReceivedCents: z.number().int().min(0).optional(),
    depositRefundedCents: z.number().int().min(0).optional(),
    feeSupplementReceivedCents: z.number().int().min(0).optional(),
    feeSupplementRefundedCents: z.number().int().min(0).optional(),
  }),
});

export const recommendationsSchema = z.object({
  mode: z.enum(['summary', 'mark-recommended']),
  applicationIds: z.array(z.number().int()).min(1, '请至少选择一位候选'),
});

export const backupSettingsSchema = z.object({
  dailyBackupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '每日备份时间须为HH:mm（00:00—23:59）').optional(),
  dailyKeepCount: z.literal(5).optional(),
  autoBackupDir: z.string().min(1).nullable().optional(),
  importMaxUploadBytes: z.number().int().min(1024 * 1024).optional(),
  importMaxTotalBytes: z.number().int().min(1024 * 1024).optional(),
  importMaxEntries: z.number().int().min(100).optional(),
});
