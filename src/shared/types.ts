// 全局共享类型与常量。金额一律整数分；时间戳一律UTC ISO字符串。

export type OrderStatus =
  | 'recruiting'
  | 'reviewing'
  | 'awaiting_trial'
  | 'trialing'
  | 'completed'
  | 'paused'
  | 'cancelled';

export type ApplicationStatus =
  | 'submitted'
  | 'recommended'
  | 'awaiting_trial'
  | 'trial_passed'
  | 'trial_failed'
  | 'withdrawn'
  | 'order_closed'
  | 'direct_cooperation';

export type TeachingMode = 'online' | 'offline';
export type GenderPreference = 'any' | 'male' | 'female';
export type TeacherGender = 'male' | 'female';

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  recruiting: '招募中',
  reviewing: '待结算', // 保留旧存储值兼容已有数据库，只用于合作后的结算
  awaiting_trial: '待试课',
  trialing: '试课中',
  completed: '已完成',
  paused: '暂停',
  cancelled: '已取消',
};

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  submitted: '已报名',
  recommended: '已推荐',
  awaiting_trial: '待试课',
  trial_passed: '试课通过',
  trial_failed: '试课未通过',
  withdrawn: '主动退出',
  order_closed: '订单已结束',
  direct_cooperation: '直接合作',
};

export const ORDER_ACTIVE_STATUSES: OrderStatus[] = [
  'recruiting',
  'reviewing',
  'awaiting_trial',
  'trialing',
  'paused',
];

// 报名中“有效候选”（未终止）状态：取消/完成时会被结束为 order_closed。
export const ACTIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  'submitted',
  'recommended',
  'awaiting_trial',
  'trial_passed',
  'direct_cooperation',
];

export const INDEPENDENT_CLEANABLE_APPLICATION_STATUSES: ApplicationStatus[] = [
  'trial_failed',
  'withdrawn',
  'order_closed',
];

export const DISPLAY_TIMEZONE = 'Asia/Hong_Kong';

export const LIMITS = {
  maxTemplateTextChars: 50_000,
  maxAttachmentsPerApplication: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  attachmentMimeTypes: ['application/pdf', 'image/jpeg', 'image/png'] as const,
  attachmentExtensions: { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' },
  defaultImportMaxUploadBytes: 1024 * 1024 * 1024,
  defaultImportMaxTotalBytes: 2 * 1024 * 1024 * 1024,
  defaultImportMaxEntries: 100_000,
  defaultDailyBackupsToKeep: 30,
  maxManualBackups: 10,
  maxSafetyBackups: 10,
  safetyBackupMaxAgeDays: 30,
  backupFormatVersion: 1,
  dbSchemaVersion: 2,
  restoreTokenTtlMs: 15 * 60 * 1000,
  cleanupDays: 90,
  cleanupIntervalMs: 24 * 60 * 60 * 1000,
  dailyBackupRetryMs: 5 * 60 * 1000,
} as const;

export interface AttachmentMeta {
  fileId: string;
  originalName: string;
  storagePath: string; // 相对活动代 attachments 目录
  size: number;
  mimeType: string;
  uploadedAt: string;
}

export interface FinanceOperationRecord {
  operationId: string;
  type:
    | 'set-fees'
    | 'receive-deposit'
    | 'refund-deposit'
    | 'receive-supplement'
    | 'refund-supplement'
    | 'correction'
    | 'workflow';
  payload: unknown;
  reason?: string;
  before: Record<string, number | null>;
  after: Record<string, number | null>;
  applied: boolean; // false 表示幂等重放
  at: string;
}

export interface OrderRecord {
  id: number;
  orderNo: string;
  parentName: string;
  parentWechat: string;
  parentPhone: string;
  childGrade: string;
  subjects: string;
  learningSituation: string;
  tutoringGoal: string;
  teachingMode: TeachingMode;
  locationDetail: string;
  publicArea: string;
  weeklySchedule: string;
  publicSchedule: string;
  sessionsPerWeek: number;
  sessionMinutes: number;
  expectedStartDate: string | null;
  hourlyPayCents: number;
  payNegotiable: boolean;
  genderPreference: GenderPreference;
  teacherRequirements: string;
  publicRequirements: string;
  notes: string;
  status: OrderStatus;
  pausedFromStatus: OrderStatus | null;
  currentApplicationId: number | null;
  matchedApplicationId: number | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  sourceTemplateText: string | null;
  creationRequestId: string | null;
}

export interface ApplicationRecord {
  id: number;
  applicationNo: string;
  orderId: number;
  teacherName: string;
  gender: TeacherGender;
  wechat: string;
  phone: string;
  university: string;
  major: string;
  studyYear: string;
  teachableSubjectsGrades: string;
  achievements: string;
  teachingExperience: string;
  strengthsAndPlan: string;
  availableSchedule: string;
  earliestStartDate: string | null;
  acceptsOrderPay: boolean;
  expectedHourlyPayCents: number | null;
  canAttendTrial: boolean;
  trialConstraints: string;
  notes: string;
  attachments: AttachmentMeta[];
  status: ApplicationStatus;
  trialAt: string | null;
  cooperationConfirmedAt: string | null;
  agencyFeeCents: number | null;
  depositDueCents: number | null;
  depositReceivedCents: number;
  depositReceivedAt: string | null;
  depositRefundedCents: number;
  depositRefundedAt: string | null;
  feeSupplementReceivedCents: number;
  feeSupplementReceivedAt: string | null;
  feeSupplementRefundedCents: number;
  feeSupplementRefundedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  sourceTemplateText: string | null;
  creationRequestId: string | null;
  financeOperations: FinanceOperationRecord[];
}

export interface FinanceState {
  agencyFeeCents: number | null;
  depositDueCents: number | null;
  depositReceivedCents: number;
  depositRefundedCents: number;
  feeSupplementReceivedCents: number;
  feeSupplementRefundedCents: number;
  depositNetCents: number;
  supplementNetCents: number;
  netReceivedCents: number;
  /** 待收保证金（当前报名尚未开始试课时） */
  pendingDepositCents: number | null;
  /** 确认合作后待补中介费 */
  pendingSupplementCents: number | null;
  /** 待退款（失败/退出/结束/取消，或下调费用后的超收） */
  pendingRefundCents: number;
  /** N == F 且 F 已设置 */
  settled: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
}

// ------- 备份 / 恢复 -------

export type BackupKind = 'daily' | 'manual' | 'pre-restore' | 'pre-cleanup' | 'pre-delete';

export interface BackupManifest {
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  kind: BackupKind;
  createdAtUtc: string;
  displayTimezone: string;
  counts: { orders: number; applications: number; attachments: number };
  numberHighWater: { orders: number; applications: number };
  files: Array<{ path: string; sha256: string; size: number }>;
}

export interface BackupIndexEntry {
  id: string;
  fileName: string;
  kind: BackupKind;
  dirPath: string;
  createdAtUtc: string;
  sizeBytes: number;
  sha256: string;
}

export interface BackupSettings {
  autoBackupDir: string | null; // null = 默认 data/backups/daily
  dailyKeepCount: number;
  dailyBackupTime: string; // HH:mm，Asia/Hong_Kong（北京时间）
  importMaxUploadBytes: number;
  importMaxTotalBytes: number;
  importMaxEntries: number;
}

export interface RestoreOperationState {
  opId: string;
  status: 'prepared' | 'committed' | 'aborted' | 'finished';
  targetGenerationId: string;
  sourceGenerationId: string;
  createdAtUtc: string;
  finishedAtUtc?: string;
}
