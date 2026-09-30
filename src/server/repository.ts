// 行映射与基础查询（node:sqlite 同步API）。
import type { DatabaseSync } from 'node:sqlite';
import type {
  ApplicationRecord,
  AttachmentMeta,
  FinanceOperationRecord,
  OrderRecord,
} from '../shared/types.js';

 
type Row = Record<string, any>;

function boolOf(v: unknown): boolean {
  return v === 1 || v === true;
}

export function rowToOrder(r: Row): OrderRecord {
  return {
    id: r.id,
    orderNo: r.order_no,
    parentName: r.parent_name,
    parentWechat: r.parent_wechat,
    parentPhone: r.parent_phone,
    childGrade: r.child_grade,
    subjects: r.subjects,
    learningSituation: r.learning_situation,
    tutoringGoal: r.tutoring_goal,
    teachingMode: r.teaching_mode,
    locationDetail: r.location_detail,
    publicArea: r.public_area,
    weeklySchedule: r.weekly_schedule,
    publicSchedule: r.public_schedule,
    sessionsPerWeek: r.sessions_per_week,
    sessionMinutes: r.session_minutes,
    expectedStartDate: r.expected_start_date ?? null,
    hourlyPayCents: r.hourly_pay_cents,
    payNegotiable: boolOf(r.pay_negotiable),
    genderPreference: r.gender_preference,
    teacherRequirements: r.teacher_requirements,
    publicRequirements: r.public_requirements,
    notes: r.notes,
    status: r.status,
    pausedFromStatus: r.paused_from_status ?? null,
    currentApplicationId: r.current_application_id ?? null,
    matchedApplicationId: r.matched_application_id ?? null,
    completedAt: r.completed_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
    sourceTemplateText: r.source_template_text ?? null,
    creationRequestId: r.creation_request_id ?? null,
  };
}

function parseAttachments(json: string): AttachmentMeta[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr as AttachmentMeta[]) : [];
  } catch {
    return [];
  }
}

function parseFinanceOps(json: string): FinanceOperationRecord[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr as FinanceOperationRecord[]) : [];
  } catch {
    return [];
  }
}

export function rowToApplication(r: Row): ApplicationRecord {
  return {
    id: r.id,
    applicationNo: r.application_no,
    orderId: r.order_id,
    teacherName: r.teacher_name,
    gender: r.gender,
    wechat: r.wechat,
    phone: r.phone,
    university: r.university,
    major: r.major,
    studyYear: r.study_year,
    teachableSubjectsGrades: r.teachable_subjects_grades,
    achievements: r.achievements,
    teachingExperience: r.teaching_experience,
    strengthsAndPlan: r.strengths_and_plan,
    availableSchedule: r.available_schedule,
    earliestStartDate: r.earliest_start_date ?? null,
    acceptsOrderPay: boolOf(r.accepts_order_pay),
    expectedHourlyPayCents: r.expected_hourly_pay_cents ?? null,
    canAttendTrial: boolOf(r.can_attend_trial),
    trialConstraints: r.trial_constraints,
    notes: r.notes,
    attachments: parseAttachments(r.attachments_json),
    status: r.status,
    trialAt: r.trial_at ?? null,
    cooperationConfirmedAt: r.cooperation_confirmed_at ?? null,
    agencyFeeCents: r.agency_fee_cents ?? null,
    depositDueCents: r.deposit_due_cents ?? null,
    depositReceivedCents: r.deposit_received_cents,
    depositReceivedAt: r.deposit_received_at ?? null,
    depositRefundedCents: r.deposit_refunded_cents,
    depositRefundedAt: r.deposit_refunded_at ?? null,
    feeSupplementReceivedCents: r.fee_supplement_received_cents,
    feeSupplementReceivedAt: r.fee_supplement_received_at ?? null,
    feeSupplementRefundedCents: r.fee_supplement_refunded_cents,
    feeSupplementRefundedAt: r.fee_supplement_refunded_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
    sourceTemplateText: r.source_template_text ?? null,
    creationRequestId: r.creation_request_id ?? null,
    financeOperations: parseFinanceOps(r.finance_operations_json),
  };
}

export class Repository {
  constructor(private db: DatabaseSync) {}

  getOrderById(id: number): OrderRecord | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToOrder(row) : null;
  }

  getOrderByNo(orderNo: string): OrderRecord | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE order_no = ?').get(orderNo) as Row | undefined;
    return row ? rowToOrder(row) : null;
  }

  getApplicationById(id: number): ApplicationRecord | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToApplication(row) : null;
  }

  getApplicationByNo(no: string): ApplicationRecord | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE application_no = ?').get(no) as Row | undefined;
    return row ? rowToApplication(row) : null;
  }

  listApplicationsOfOrder(orderId: number): ApplicationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM applications WHERE order_id = ? ORDER BY id ASC')
      .all(orderId) as Row[];
    return rows.map(rowToApplication);
  }

  maxOrderId(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM orders').get() as { m: number };
    return r.m;
  }

  maxApplicationId(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM applications').get() as { m: number };
    return r.m;
  }

  countOrders(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number };
    return r.c;
  }

  countApplications(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM applications').get() as { c: number };
    return r.c;
  }
}
