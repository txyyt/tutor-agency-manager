// 90天清理：到期条件 updated_at <= now-90天；保护在办订单、未结清费用、被引用报名。
// 整单清理要求完成/取消 + 全部关联报名到期 + 财务清结；失败/退出报名可独立清理。
import type { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, type ApplicationRecord, type OrderRecord } from '../../shared/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
import type { Clock } from '../clock.js';
import { rowToApplication, rowToOrder, type Repository } from '../repository.js';
import { tx } from '../transaction.js';
import type { ActiveData } from '../activeData.js';
import type { BackupService } from './backupService.js';
import type { MaintenanceMutex } from '../locks.js';

export interface CleanupCandidate {
  type: 'order' | 'application';
  id: number;
  no: string;
  reason: string;
  updatedAt: string;
  attachmentCount: number;
}

export interface ProtectedItem {
  type: 'order' | 'application';
  id: number;
  no: string;
  reason: string;
  updatedAt: string;
}

export interface CleanupPreview {
  cutoffIso: string;
  candidates: CleanupCandidate[];
  protectedItems: ProtectedItem[];
  hasCandidates: boolean;
}

export interface CleanupRunResult {
  ran: boolean;
  deletedOrders: number;
  deletedApplications: number;
  deletedAttachments: number;
  failedAttachmentDeletes: number;
  backupId: string | null;
  skippedReason: string | null;
  errors: string[];
}

export class CleanupService {
  constructor(
    private deps: {
      db: DatabaseSync;
      repo: Repository;
      clock: Clock;
      active: ActiveData;
      backup: BackupService;
      maintenance: MaintenanceMutex;
      onUpdate: () => void;
    },
  ) {}

  private cutoffIso(): string {
    return new Date(new Date(this.deps.clock.iso()).getTime() - LIMITS.cleanupDays * 24 * 3600 * 1000).toISOString();
  }

  private netOf(app: ApplicationRecord): number {
    return (
      app.depositReceivedCents - app.depositRefundedCents +
      app.feeSupplementReceivedCents - app.feeSupplementRefundedCents
    );
  }

  private wholeOrderDeletable(
    order: OrderRecord,
    apps: ApplicationRecord[],
    cutoff: string,
  ): { ok: boolean; reason?: string } {
    if (order.status !== 'completed' && order.status !== 'cancelled') {
      return { ok: false, reason: `在办订单（${order.status}）始终保护，不参与90天清理` };
    }
    if (order.updatedAt > cutoff) {
      return { ok: false, reason: order.status === 'completed' ? '已完成，最后修改未满90天' : '已取消，最后修改未满90天' };
    }
    const notExpired = apps.filter((a) => a.updatedAt > cutoff);
    if (notExpired.length > 0) {
      return { ok: false, reason: `存在未到期的关联报名（如 ${notExpired[0]?.applicationNo}），整单不能删除` };
    }
    for (const a of apps) {
      const net = this.netOf(a);
      if (order.status === 'completed') {
        if (order.matchedApplicationId === a.id) {
          if (a.agencyFeeCents === null) return { ok: false, reason: '成交报名应收中介费未设定，无法确认结清' };
          if (net !== a.agencyFeeCents) return { ok: false, reason: `成交报名 ${a.applicationNo} 费用未结清（应收${(a.agencyFeeCents / 100).toFixed(2)}元，净收${(net / 100).toFixed(2)}元）` };
        } else if (net !== 0) {
          return { ok: false, reason: `报名 ${a.applicationNo} 净收${(net / 100).toFixed(2)}元未退清` };
        }
      } else if (net !== 0) {
        return { ok: false, reason: `已取消订单的报名 ${a.applicationNo} 净收${(net / 100).toFixed(2)}元未退清` };
      }
    }
    return { ok: true };
  }

  private independentDeletable(app: ApplicationRecord, order: OrderRecord, cutoff: string): boolean {
    if (!['trial_failed', 'withdrawn', 'order_closed'].includes(app.status)) return false;
    if (app.updatedAt > cutoff) return false;
    if (this.netOf(app) !== 0) return false; // 有待退款保护
    if (order.currentApplicationId === app.id || order.matchedApplicationId === app.id) return false; // 被当前/成交引用保护
    return true;
  }

  preview(): CleanupPreview {
    const cutoff = this.cutoffIso();
    const candidates: CleanupCandidate[] = [];
    const protectedItems: ProtectedItem[] = [];
    const orders = (this.deps.db.prepare('SELECT * FROM orders ORDER BY updated_at ASC').all() as never as Row[]).map(rowToOrder);
    const wholeOrderIds = new Set<number>();
    for (const order of orders) {
      const apps = this.deps.repo.listApplicationsOfOrder(order.id);
      const check = this.wholeOrderDeletable(order, apps, cutoff);
      if (check.ok) {
        wholeOrderIds.add(order.id);
        candidates.push({
          type: 'order',
          id: order.id,
          no: order.orderNo,
          reason: order.status === 'completed' ? '已完成且全部报名到期、费用结清' : '已取消且全部报名到期、款项退清',
          updatedAt: order.updatedAt,
          attachmentCount: apps.reduce((s, a) => s + a.attachments.length, 0),
        });
      } else {
        protectedItems.push({
          type: 'order',
          id: order.id,
          no: order.orderNo,
          reason: check.reason ?? '受保护',
          updatedAt: order.updatedAt,
        });
        // 在办/受保护订单下满足条件的失败/退出报名可独立清理
        for (const a of apps) {
          if (this.independentDeletable(a, order, cutoff)) {
            candidates.push({
              type: 'application',
              id: a.id,
              no: a.applicationNo,
              reason: `失败/退出/已结束报名：到期、无款项、未被引用（所属订单${order.orderNo}）`,
              updatedAt: a.updatedAt,
              attachmentCount: a.attachments.length,
            });
          }
        }
      }
    }
    // 已到期完成/取消单下未被整单删除覆盖的独立可删报名（如到期单里的失败报名已被整单包含）
    for (const order of orders) {
      if (wholeOrderIds.has(order.id)) continue;
      // 已在上方处理过受保护订单
      void order;
    }
    return {
      cutoffIso: cutoff,
      candidates,
      protectedItems,
      hasCandidates: candidates.length > 0,
    };
  }

  /** 执行清理（自取维护锁）。仅当确有可删数据时生成清理前备份；备份失败则暂缓删除。 */
  async run(): Promise<CleanupRunResult> {
    return this.deps.maintenance.runExclusive(() => this.runLocked());
  }

  /** 内部方法：假定已持锁（供调度器/恢复后清理复用） */
  async runLocked(): Promise<CleanupRunResult> {
    const result: CleanupRunResult = {
      ran: true,
      deletedOrders: 0,
      deletedApplications: 0,
      deletedAttachments: 0,
      failedAttachmentDeletes: 0,
      backupId: null,
      skippedReason: null,
      errors: [],
    };
    const preview = this.preview();
    if (!preview.hasCandidates) {
      result.ran = false;
      result.skippedReason = '没有可清理的数据（未生成清理前备份）';
      return result;
    }
    // 清理前备份：失败则暂缓删除，避免没有恢复点
    try {
      const backup = await this.deps.backup.performBackupLocked('pre-cleanup');
      result.backupId = backup.id;
    } catch (err) {
      result.skippedReason = `清理前备份失败，已暂缓删除：${(err as Error).message}`;
      result.errors.push(result.skippedReason);
      return result;
    }
    // 重新核验后删除（预览后数据可能变化，执行时重新判断）
    const cutoff = this.cutoffIso();
    const deletedAttachmentPaths: string[] = [];
    tx(this.deps.db, () => {
      const orders = (this.deps.db.prepare('SELECT * FROM orders ORDER BY updated_at ASC').all() as never as Row[]).map(rowToOrder);
      for (const order of orders) {
        const apps = this.deps.repo.listApplicationsOfOrder(order.id);
        const check = this.wholeOrderDeletable(order, apps, cutoff);
        if (!check.ok) continue;
        // 事务内：先清引用再删报名及订单，不留半套关系
        this.deps.db
          .prepare('UPDATE orders SET current_application_id = NULL, matched_application_id = NULL WHERE id = ?')
          .run(order.id);
        for (const a of apps) {
          for (const att of a.attachments) deletedAttachmentPaths.push(att.storagePath);
          this.deps.db.prepare('DELETE FROM applications WHERE id = ?').run(a.id);
        }
        this.deps.db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
        result.deletedOrders++;
        result.deletedApplications += apps.length;
      }
      // 独立报名（重新核验）
      const apps = (this.deps.db.prepare('SELECT * FROM applications').all() as never as Row[]).map(rowToApplication);
      for (const a of apps) {
        if (!['trial_failed', 'withdrawn', 'order_closed'].includes(a.status)) continue;
        if (a.updatedAt > cutoff) continue;
        if (this.netOf(a) !== 0) continue;
        const order = this.deps.repo.getOrderById(a.orderId);
        if (!order) continue;
        if (order.currentApplicationId === a.id || order.matchedApplicationId === a.id) continue;
        for (const att of a.attachments) deletedAttachmentPaths.push(att.storagePath);
        this.deps.db.prepare('DELETE FROM applications WHERE id = ?').run(a.id);
        result.deletedApplications++;
      }
    });
    // 事务成功后删附件；失败报告并留给未引用清理重试
    for (const p of deletedAttachmentPaths) {
      const ok = this.deleteAttachmentFileSafely(p);
      if (ok) result.deletedAttachments++;
      else result.failedAttachmentDeletes++;
    }
    this.deps.onUpdate();
    return result;
  }

  /** 路径严格限制在活动代附件目录内，禁止跟随链接删除外部文件 */
  private deleteAttachmentFileSafely(storagePath: string): boolean {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(storagePath)) return false;
      const dir = this.deps.active.attachmentsDir;
      const abs = path.resolve(dir, storagePath);
      if (!abs.startsWith(path.resolve(dir) + path.sep)) return false;
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.isSymbolicLink()) return false;
      fs.unlinkSync(abs);
      return true;
    } catch {
      return false;
    }
  }
}
