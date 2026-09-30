import type { FinanceState, ApplicationStatus, OrderStatus } from './types.js';

// 费用算法：D=保证金实收−实退；S=补款实收−实退；F=应收中介费；N=D+S。
// context:
//  - holding   当前报名、持有保证金阶段（待试课/试课中/通过待确认），只显示待收保证金/超收
//  - settling  已确认合作（试课通过+确认 或 直接合作），显示待补/待退/结清
//  - closing   报名已终止（失败/退出/订单已结束）或订单已取消，应退清 N
export type FinanceContext = 'holding' | 'settling' | 'closing';

export interface FinanceInput {
  agencyFeeCents: number | null;
  depositDueCents: number | null;
  depositReceivedCents: number;
  depositRefundedCents: number;
  feeSupplementReceivedCents: number;
  feeSupplementRefundedCents: number;
}

export function computeFinanceState(input: FinanceInput, context: FinanceContext): FinanceState {
  const depositNet = input.depositReceivedCents - input.depositRefundedCents;
  const supplementNet = input.feeSupplementReceivedCents - input.feeSupplementRefundedCents;
  const net = depositNet + supplementNet;
  const F = input.agencyFeeCents;

  let pendingDeposit: number | null = null;
  let pendingSupplement: number | null = null;
  let pendingRefund = 0;
  let settled = false;

  if (context === 'holding') {
    pendingDeposit =
      input.depositDueCents !== null ? Math.max(input.depositDueCents - depositNet, 0) : null;
    if (F !== null) pendingRefund = Math.max(net - F, 0); // 下调费用后的合法超收待退
  } else if (context === 'settling') {
    if (F !== null) {
      pendingSupplement = Math.max(F - net, 0);
      pendingRefund = Math.max(net - F, 0);
      settled = net === F;
    }
  } else {
    pendingRefund = net;
    settled = net === 0;
  }

  return {
    agencyFeeCents: F,
    depositDueCents: input.depositDueCents,
    depositReceivedCents: input.depositReceivedCents,
    depositRefundedCents: input.depositRefundedCents,
    feeSupplementReceivedCents: input.feeSupplementReceivedCents,
    feeSupplementRefundedCents: input.feeSupplementRefundedCents,
    depositNetCents: depositNet,
    supplementNetCents: supplementNet,
    netReceivedCents: net,
    pendingDepositCents: pendingDeposit,
    pendingSupplementCents: pendingSupplement,
    pendingRefundCents: pendingRefund,
    settled,
  };
}

/** 依据订单与报名状态推导财务展示上下文 */
export function financeContextFor(
  applicationStatus: ApplicationStatus,
  orderStatus: OrderStatus,
  isCurrent: boolean,
): FinanceContext {
  if (orderStatus === 'cancelled') return 'closing';
  if (
    applicationStatus === 'trial_failed' ||
    applicationStatus === 'withdrawn' ||
    applicationStatus === 'order_closed'
  ) {
    return 'closing';
  }
  if (applicationStatus === 'trial_passed' || applicationStatus === 'direct_cooperation') {
    return 'settling';
  }
  if (isCurrent) return 'holding';
  // 非当前且未终止（submitted/recommended）：无资金往来
  return 'holding';
}
