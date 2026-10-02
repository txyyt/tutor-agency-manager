// 订单业务：创建/查询/修改/受控状态动作/完成与取消事务/统计。
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVE_APPLICATION_STATUSES, type OrderRecord, type OrderStatus } from '../../shared/types.js';
import { hkCompactDateString } from '../../shared/datetime.js';
import { rowToOrder, type Repository } from '../repository.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { computeFinanceState, financeContextFor } from '../../shared/finance.js';
import { orderTasks, type OrderTask } from '../../shared/orderTasks.js';
import { tx } from '../transaction.js';
import { compareOrderNumbers } from '../orderNumbers.js';

export interface ServiceDeps {
  db: DatabaseSync;
  repo: Repository;
  clock: Clock;
  bumpHighWater: (table: 'orders' | 'applications', id: number) => void;
  reserveOrderSequence: (day: string) => number;
  onOrdersChanged?: () => void;
}

import type { Clock } from '../clock.js';

 
type Row = Record<string, any>;

export class OrderService {
  constructor(private deps: ServiceDeps) {}

  private nowIso(): string {
    return this.deps.clock.iso();
  }

  createOrder(
    input: Record<string, unknown>,
    opts: { sourceTemplateText?: string | null; creationRequestId?: string | null },
  ): { order: OrderRecord; duplicated: boolean; duplicateWarning: string | null } {
    const now = this.nowIso();
    return tx(this.deps.db, () => {
      if (opts.creationRequestId) {
        const existing = this.deps.db
          .prepare('SELECT id FROM orders WHERE creation_request_id = ?')
          .get(opts.creationRequestId) as { id: number } | undefined;
        if (existing) {
          const order = this.deps.repo.getOrderById(existing.id)!;
          return { order, duplicated: true, duplicateWarning: null };
        }
      }
      const info = this.deps.db
        .prepare(
          `INSERT INTO orders (
            order_no, parent_name, parent_wechat, parent_phone, child_grade, subjects,
            learning_situation, tutoring_goal, teaching_mode, location_detail, public_area,
            weekly_schedule, public_schedule, sessions_per_week, session_minutes,
            expected_start_date, hourly_pay_cents, pay_negotiable, gender_preference,
            teacher_requirements, public_requirements, notes, status,
            current_application_id, matched_application_id, created_at, updated_at, version,
            source_template_text, creation_request_id
          ) VALUES (
            '', @parentName, @parentWechat, @parentPhone, @childGrade, @subjects,
            @learningSituation, @tutoringGoal, @teachingMode, @locationDetail, @publicArea,
            @weeklySchedule, @publicSchedule, @sessionsPerWeek, @sessionMinutes,
            @expectedStartDate, @hourlyPayCents, @payNegotiable, @genderPreference,
            @teacherRequirements, @publicRequirements, @notes, 'recruiting',
            NULL, NULL, @createdAt, @createdAt, 1,
            @sourceTemplateText, @creationRequestId
          )`,
        )
        .run(this.bindOrder(input, now, opts));
      const id = Number(info.lastInsertRowid);
      const day = hkCompactDateString(now);
      const sequence = this.deps.reserveOrderSequence(day);
      const orderNo = `JJ-${day}-${String(sequence).padStart(4, '0')}`;
      this.deps.db.prepare('UPDATE orders SET order_no = ? WHERE id = ?').run(orderNo, id);
      this.deps.bumpHighWater('orders', id);
      let duplicateWarning: string | null = null;
      if (opts.sourceTemplateText) {
        const dup = this.deps.db
          .prepare(
            'SELECT order_no FROM orders WHERE source_template_text = ? AND id != ? LIMIT 1',
          )
          .get(opts.sourceTemplateText, id) as { order_no: string } | undefined;
        if (dup) duplicateWarning = `已存在相同原文的订单 ${dup.order_no}，请确认是否重复提交`;
      }
      const order = this.deps.repo.getOrderById(id)!;
      this.deps.onOrdersChanged?.();
      return { order, duplicated: false, duplicateWarning };
    });
  }

  private bindOrder(
    input: Record<string, unknown>,
    now: string,
    opts: { sourceTemplateText?: string | null; creationRequestId?: string | null },
  ): Row {
    return {
      parentName: input.parentName,
      parentWechat: input.parentWechat,
      parentPhone: input.parentPhone,
      childGrade: input.childGrade,
      subjects: input.subjects,
      learningSituation: input.learningSituation,
      tutoringGoal: input.tutoringGoal,
      teachingMode: input.teachingMode,
      locationDetail: input.locationDetail,
      publicArea: input.publicArea,
      weeklySchedule: input.weeklySchedule,
      publicSchedule: input.publicSchedule,
      sessionsPerWeek: input.sessionsPerWeek,
      sessionMinutes: input.sessionMinutes,
      expectedStartDate: input.expectedStartDate ?? null,
      hourlyPayCents: input.hourlyPayCents,
      payNegotiable: input.payNegotiable ? 1 : 0,
      genderPreference: input.genderPreference,
      teacherRequirements: input.teacherRequirements ?? '',
      publicRequirements: input.publicRequirements ?? '',
      notes: input.notes ?? '',
      createdAt: now,
      sourceTemplateText: opts.sourceTemplateText ?? null,
      creationRequestId: opts.creationRequestId ?? null,
    };
  }

  getOrder(id: number): OrderRecord {
    const order = this.deps.repo.getOrderById(id);
    if (!order) throw notFound(`订单不存在（id=${id}）`);
    return order;
  }

  getOrderByNoOrId(idOrNo: string): OrderRecord | null {
    if (/^\d+$/.test(idOrNo)) return this.deps.repo.getOrderById(Number(idOrNo));
    return this.deps.repo.getOrderByNo(idOrNo);
  }

  listOrders(query: {
    q?: string;
    status?: string;
    subject?: string;
    grade?: string;
    dateFrom?: string;
    dateTo?: string;
    needsAction?: boolean;
    sort?: 'updated-desc' | 'updated-asc' | 'number-desc' | 'number-asc';
    tasksFirst?: boolean;
    page: number;
    pageSize: number;
  }): { items: Array<OrderRecord & { tasks: OrderTask[]; lastActivityAt: string }>; total: number; page: number; pageSize: number } {
    // 列表显示、筛选与排序使用整单最新变动，不改写记录本身的更新时间。
    const activitySql = 'MAX(orders.updated_at, COALESCE((SELECT MAX(applications.updated_at) FROM applications WHERE applications.order_id = orders.id), orders.updated_at))';
    const where: string[] = [];
     
    const params: any[] = [];
    if (query.q) {
      where.push('(order_no LIKE ? OR parent_name LIKE ? OR parent_wechat LIKE ? OR parent_phone LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like, like);
    }
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.subject) {
      where.push('subjects LIKE ?');
      params.push(`%${query.subject}%`);
    }
    if (query.grade) {
      where.push('child_grade LIKE ?');
      params.push(`%${query.grade}%`);
    }
    if (query.dateFrom) {
      where.push(`date(${activitySql}, '+8 hours') >= date(?)`);
      params.push(query.dateFrom);
    }
    if (query.dateTo) {
      where.push(`date(${activitySql}, '+8 hours') <= date(?)`);
      params.push(query.dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    /* 所有筛选先计算待办，再分页，避免仅筛选当前页。 */
    const totalRow = this.deps.db
      .prepare(`SELECT COUNT(*) AS c FROM orders ${whereSql}`)
      .get(...params) as { c: number };
    const pageSize = Math.min(Math.max(query.pageSize, 1), 100);
    const page = Math.max(query.page, 1);
    const rows = this.deps.db
      .prepare(
        `SELECT orders.*, ${activitySql} AS last_activity_at FROM orders ${whereSql} ORDER BY updated_at DESC, id DESC`,
      )
      .all(...params) as Row[];
    const items = rows.map(row => {
      const order = rowToOrder(row);
      return { ...order, lastActivityAt: String(row.last_activity_at), tasks: orderTasks(order, this.deps.repo.listApplicationsOfOrder(order.id)) };
    }).filter(order => !query.needsAction || order.tasks.length > 0);
    items.sort((a, b) => {
      if (query.tasksFirst !== false) {
        const priority = Number(b.tasks.length > 0) - Number(a.tasks.length > 0);
        if (priority) return priority;
      }
      switch (query.sort) {
        case 'updated-asc': return a.lastActivityAt.localeCompare(b.lastActivityAt) || a.id - b.id;
        case 'number-asc': return compareOrderNumbers(a.orderNo, b.orderNo) || a.id - b.id;
        case 'number-desc': return compareOrderNumbers(b.orderNo, a.orderNo) || b.id - a.id;
        default: return b.lastActivityAt.localeCompare(a.lastActivityAt) || b.id - a.id;
      }
    });
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: query.needsAction ? items.length : totalRow.c,
      page,
      pageSize,
    };
  }

  updateGeneral(
    id: number,
    patch: Record<string, unknown>,
    version: number,
  ): { order: OrderRecord; changed: boolean } {
    return tx(this.deps.db, () => {
      const order = this.getOrder(id);
      if (order.version !== version) {
        throw conflict('VERSION_CONFLICT', '记录已被他人修改，请刷新后重试');
      }
      // 状态与引用字段不可通过该入口修改（防绕过业务校验）
      const columnByField: Record<string, string> = {
        parentName: 'parent_name', parentWechat: 'parent_wechat', parentPhone: 'parent_phone',
        childGrade: 'child_grade', subjects: 'subjects', learningSituation: 'learning_situation',
        tutoringGoal: 'tutoring_goal', teachingMode: 'teaching_mode', locationDetail: 'location_detail',
        publicArea: 'public_area', weeklySchedule: 'weekly_schedule', publicSchedule: 'public_schedule',
        sessionsPerWeek: 'sessions_per_week', sessionMinutes: 'session_minutes',
        expectedStartDate: 'expected_start_date', hourlyPayCents: 'hourly_pay_cents',
        payNegotiable: 'pay_negotiable', genderPreference: 'gender_preference',
        teacherRequirements: 'teacher_requirements', publicRequirements: 'public_requirements',
        notes: 'notes',
      };
      const merged = { ...order, ...patch };
      if (merged.teachingMode === 'online') patch = { ...patch, locationDetail: '线上', publicArea: '线上' };
      else if (!merged.publicArea.trim()) {
        throw badRequest('VALIDATION_FAILED', '请补填线下授课区域', {
          ...(!merged.publicArea.trim() ? { publicArea: '线下上课必须填写公开授课区域' } : {}),
        });
      }
      const sets: string[] = [];
       
      const params: any[] = [];
      for (const [field, column] of Object.entries(columnByField)) {
        if (!(field in patch)) continue;
        const next = patch[field];
        if (next === undefined) continue;
        const current = order[field as keyof OrderRecord];
        const nextNorm = typeof next === 'boolean' ? (next ? 1 : 0) : next;
        // 无变化保存不更新时间（防止无操作延期90天清理）
        if (current === next) continue;
        sets.push(`${column} = ?`);
        params.push(nextNorm);
      }
      if (sets.length === 0) {
        return { order, changed: false };
      }
      const now = this.nowIso();
      sets.push('updated_at = ?', 'version = version + 1');
      params.push(now);
      this.deps.db
        .prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
        .run(...params, id, version);
      this.deps.onOrdersChanged?.();
      return { order: this.getOrder(id), changed: true };
    });
  }

  /** 订单受控状态动作 */
  orderAction(
    id: number,
    action: string,
    payload: Record<string, unknown>,
    version: number,
  ): { order: OrderRecord; changedApplications: number; message: string } {
    return tx(this.deps.db, () => {
      const order = this.getOrder(id);
      if (order.version !== version) {
        throw conflict('VERSION_CONFLICT', '订单已被他人修改，请刷新后重试');
      }
      const now = this.nowIso();
      switch (action) {
        case 'pause': {
          this.assertStatus(order, ['recruiting'], '暂停');
          this.assertNotCurrentRef(order, '暂停');
          this.updateOrderRow(id, { status: 'paused', pausedFromStatus: order.status }, now);
          break;
        }
        case 'resume': {
          this.assertStatus(order, ['paused'], '恢复');
          const target = order.pausedFromStatus ?? 'recruiting';
          this.updateOrderRow(id, { status: target, pausedFromStatus: null }, now);
          break;
        }
        case 'cancel': {
          return this.cancelOrder(order, now);
        }
        case 'complete': {
          return this.completeOrder(order, now);
        }
        case 'start-trial': {
          this.assertStatus(order, ['awaiting_trial'], '开始试课');
          if (!order.currentApplicationId) {
            throw conflict('STATE_CONFLICT', '订单没有当前试课老师，无法开始试课');
          }
          const app = this.deps.repo.getApplicationById(order.currentApplicationId);
          if (!app || app.status !== 'awaiting_trial') {
            throw conflict('STATE_CONFLICT', '当前报名不是“待试课”状态，无法开始试课');
          }
          if (app.agencyFeeCents === null || app.depositDueCents === null) {
            throw conflict(
              'FEES_NOT_SET',
              '开始试课前必须先设定应收中介费和计划保证金（免费个案也要明确填写0）',
            );
          }
          const depositNet = app.depositReceivedCents - app.depositRefundedCents;
          if (depositNet < app.depositDueCents) {
            throw conflict(
              'DEPOSIT_INSUFFICIENT',
              `保证金未收齐：已收 ${(depositNet / 100).toFixed(2)} 元，计划 ${(app.depositDueCents / 100).toFixed(2)} 元，少收期间保持待试课`,
            );
          }
          this.updateOrderRow(id, { status: 'trialing' }, now);
          return { order: this.getOrder(id), changedApplications: 0, message: '试课已开始，等待试课结果' };
        }
        default:
          throw conflict('UNKNOWN_ACTION', `未知的订单动作：${action}`);
      }
      return { order: this.getOrder(id), changedApplications: 0, message: '操作成功' };
    });
  }

  private cancelOrder(
    order: OrderRecord,
    now: string,
  ): { order: OrderRecord; changedApplications: number; message: string } {
    this.assertNotStatus(order, ['completed'], '取消');
    // 未完成订单才能取消；清空当前引用；有效报名结束；已收款项进入待退（不假装已退）
    const apps = this.deps.repo.listApplicationsOfOrder(order.id);
    let changed = 0;
    for (const app of apps) {
      if (ACTIVE_APPLICATION_STATUSES.includes(app.status)) {
        this.deps.db
          .prepare('UPDATE applications SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
          .run('order_closed', now, app.id);
        changed++;
      }
    }
    this.updateOrderRow(order.id, { status: 'cancelled', cancelledAt: now, currentApplicationId: null }, now);
    return {
      order: this.getOrder(order.id),
      changedApplications: changed,
      message: '订单已取消。已收款项不会自动退款，请实际退款后逐条登记。',
    };
  }

  private completeOrder(
    order: OrderRecord,
    now: string,
  ): { order: OrderRecord; changedApplications: number; message: string } {
    this.assertNotStatus(order, ['completed', 'cancelled'], '完成');
    if (!order.currentApplicationId) {
      throw conflict('STATE_CONFLICT', '订单没有当前报名，无法完成');
    }
    const matched = this.deps.repo.getApplicationById(order.currentApplicationId);
    if (!matched) throw conflict('STATE_CONFLICT', '当前报名不存在');
    if (matched.status !== 'trial_passed' && matched.status !== 'direct_cooperation') {
      throw conflict('STATE_CONFLICT', '成交报名必须处于“试课通过”或“直接合作”状态');
    }
    if (!matched.cooperationConfirmedAt) {
      throw conflict('COOPERATION_NOT_CONFIRMED', '当前老师的合作确认记录缺失，请刷新并核对资料');
    }
    if (order.matchedApplicationId !== null && order.matchedApplicationId !== order.currentApplicationId) {
      throw conflict('STATE_CONFLICT', '成交报名引用与当前报名不一致，数据异常');
    }
    // 财务校验：成交报名净收恰好等于中介费；其他报名净收为0
    const apps = this.deps.repo.listApplicationsOfOrder(order.id);
    const errors: string[] = [];
    if (matched.agencyFeeCents === null) errors.push('成交报名尚未设定应收中介费');
    else {
      const net = matched.depositReceivedCents - matched.depositRefundedCents
        + matched.feeSupplementReceivedCents - matched.feeSupplementRefundedCents;
      if (net < matched.agencyFeeCents) {
        errors.push(`成交报名费用未结清：还差 ${((matched.agencyFeeCents - net) / 100).toFixed(2)} 元`);
      } else if (net > matched.agencyFeeCents) {
        errors.push(`成交报名多收 ${((net - matched.agencyFeeCents) / 100).toFixed(2)} 元，须先退款`);
      }
    }
    const othersToClose: number[] = [];
    for (const app of apps) {
      if (app.id === matched.id) continue;
      const net = app.depositReceivedCents - app.depositRefundedCents
        + app.feeSupplementReceivedCents - app.feeSupplementRefundedCents;
      if (net !== 0) {
        errors.push(`报名 ${app.applicationNo}（${app.teacherName}）存在未退清款项 ${(net / 100).toFixed(2)} 元`);
      } else if (ACTIVE_APPLICATION_STATUSES.includes(app.status)) {
        othersToClose.push(app.id);
      }
    }
    if (errors.length > 0) {
      throw conflict('COMPLETION_BLOCKED', `无法完成订单：${errors.join('；')}`);
    }
    for (const appId of othersToClose) {
      this.deps.db
        .prepare('UPDATE applications SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run('order_closed', now, appId);
    }
    this.updateOrderRow(
      order.id,
      { status: 'completed', completedAt: now, matchedApplicationId: order.currentApplicationId },
      now,
    );
    return {
      order: this.getOrder(order.id),
      changedApplications: othersToClose.length,
      message: '订单已完成：合作确认、费用结清。后续课程管理不在本系统范围。',
    };
  }

  private updateOrderRow(id: number, fields: Record<string, unknown>, now: string): void {
    const columnByField: Record<string, string> = {
      status: 'status',
      pausedFromStatus: 'paused_from_status',
      currentApplicationId: 'current_application_id',
      matchedApplicationId: 'matched_application_id',
      completedAt: 'completed_at',
      cancelledAt: 'cancelled_at',
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

  private assertStatus(order: OrderRecord, allowed: OrderStatus[], actionLabel: string): void {
    if (!allowed.includes(order.status)) {
      throw conflict('STATE_CONFLICT', `当前状态不允许该操作（${actionLabel}需状态：${allowed.join('/')}，当前：${order.status}）`);
    }
  }

  private assertNotStatus(order: OrderRecord, forbidden: OrderStatus[], actionLabel: string): void {
    if (forbidden.includes(order.status)) {
      throw conflict('STATE_CONFLICT', `订单已${order.status === 'completed' ? '完成' : '取消'}，不能${actionLabel}`);
    }
  }

  private assertNotCurrentRef(order: OrderRecord, actionLabel: string): void {
    if (order.currentApplicationId !== null) {
      throw conflict(
        'CURRENT_EXISTS',
        `存在当前试课/待结算老师，不能${actionLabel}。请先处理当前老师（完成、退出或取消整单）`,
      );
    }
  }

  dashboard(): {
    statusCounts: Record<string, number>;
    pendingRefund: { count: number; cents: number };
    pendingSupplement: { count: number; cents: number };
    totals: { orders: number; applications: number };
  } {
    const statusCounts: Record<string, number> = {};
    const rows = this.deps.db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all() as Row[];
    for (const r of rows) statusCounts[r.status as string] = r.c;
    const pendingRefund = { count: 0, cents: 0 };
    const pendingSupplement = { count: 0, cents: 0 };
    const allOrders = this.deps.db.prepare('SELECT * FROM orders').all() as Row[];
    for (const row of allOrders) {
      const order = rowToOrder(row);
      for (const app of this.deps.repo.listApplicationsOfOrder(order.id)) {
        const fin = computeFinanceState(app, financeContextFor(app.status, order.status, app.id === order.currentApplicationId));
        if (order.status !== 'completed' && fin.pendingRefundCents > 0) { pendingRefund.count++; pendingRefund.cents += fin.pendingRefundCents; }
        if (order.status === 'reviewing' && app.id === order.currentApplicationId && (fin.pendingSupplementCents ?? 0) > 0) { pendingSupplement.count++; pendingSupplement.cents += fin.pendingSupplementCents!; }
      }
    }
    return {
      statusCounts,
      pendingRefund,
      pendingSupplement,
      totals: {
        orders: this.deps.repo.countOrders(),
        applications: this.deps.repo.countApplications(),
      },
    };
  }
}
