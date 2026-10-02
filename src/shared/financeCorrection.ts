import type { ApplicationRecord } from './types.js';

export const CORRECTION_FIELD_LABELS = {
  agencyFeeCents: '约定中介费',
  depositDueCents: '约定保证金',
  depositReceivedCents: '已收到的保证金总额',
  depositRefundedCents: '已退回的保证金总额',
  feeSupplementReceivedCents: '保证金以外已收到的中介费总额',
  feeSupplementRefundedCents: '已退回的中介费总额',
} as const;
export type CorrectionField = keyof typeof CORRECTION_FIELD_LABELS;

/** 只更正已有费用/交易。更正归零后仍能依据原始到账时间和历史再次修正。 */
export function correctableFinanceFields(app: ApplicationRecord): Record<CorrectionField, boolean> {
  const fields = {
    agencyFeeCents: app.agencyFeeCents !== null,
    depositDueCents: app.depositDueCents !== null,
    depositReceivedCents: false,
    depositRefundedCents: false,
    feeSupplementReceivedCents: false,
    feeSupplementRefundedCents: false,
  };
  const transactions = [
    ['depositReceivedCents', 'depositReceivedAt', 'receive-deposit'],
    ['depositRefundedCents', 'depositRefundedAt', 'refund-deposit'],
    ['feeSupplementReceivedCents', 'feeSupplementReceivedAt', 'receive-supplement'],
    ['feeSupplementRefundedCents', 'feeSupplementRefundedAt', 'refund-supplement'],
  ] as const;
  for (const [field, time, type] of transactions) {
    fields[field] = app[field] > 0 || app[time] !== null || app.financeOperations.some(op =>
      op.type === type || (op.before[field] ?? 0) > 0 || (op.after[field] ?? 0) > 0,
    );
  }
  return fields;
}
