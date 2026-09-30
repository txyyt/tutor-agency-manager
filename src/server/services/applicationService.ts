// 报名业务：创建/修改/受控状态动作/财务收退（幂等）/更正登记。
import type { DatabaseSync } from 'node:sqlite';
import { hkCompactDateString } from '../../shared/datetime.js';
import {
  type ApplicationRecord,
  type FinanceOperationRecord,
  type OrderRecord,
} from '../../shared/types.js';
import type { Repository } from '../repository.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { tx } from '../transaction.js';
import type { Clock } from '../clock.js';

 
type Row = Record<string, any>;

export interface ApplicationDeps {
  db: DatabaseSync;
  repo: Repository;
  clock: Clock;
  bumpHighWater: (table: 'orders' | 'applications', id: number) => void;
}

const WITHDRAWABLE_STATUSES = ['submitted', 'recommended', 'awaiting_trial', 'trial_passed', 'direct_cooperation'];

/** 键排序的稳定JSON，用于财务操作载荷的幂等比较 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class ApplicationService {
  constructor(private deps: ApplicationDeps) {}

  private nowIso(): string {
    return this.deps.clock.iso();
  }

  createApplication(
    orderId: number,
    input: Record<string, unknown>,
    opts: { sourceTemplateText?: string | null; creationRequestId?: string | null },
  ): { application: ApplicationRecord; order: OrderRecord; duplicated: boolean; duplicateWarning: string | null } {
    const now = this.nowIso();
    return tx(this.deps.db, () => {
      const order = this.deps.repo.getOrderById(orderId);
      if (!order) throw notFound(`订单不存在（id=${orderId}）`);
      if (!['recruiting', 'reviewing', 'awaiting_trial', 'trialing'].includes(order.status)) {
        throw conflict(
          'ORDER_NOT_ACCEPTING',
          `订单当前状态为“${order.status}”，不能接收新报名（招募中/家长挑选中/待试课/试课中才可报名）`,
        );
      }
      if (opts.creationRequestId) {
        const existing = this.deps.db
          .prepare('SELECT id FROM applications WHERE creation_request_id = ?')
          .get(opts.creationRequestId) as { id: number } | undefined;
        if (existing) {
          const application = this.deps.repo.getApplicationById(existing.id)!;
          return { application, order, duplicated: true, duplicateWarning: null };
        }
      }
      const info = this.deps.db
        .prepare(
          `INSERT INTO applications (
            application_no, order_id, teacher_name, gender, wechat, phone,
            university, major, study_year, teachable_subjects_grades, achievements,
            teaching_experience, strengths_and_plan, available_schedule, earliest_start_date,
            accepts_order_pay, expected_hourly_pay_cents, can_attend_trial, trial_constraints, notes,
            attachments_json, status, created_at, updated_at, version,
            source_template_text, creation_request_id, finance_operations_json
          ) VALUES (
            '', @orderId, @teacherName, @gender, @wechat, @phone,
            @university, @major, @studyYear, @teachableSubjectsGrades, @achievements,
            @teachingExperience, @strengthsAndPlan, @availableSchedule, @earliestStartDate,
            @acceptsOrderPay, @expectedHourlyPayCents, @canAttendTrial, @trialConstraints, @notes,
            '[]', 'submitted', @createdAt, @createdAt, 1,
            @sourceTemplateText, @creationRequestId, '[]'
          )`,
        )
        .run({
          orderId,
          teacherName: input.teacherName,
          gender: input.gender,
          wechat: input.wechat,
          phone: input.phone,
          university: input.university,
          major: input.major,
          studyYear: input.studyYear,
          teachableSubjectsGrades: input.teachableSubjectsGrades,
          achievements: input.achievements ?? '',
          teachingExperience: input.teachingExperience,
          strengthsAndPlan: input.strengthsAndPlan,
          availableSchedule: input.availableSchedule,
          earliestStartDate: input.earliestStartDate ?? null,
          acceptsOrderPay: input.acceptsOrderPay ? 1 : 0,
          expectedHourlyPayCents: input.expectedHourlyPayCents ?? null,
          canAttendTrial: input.canAttendTrial ? 1 : 0,
          trialConstraints: input.trialConstraints ?? '',
          notes: input.notes ?? '',
          createdAt: now,
          sourceTemplateText: opts.sourceTemplateText ?? null,
          creationRequestId: opts.creationRequestId ?? null,
        } as Row);
      const id = Number(info.lastInsertRowid);
      const applicationNo = `BM-${hkCompactDateString(now)}-${String(id).padStart(4, '0')}`;
      this.deps.db.prepare('UPDATE applications SET application_no = ? WHERE id = ?').run(applicationNo, id);
      this.deps.bumpHighWater('applications', id);
      let duplicateWarning: string | null = null;
      if (opts.sourceTemplateText) {
        const dup = this.deps.db
          .prepare(
            'SELECT application_no FROM applications WHERE source_template_text = ? AND order_id = ? AND id != ? LIMIT 1',
          )
          .get(opts.sourceTemplateText, orderId, id) as { application_no: string } | undefined;
        if (dup) duplicateWarning = `本订单已存在相同原文的报名 ${dup.application_no}，请确认是否重复投递`;
      }
      const application = this.deps.repo.getApplicationById(id)!;
      return { application, order, duplicated: false, duplicateWarning };
    });
  }

  getApplication(id: number): ApplicationRecord {
    const app = this.deps.repo.getApplicationById(id);
    if (!app) throw notFound(`报名不存在（id=${id}）`);
    return app;
  }

  updateGeneral(id: number, patch: Record<string, unknown>, version: number): { application: ApplicationRecord; changed: boolean } {
    return tx(this.deps.db, () => {
      const app = this.getApplication(id);
      if (app.version !== version) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const acceptsPay = patch.acceptsOrderPay ?? app.acceptsOrderPay;
      const expectedPay = patch.expectedHourlyPayCents === undefined ? app.expectedHourlyPayCents : patch.expectedHourlyPayCents;
      if (acceptsPay ? expectedPay !== null : typeof expectedPay !== 'number' || expectedPay <= 0) {
        throw badRequest('VALIDATION_FAILED', '请核对是否接受订单薪资及期望薪资', {
          expectedHourlyPayCents: '接受订单薪资时应清空期望薪资；不接受时必须填写正数期望薪资',
        });
      }
      const columnByField: Record<string, string> = {
        teacherName: 'teacher_name', gender: 'gender', wechat: 'wechat', phone: 'phone',
        university: 'university', major: 'major', studyYear: 'study_year',
        teachableSubjectsGrades: 'teachable_subjects_grades', achievements: 'achievements',
        teachingExperience: 'teaching_experience', strengthsAndPlan: 'strengths_and_plan',
        availableSchedule: 'available_schedule', earliestStartDate: 'earliest_start_date',
        acceptsOrderPay: 'accepts_order_pay', expectedHourlyPayCents: 'expected_hourly_pay_cents',
        canAttendTrial: 'can_attend_trial', trialConstraints: 'trial_constraints', notes: 'notes',
      };
      const sets: string[] = [];
       
      const params: any[] = [];
      for (const [field, column] of Object.entries(columnByField)) {
        if (!(field in patch)) continue;
        const next = patch[field];
        if (next === undefined) continue;
        const current = app[field as keyof ApplicationRecord];
        const nextNorm = typeof next === 'boolean' ? (next ? 1 : 0) : next;
        if (current === next) continue;
        sets.push(`${column} = ?`);
        params.push(nextNorm);
      }
      if (sets.length === 0) return { application: app, changed: false };
      sets.push('updated_at = ?', 'version = version + 1');
      params.push(this.nowIso());
      this.deps.db
        .prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
        .run(...params, id, version);
      return { application: this.getApplication(id), changed: true };
    });
  }

  applicationAction(
    id: number,
    action: string,
    payload: Record<string, unknown>,
    appVersion: number,
  ): { application: ApplicationRecord; order: OrderRecord; message: string } {
    return tx(this.deps.db, () => {
      const app = this.getApplication(id);
      if (app.version !== appVersion) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const order = this.deps.repo.getOrderById(app.orderId);
      if (!order) throw notFound('所属订单不存在');
      const orderVersion = payload.orderVersion;
      const requiresOrderVersion = ['schedule-trial', 'pass', 'fail', 'withdraw', 'confirm-cooperation', 'direct-cooperation'];
      if (requiresOrderVersion.includes(action)) {
        if (typeof orderVersion !== 'number' || order.version !== orderVersion) {
          throw conflict('VERSION_CONFLICT', '订单状态已变化，请刷新后重试');
        }
      }
      const now = this.nowIso();
      switch (action) {
        case 'recommend': {
          if (app.status === 'recommended') {
            return { application: app, order, message: '该报名已推荐，无变化' };
          }
          if (app.status !== 'submitted') {
            throw conflict('STATE_CONFLICT', `只有“已报名”才能标为已推荐（当前：${app.status}）。不能把待试课/通过/终止记录降回推荐`);
          }
          this.updateAppRow(app.id, { status: 'recommended' }, now);
          break;
        }
        case 'schedule-trial': {
          if (order.currentApplicationId !== null) {
            throw conflict('CURRENT_EXISTS', '已有当前试课老师，每单同时只能安排一位。请先处理当前老师');
          }
          if (!['recruiting', 'reviewing'].includes(order.status)) {
            throw conflict('STATE_CONFLICT', `订单状态“${order.status}”不能安排试课（需招募中或家长挑选中）`);
          }
          if (!['submitted', 'recommended'].includes(app.status)) {
            throw conflict('STATE_CONFLICT', `只有“已报名/已推荐”可安排试课（当前：${app.status}）`);
          }
          this.updateAppRow(app.id, { status: 'awaiting_trial', trialAt: now }, now);
          this.updateOrderRow(order.id, { status: 'awaiting_trial', currentApplicationId: app.id }, now);
          break;
        }
        case 'pass': {
          if (order.status !== 'trialing') throw conflict('STATE_CONFLICT', `订单不在“试课中”（当前：${order.status}），不能标记试课结果`);
          if (order.currentApplicationId !== app.id) throw conflict('STATE_CONFLICT', '只能对当前试课老师登记试课结果');
          if (app.status !== 'awaiting_trial') throw conflict('STATE_CONFLICT', `报名不是“待试课”（当前：${app.status}）`);
          if (payload.confirmCooperation === true) {
            this.updateAppRow(app.id, { status: 'trial_passed', cooperationConfirmedAt: now }, now);
          } else {
            this.updateAppRow(app.id, { status: 'trial_passed' }, now);
          }
          // 通过后订单回到家长挑选中：显示“试课通过，待确认/待结算”，保留当前引用
          this.updateOrderRow(order.id, { status: 'reviewing' }, now);
          break;
        }
        case 'fail': {
          if (order.status !== 'trialing') throw conflict('STATE_CONFLICT', `订单不在“试课中”（当前：${order.status}）`);
          if (order.currentApplicationId !== app.id) throw conflict('STATE_CONFLICT', '只能对当前试课老师登记试课结果');
          if (app.status !== 'awaiting_trial') throw conflict('STATE_CONFLICT', `报名不是“待试课”（当前：${app.status}）`);
          const target = payload.target === 'recruiting' ? 'recruiting' : 'reviewing';
          this.updateAppRow(app.id, { status: 'trial_failed' }, now);
          this.updateOrderRow(order.id, { status: target, currentApplicationId: null }, now);
          break;
        }
        case 'withdraw': {
          if (order.status === 'completed') throw conflict('STATE_CONFLICT', '订单已完成，不能登记退出（后续授课不在本系统范围）');
          if (!WITHDRAWABLE_STATUSES.includes(app.status)) {
            throw conflict('STATE_CONFLICT', `报名状态“${app.status}”不能退出（终止报名不能重新激活，重新投递请新建报名）`);
          }
          const isCurrent = order.currentApplicationId === app.id;
          this.updateAppRow(app.id, { status: 'withdrawn' }, now);
          if (isCurrent) {
            const target = payload.target === 'recruiting' ? 'recruiting' : 'reviewing';
            const nextStatus = ['awaiting_trial', 'trialing'].includes(order.status) ? target : order.status;
            this.updateOrderRow(order.id, { currentApplicationId: null, status: nextStatus }, now);
          }
          break;
        }
        case 'confirm-cooperation': {
          if (order.currentApplicationId !== app.id) throw conflict('STATE_CONFLICT', '只能确认当前报名的合作');
          if (app.status !== 'trial_passed') throw conflict('STATE_CONFLICT', `只有“试课通过”的报名可确认合作（当前：${app.status}）`);
          if (app.cooperationConfirmedAt) return { application: app, order, message: '已确认合作，无变化' };
          if (order.status !== 'reviewing') throw conflict('STATE_CONFLICT', `订单状态“${order.status}”不能确认合作`);
          this.updateAppRow(app.id, { cooperationConfirmedAt: now }, now);
          break;
        }
        case 'direct-cooperation': {
          if (!['recruiting', 'reviewing'].includes(order.status)) {
            throw conflict('STATE_CONFLICT', `订单状态“${order.status}”不能直接合作（需招募中或家长挑选中）`);
          }
          if (order.currentApplicationId !== null) {
            throw conflict('CURRENT_EXISTS', '已有当前试课/待结算老师，不能重复直接合作');
          }
          if (!['submitted', 'recommended'].includes(app.status)) {
            throw conflict('STATE_CONFLICT', `只有“已报名/已推荐”可直接合作（当前：${app.status}）`);
          }
          this.updateAppRow(app.id, { status: 'direct_cooperation', cooperationConfirmedAt: now }, now);
          this.updateOrderRow(order.id, { status: 'reviewing', currentApplicationId: app.id }, now);
          break;
        }
        default:
          throw conflict('UNKNOWN_ACTION', `未知的报名动作：${action}`);
      }
      return { application: this.getApplication(id), order: this.deps.repo.getOrderById(app.orderId)!, message: '操作成功' };
    });
  }

  // ---------------- 财务 ----------------

  private financeSnapshot(app: ApplicationRecord): Record<string, number | null> {
    return {
      agencyFeeCents: app.agencyFeeCents,
      depositDueCents: app.depositDueCents,
      depositReceivedCents: app.depositReceivedCents,
      depositRefundedCents: app.depositRefundedCents,
      feeSupplementReceivedCents: app.feeSupplementReceivedCents,
      feeSupplementRefundedCents: app.feeSupplementRefundedCents,
    };
  }

  /**
   * 幂等入口：相同 operationId+相同载荷 → 返回原结果（applied=false，不重复加钱）；
   * 相同 operationId+不同载荷 → 拒绝。
   */
  financeOperation(
    id: number,
    body: {
      type: 'set-fees' | 'receive-deposit' | 'refund-deposit' | 'receive-supplement' | 'refund-supplement';
      operationId: string;
      amountCents?: number;
      agencyFeeCents?: number;
      depositDueCents?: number;
    },
    version: number,
  ): { application: ApplicationRecord; applied: boolean; message: string } {
    return tx(this.deps.db, () => {
      const app = this.getApplication(id);
      const order = this.deps.repo.getOrderById(app.orderId)!;
      const incomingPayload = {
        type: body.type,
        amountCents: body.amountCents,
        agencyFeeCents: body.agencyFeeCents,
        depositDueCents: body.depositDueCents,
      };
      // 幂等检查先于版本检查：超时重试携带旧version也必须安全重放，不重复加钱
      const existing = app.financeOperations.find((o) => o.operationId === body.operationId);
      if (existing) {
        const samePayload = canonicalJson(existing.payload) === canonicalJson(incomingPayload);
        if (samePayload) {
          return {
            application: app,
            applied: false,
            message: '该操作已执行过（幂等重放），未重复登记',
          };
        }
        throw conflict('OPERATION_ID_CONFLICT', '该操作ID已用于不同的财务操作，请刷新后使用新的操作ID');
      }
      if (app.version !== version) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const now = this.nowIso();
      const before = this.financeSnapshot(app);
      let updates: Record<string, unknown>;
      let message: string;

      switch (body.type) {
        case 'set-fees': {
          if (order.status === 'completed') throw conflict('FINANCE_LOCKED', '订单已完成，费用已锁定');
          if (order.status === 'cancelled') throw conflict('FINANCE_LOCKED', '订单已取消，只能退款或带理由更正，不能重新设定收费');
          const fee = body.agencyFeeCents;
          const due = body.depositDueCents;
          if (typeof fee !== 'number' || !Number.isInteger(fee) || fee < 0) {
            throw conflict('INVALID_AMOUNT', '应收中介费必须是不小于0的整数分');
          }
          if (typeof due !== 'number' || !Number.isInteger(due) || due < 0) {
            throw conflict('INVALID_AMOUNT', '计划保证金必须是不小于0的整数分');
          }
          if (due > fee) throw conflict('INVALID_AMOUNT', '计划保证金不能超过应收中介费');
          updates = { agencyFeeCents: fee, depositDueCents: due };
          message =
            fee === 0
              ? '已设定为免费个案（中介费0元、保证金0元）'
              : `已设定中介费 ${(fee / 100).toFixed(2)} 元、计划保证金 ${(due / 100).toFixed(2)} 元`;
          break;
        }
        case 'receive-deposit': {
          if (order.status === 'completed' || order.status === 'cancelled') {
            throw conflict('FINANCE_LOCKED', '订单已结束，禁止继续收款，只能退款');
          }
          if (order.status !== 'awaiting_trial') {
            throw conflict('STATE_CONFLICT', '新收保证金只允许“待试课”订单（未开始试课）的当前报名');
          }
          if (order.currentApplicationId !== app.id) {
            throw conflict('STATE_CONFLICT', '只能对当前试课老师收保证金，其他候选不提前收费');
          }
          if (app.status !== 'awaiting_trial') {
            throw conflict('STATE_CONFLICT', `报名不是“待试课”（当前：${app.status}）`);
          }
          if (app.agencyFeeCents === null || app.depositDueCents === null) {
            throw conflict('FEES_NOT_SET', '收保证金前必须先设定应收中介费和计划保证金');
          }
          const amount = this.requireAmount(body.amountCents);
          const net = app.depositReceivedCents - app.depositRefundedCents;
          if (net + amount > app.depositDueCents) {
            throw conflict(
              'AMOUNT_EXCEEDS_PLAN',
              `实收保证金净额 ${(net / 100).toFixed(2)} 元 + 本次 ${(amount / 100).toFixed(2)} 元将超过计划保证金 ${(app.depositDueCents / 100).toFixed(2)} 元。允许分次登记，但不得超过当时计划值`,
            );
          }
          updates = { depositReceivedCents: app.depositReceivedCents + amount, depositReceivedAt: now };
          message = `已登记收到保证金 ${(amount / 100).toFixed(2)} 元`;
          break;
        }
        case 'refund-deposit': {
          if (order.status === 'completed') throw conflict('FINANCE_LOCKED', '订单已完成，费用已锁定');
          const amount = this.requireAmount(body.amountCents);
          const net = app.depositReceivedCents - app.depositRefundedCents;
          if (net <= 0) throw conflict('NOTHING_TO_REFUND', '保证金净收为0，无可退金额');
          if (amount > net) throw conflict('AMOUNT_EXCEEDS_RECEIVED', `退款金额不能超过保证金净收 ${(net / 100).toFixed(2)} 元`);
          // 正常持有期（待试课/试课中且无超收）不允许退保证金
          const totalNet = net + app.feeSupplementReceivedCents - app.feeSupplementRefundedCents;
          const overReceived = app.agencyFeeCents !== null && totalNet > app.agencyFeeCents;
          if (
            order.currentApplicationId === app.id &&
            ['awaiting_trial', 'trialing'].includes(order.status) &&
            !overReceived
          ) {
            throw conflict('STATE_CONFLICT', '试课进行中不能退保证金；如老师退出或试课失败，请先登记对应状态');
          }
          updates = { depositRefundedCents: app.depositRefundedCents + amount, depositRefundedAt: now };
          message = `已登记退回保证金 ${(amount / 100).toFixed(2)} 元`;
          break;
        }
        case 'receive-supplement': {
          if (order.status === 'completed' || order.status === 'cancelled') {
            throw conflict('FINANCE_LOCKED', '订单已结束，禁止继续收款，只能退款');
          }
          if (order.currentApplicationId !== app.id || !['trial_passed', 'direct_cooperation'].includes(app.status)) {
            throw conflict('STATE_CONFLICT', '补收中介费只允许确认合作后的当前报名');
          }
          if (!app.cooperationConfirmedAt) {
            throw conflict('COOPERATION_NOT_CONFIRMED', '尚未确认合作，只能显示保证金已收，不能提前补款');
          }
          if (order.status !== 'reviewing') {
            throw conflict('STATE_CONFLICT', `订单状态“${order.status}”不能补款`);
          }
          if (app.agencyFeeCents === null) throw conflict('FEES_NOT_SET', '尚未设定应收中介费，不能补款');
          const amount = this.requireAmount(body.amountCents);
          const net = app.depositReceivedCents - app.depositRefundedCents
            + app.feeSupplementReceivedCents - app.feeSupplementRefundedCents;
          const pending = app.agencyFeeCents - net;
          if (pending <= 0) throw conflict('NOTHING_TO_RECEIVE', '费用已结清或超收，无需补款');
          if (amount > pending) {
            throw conflict('AMOUNT_EXCEEDS_DUE', `补款不能超过待补金额 ${(pending / 100).toFixed(2)} 元`);
          }
          updates = { feeSupplementReceivedCents: app.feeSupplementReceivedCents + amount, feeSupplementReceivedAt: now };
          message = `已登记收到补款 ${(amount / 100).toFixed(2)} 元`;
          break;
        }
        case 'refund-supplement': {
          if (order.status === 'completed') throw conflict('FINANCE_LOCKED', '订单已完成，费用已锁定');
          const amount = this.requireAmount(body.amountCents);
          const net = app.feeSupplementReceivedCents - app.feeSupplementRefundedCents;
          if (net <= 0) throw conflict('NOTHING_TO_REFUND', '补款净收为0，无可退金额');
          if (amount > net) throw conflict('AMOUNT_EXCEEDS_RECEIVED', `退款金额不能超过补款净收 ${(net / 100).toFixed(2)} 元`);
          updates = { feeSupplementRefundedCents: app.feeSupplementRefundedCents + amount, feeSupplementRefundedAt: now };
          message = `已登记退回补款 ${(amount / 100).toFixed(2)} 元`;
          break;
        }
        default:
          throw conflict('UNKNOWN_ACTION', `未知财务操作：${(body as { type: string }).type}`);
      }

      const updated = this.applyFinanceUpdate(app, updates, now);
      const after = this.financeSnapshot(updated);
      const record: FinanceOperationRecord = {
        operationId: body.operationId,
        type: body.type,
        payload: incomingPayload,
        before,
        after,
        applied: true,
        at: now,
      };
      this.appendFinanceRecord(updated.id, record);
      return { application: this.getApplication(id), applied: true, message };
    });
  }

  /** 带理由的更正登记：只在未完成订单允许；记录前后值与理由，不伪造退款 */
  financeCorrection(
    id: number,
    body: {
      operationId: string;
      reason: string;
      corrected: {
        agencyFeeCents?: number | null;
        depositDueCents?: number | null;
        depositReceivedCents?: number;
        depositRefundedCents?: number;
        feeSupplementReceivedCents?: number;
        feeSupplementRefundedCents?: number;
      };
    },
    version: number,
  ): { application: ApplicationRecord; applied: boolean; message: string } {
    return tx(this.deps.db, () => {
      const app = this.getApplication(id);
      const order = this.deps.repo.getOrderById(app.orderId)!;
      if (order.status === 'completed') throw conflict('FINANCE_LOCKED', '订单已完成，费用已锁定');
      const incomingPayload = { type: 'correction' as const, reason: body.reason, corrected: body.corrected };
      // 幂等检查先于版本检查（同上）
      const existing = app.financeOperations.find((o) => o.operationId === body.operationId);
      if (existing) {
        const samePayload = canonicalJson(existing.payload) === canonicalJson(incomingPayload);
        if (samePayload) {
          return { application: app, applied: false, message: '该更正已执行过（幂等重放），未重复登记' };
        }
        throw conflict('OPERATION_ID_CONFLICT', '该操作ID已用于不同的财务操作，请刷新后使用新的操作ID');
      }
      if (app.version !== version) throw conflict('VERSION_CONFLICT', '报名已被他人修改，请刷新后重试');
      const corrected = body.corrected ?? {};
      const next = {
        agencyFeeCents: corrected.agencyFeeCents ?? app.agencyFeeCents,
        depositDueCents: corrected.depositDueCents ?? app.depositDueCents,
        depositReceivedCents: corrected.depositReceivedCents ?? app.depositReceivedCents,
        depositRefundedCents: corrected.depositRefundedCents ?? app.depositRefundedCents,
        feeSupplementReceivedCents: corrected.feeSupplementReceivedCents ?? app.feeSupplementReceivedCents,
        feeSupplementRefundedCents: corrected.feeSupplementRefundedCents ?? app.feeSupplementRefundedCents,
      };
      const checks: Array<[string, number | null, number | null, number | null]> = [
        ['agencyFeeCents', next.agencyFeeCents, 0, null],
        ['depositDueCents', next.depositDueCents, 0, null],
        ['depositReceivedCents', next.depositReceivedCents, 0, null],
        ['depositRefundedCents', next.depositRefundedCents, 0, next.depositReceivedCents],
        ['feeSupplementReceivedCents', next.feeSupplementReceivedCents, 0, null],
        ['feeSupplementRefundedCents', next.feeSupplementRefundedCents, 0, next.feeSupplementReceivedCents],
      ];
      for (const [name, value, min, max] of checks) {
        if (value === null) continue;
        if (!Number.isInteger(value) || value < min!) {
          throw conflict('INVALID_AMOUNT', `更正后的 ${name} 必须是不小于${min! / 100}元的整数分`);
        }
        if (max !== null && value > max) {
          throw conflict('INVALID_AMOUNT', `更正后的累计退款不能超过累计收款（${name}）`);
        }
      }
      if (
        next.agencyFeeCents !== null &&
        next.depositDueCents !== null &&
        next.depositDueCents > next.agencyFeeCents
      ) {
        throw conflict('INVALID_AMOUNT', '更正后计划保证金不能超过应收中介费');
      }
      const changed = JSON.stringify(next) !== JSON.stringify(this.financeSnapshot(app));
      const now = this.nowIso();
      const before = this.financeSnapshot(app);
      const record: FinanceOperationRecord = {
        operationId: body.operationId,
        type: 'correction',
        payload: incomingPayload,
        reason: body.reason,
        before,
        after: next,
        applied: changed,
        at: now,
      };
      if (changed) {
        const updated = this.applyFinanceUpdate(app, next, now);
        this.appendFinanceRecord(updated.id, record);
        return { application: this.getApplication(id), applied: true, message: `更正已登记（理由：${body.reason}）` };
      }
      // 无实际变化也保留更正痕迹
      this.appendFinanceRecord(app.id, record);
      return { application: this.getApplication(id), applied: false, message: '更正内容与当前值相同，未修改数据' };
    });
  }

  private requireAmount(v: unknown): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw badRequest('INVALID_AMOUNT', '金额必须是不小于0.01元的整数分（不能为负数、0或带超过两位小数）');
    }
    return v;
  }

  private applyFinanceUpdate(app: ApplicationRecord, updates: Record<string, unknown>, now: string): ApplicationRecord {
    const columnByField: Record<string, string> = {
      agencyFeeCents: 'agency_fee_cents',
      depositDueCents: 'deposit_due_cents',
      depositReceivedCents: 'deposit_received_cents',
      depositReceivedAt: 'deposit_received_at',
      depositRefundedCents: 'deposit_refunded_cents',
      depositRefundedAt: 'deposit_refunded_at',
      feeSupplementReceivedCents: 'fee_supplement_received_cents',
      feeSupplementReceivedAt: 'fee_supplement_received_at',
      feeSupplementRefundedCents: 'fee_supplement_refunded_cents',
      feeSupplementRefundedAt: 'fee_supplement_refunded_at',
    };
    const sets: string[] = [];
     
    const params: any[] = [];
    for (const [field, value] of Object.entries(updates)) {
      const column = columnByField[field];
      if (!column) throw new Error(`未知财务字段：${field}`);
      sets.push(`${column} = ?`);
      params.push(value);
    }
    sets.push('updated_at = ?', 'version = version + 1');
    params.push(now);
    this.deps.db
      .prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, app.id);
    return this.getApplication(app.id);
  }

  private appendFinanceRecord(appId: number, record: FinanceOperationRecord): void {
    const app = this.getApplication(appId);
    const ops = [...app.financeOperations, record];
    this.deps.db
      .prepare('UPDATE applications SET finance_operations_json = ? WHERE id = ?')
      .run(JSON.stringify(ops), appId);
  }

  private updateAppRow(id: number, fields: Record<string, unknown>, now: string): void {
    const columnByField: Record<string, string> = {
      status: 'status',
      trialAt: 'trial_at',
      cooperationConfirmedAt: 'cooperation_confirmed_at',
    };
    const sets: string[] = ['updated_at = ?', 'version = version + 1'];
     
    const params: any[] = [now];
    for (const [field, value] of Object.entries(fields)) {
      const column = columnByField[field];
      if (!column) throw new Error(`未知的报名列：${field}`);
      sets.unshift(`${column} = ?`);
      params.unshift(value);
    }
    this.deps.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  private updateOrderRow(id: number, fields: Record<string, unknown>, now: string): void {
    const columnByField: Record<string, string> = {
      status: 'status',
      currentApplicationId: 'current_application_id',
    };
    const sets: string[] = ['updated_at = ?', 'version = version + 1'];
     
    const params: any[] = [now];
    for (const [field, value] of Object.entries(fields)) {
      const column = columnByField[field];
      if (!column) throw new Error(`未知的订单列：${field}`);
      sets.unshift(`${column} = ?`);
      params.unshift(value);
    }
    this.deps.db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }
}
