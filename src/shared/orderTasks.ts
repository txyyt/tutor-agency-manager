import type { ApplicationRecord, OrderRecord } from './types.js';
import { computeFinanceState, financeContextFor } from './finance.js';
export interface OrderTask { kind: string; label: string; }
export function orderTasks(order: OrderRecord, apps: ApplicationRecord[]): OrderTask[] {
  const tasks: OrderTask[] = [];
  const finances = apps.map(a => ({ a, f: computeFinanceState(a, financeContextFor(a.status, order.status, a.id === order.currentApplicationId)) }));
  const refund = finances.reduce((sum, { f }) => sum + f.pendingRefundCents, 0);
  if (order.status !== 'completed' && refund > 0) tasks.push({ kind: 'refund', label: `待退款 · ${(refund / 100).toFixed(2)}元` });
  const current = finances.find(({ a }) => a.id === order.currentApplicationId);
  if (order.status === 'reviewing' && current) {
    if (current.f.agencyFeeCents === null) tasks.push({ kind: 'payment', label: '待设置中介费' });
    else if ((current.f.pendingSupplementCents ?? 0) > 0) tasks.push({ kind: 'payment', label: `待收中介费 · ${(current.f.pendingSupplementCents! / 100).toFixed(2)}元` });
    else if (!refund) tasks.push({ kind: 'complete', label: '费用已齐，待完成' });
  }
  if (order.status === 'awaiting_trial' && current) {
    if (current.f.agencyFeeCents === null || current.f.depositDueCents === null) tasks.push({ kind: 'deposit', label: '待设置试课费用' });
    else if ((current.f.pendingDepositCents ?? 0) > 0) tasks.push({ kind: 'deposit', label: `待收保证金 · ${(current.f.pendingDepositCents! / 100).toFixed(2)}元` });
    else tasks.push({ kind: 'trial', label: '待开始试课' });
  }
  if (order.status === 'trialing') tasks.push({ kind: 'trial', label: '待反馈试课结果' });
  const submitted = apps.filter(a => a.status === 'submitted').length;
  if (order.status === 'recruiting' && submitted) tasks.push({ kind: 'recommend', label: `待推荐 · ${submitted}人` });
  return tasks;
}
